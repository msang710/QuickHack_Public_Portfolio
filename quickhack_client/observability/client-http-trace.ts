import {
  CLIENT_TRACE_OBSERVATION_PATH,
  parseQuickHackServerTiming,
  QUICKHACK_TRACE_ID_HEADER,
  QUICKHACK_TRACE_RECORDED_HEADER,
  SERVER_TIMING_HEADER,
  type ClientHttpTraceObservationInput,
} from "@/quickhack_shared/observability/http-trace";

const BODY_OBSERVATION_FALLBACK_MS = 5_000;
const CLIENT_TRACE_QUEUE_LIMIT = 100;
const CLIENT_TRACE_BATCH_LIMIT = 20;

type ObservationReporter = (item: ClientHttpTraceObservationInput) => void;
type FallbackTimer = ReturnType<typeof setTimeout> | number;

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function observableRequest(input: RequestInfo | URL, baseUrl: string) {
  try {
    const url = new URL(requestUrl(input), baseUrl);
    const base = new URL(baseUrl);

    return (
      url.origin === base.origin &&
      url.pathname.startsWith("/api/") &&
      url.pathname !== CLIENT_TRACE_OBSERVATION_PATH
    );
  } catch {
    return false;
  }
}

function wrapResponseBodyMethods(response: Response, onComplete: () => void) {
  const methodNames = [
    "arrayBuffer",
    "blob",
    "formData",
    "json",
    "text",
  ] as const;
  let wrapped = false;

  for (const name of methodNames) {
    const original = response[name].bind(response) as (
      ...args: never[]
    ) => Promise<unknown>;

    try {
      Object.defineProperty(response, name, {
        configurable: true,
        value: async (...args: never[]) => {
          try {
            return await original(...args);
          } finally {
            onComplete();
          }
        },
      });
      wrapped = true;
    } catch {
      // A non-extensible Response will fall back to header-only observation.
    }
  }

  return wrapped;
}

export function createQuickHackObservedFetch(input: {
  nativeFetch: typeof fetch;
  report: ObservationReporter;
  baseUrl: string;
  now?: () => number;
  scheduleFallback?: (
    work: () => void,
    delayMs: number
  ) => FallbackTimer;
  cancelFallback?: (timer: FallbackTimer) => void;
}): typeof fetch {
  const now = input.now ?? (() => performance.now());
  const scheduleFallback = input.scheduleFallback ?? setTimeout;
  const cancelFallback =
    input.cancelFallback ??
    ((timer: FallbackTimer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  return async (request, init) => {
    if (!observableRequest(request, input.baseUrl)) {
      return input.nativeFetch(request, init);
    }

    const startedAt = now();
    const response = await input.nativeFetch(request, init);
    const headerReceivedMs = Math.max(0, Math.round(now() - startedAt));
    const traceId =
      response.headers.get(QUICKHACK_TRACE_ID_HEADER)?.trim() ?? "";
    const recorded = response.headers.get(QUICKHACK_TRACE_RECORDED_HEADER);

    if (!traceId || recorded !== "1") return response;

    const timing = parseQuickHackServerTiming(
      response.headers.get(SERVER_TIMING_HEADER)
    );
    const baseObservation = {
      traceId,
      responseStatus: response.status,
      headerReceivedMs,
      gatewayMs: timing["qh-gateway"] ?? null,
    };
    let completed = false;
    let fallbackTimer: FallbackTimer | null = null;

    const reportHeaderOnly = () => {
      if (completed) return;
      input.report({
        ...baseObservation,
        responseCompleteMs: null,
        bodyProcessingMs: null,
        observedAt: new Date().toISOString(),
      });
    };
    const reportComplete = () => {
      if (completed) return;
      completed = true;
      if (fallbackTimer !== null) cancelFallback(fallbackTimer);
      const responseCompleteMs = Math.max(0, Math.round(now() - startedAt));

      input.report({
        ...baseObservation,
        responseCompleteMs,
        bodyProcessingMs: Math.max(0, responseCompleteMs - headerReceivedMs),
        observedAt: new Date().toISOString(),
      });
    };
    const noResponseBody =
      requestMethod(request, init) === "HEAD" ||
      response.status === 204 ||
      response.status === 205 ||
      response.body === null;

    if (noResponseBody) {
      reportComplete();
      return response;
    }

    const wrapped = wrapResponseBodyMethods(response, reportComplete);
    fallbackTimer = scheduleFallback(
      reportHeaderOnly,
      wrapped ? BODY_OBSERVATION_FALLBACK_MS : 0
    );
    return response;
  };
}

export function createClientTraceBatcher(nativeFetch: typeof fetch) {
  const queue = new Map<string, ClientHttpTraceObservationInput>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let disposed = false;
  let retryDelayMs = 1_000;

  const schedule = (delayMs = 1_000) => {
    if (flushTimer !== null || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  };

  const enqueue = (item: ClientHttpTraceObservationInput) => {
    const existing = queue.get(item.traceId);

    if (!existing || item.responseCompleteMs !== null) {
      queue.delete(item.traceId);
      queue.set(item.traceId, item);
    }

    while (queue.size > CLIENT_TRACE_QUEUE_LIMIT) {
      const oldest = queue.keys().next().value as string | undefined;
      if (!oldest) break;
      queue.delete(oldest);
    }

    schedule();
  };

  async function flush() {
    if (flushing || queue.size === 0 || disposed) return;
    flushing = true;
    const items = Array.from(queue.values()).slice(0, CLIENT_TRACE_BATCH_LIMIT);
    items.forEach((item) => queue.delete(item.traceId));
    let shouldRetry = false;

    try {
      const response = await nativeFetch(CLIENT_TRACE_OBSERVATION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
        cache: "no-store",
        keepalive: true,
      });

      if (!response.ok) {
        shouldRetry = response.status === 429 || response.status >= 500;
      } else {
        retryDelayMs = 1_000;
      }
    } catch {
      shouldRetry = true;
    }

    if (shouldRetry) {
      for (const item of items) {
        if (!queue.has(item.traceId)) queue.set(item.traceId, item);
      }
      retryDelayMs = Math.min(30_000, retryDelayMs * 2);
    }

    flushing = false;
    if (queue.size > 0) schedule(shouldRetry ? retryDelayMs : 1_000);
  }

  const flushWithBeacon = () => {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;

    while (queue.size > 0) {
      const items = Array.from(queue.values()).slice(0, CLIENT_TRACE_BATCH_LIMIT);
      items.forEach((item) => queue.delete(item.traceId));
      navigator.sendBeacon(
        CLIENT_TRACE_OBSERVATION_PATH,
        new Blob([JSON.stringify({ items })], { type: "application/json" })
      );
    }
  };

  return {
    enqueue,
    flush,
    flushWithBeacon,
    dispose() {
      disposed = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
}
