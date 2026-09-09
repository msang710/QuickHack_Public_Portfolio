// QuickHack note: 클라이언트 런타임에서 중앙 서버 API로 요청을 프록시하는 공통 함수입니다.
﻿import { NextRequest, NextResponse } from "next/server";
import {
  getRuntimeRole,
  requireRemoteServerUrl,
} from "@/quickhack_shared/core/runtime";
import { isTrustedLoopbackCookieHop } from "@/quickhack_shared/security/transport-security-policy.mjs";
import {
  copyQuickHackObservabilityHeaders,
} from "@/quickhack_shared/observability/http-trace";
import { appendRequestSearchToProxyPath } from "@/quickhack_shared/core/server-proxy-path";
import {
  SERVER_PROXY_ERROR_CODE,
  type ServerProxyErrorCode,
  serverProxyTimeoutMs,
  serverProxyTimeoutPayload,
  serverProxyUnavailablePayload,
} from "@/quickhack_shared/core/server-proxy-policy";

type ProxyOptions = {
  method?: string;
  body?: BodyInit | null;
  contentType?: string | null;
  responseMode?: "buffer" | "stream";
};

export class ServerProxyError extends Error {
  status?: number;
  responseText?: string;
  code?: ServerProxyErrorCode;
  retryable: boolean;
  uncertain: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      responseText?: string;
      code?: ServerProxyErrorCode;
      retryable?: boolean;
      uncertain?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "ServerProxyError";
    this.status = options.status;
    this.responseText = options.responseText;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.uncertain = options.uncertain ?? false;
  }
}

export class ServerProxyTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Central server request timed out after ${timeoutMs}ms.`);
    this.name = "ServerProxyTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function fetchAndConsumeWithServerProxyTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consumeResponse: (response: Response) => Promise<T>,
  fetchImplementation: typeof fetch = fetch
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(callerSignal?.reason);
    }
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      timedOut = true;
      controller.abort(new DOMException("Request timed out.", "TimeoutError"));
    }
  }, timeoutMs);

  try {
    const response = await fetchImplementation(input, {
      ...init,
      signal: controller.signal,
    });
    return await consumeResponse(response);
  } catch (error) {
    if (timedOut) {
      throw new ServerProxyTimeoutError(timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function targetUrl(pathname: string) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${requireRemoteServerUrl()}${normalizedPath}`;
}

function messageFromResponseText(text: string) {
  if (!text.trim()) {
    return "";
  }

  try {
    const payload = JSON.parse(text) as { message?: unknown };
    const message =
      typeof payload.message === "string" ? payload.message.trim() : "";

    if (message) {
      return message;
    }
  } catch {
    // Fall through to the raw text. Some upstream errors are plain text.
  }

  return text.trim().slice(0, 500);
}

export function getServerProxyErrorCode(error: unknown): ServerProxyErrorCode {
  if (error instanceof ServerProxyError) {
    return error.code ?? SERVER_PROXY_ERROR_CODE.upstream;
  }
  return SERVER_PROXY_ERROR_CODE.unavailable;
}

function copySetCookie(
  request: NextRequest,
  source: Response,
  target: NextResponse
) {
  const setCookie = source.headers.get("set-cookie");

  if (setCookie) {
    const trustedLoopbackHop = isTrustedLoopbackCookieHop({
      runtimeRole: getRuntimeRole(),
      remoteOrigin: requireRemoteServerUrl(),
      localOrigin: request.nextUrl.origin,
      hostHeader: request.headers.get("host"),
    });
    const clientRuntimeCookie = trustedLoopbackHop
      ? setCookie.replace(/;\s*Secure\b/gi, "")
      : setCookie;
    target.headers.set("set-cookie", clientRuntimeCookie);
  }
}

export async function fetchServerJson<T>(
  pathname: string,
  cookieHeader?: string
) {
  let consumed: { response: Response; text: string | null; payload: T | null };

  try {
    consumed = await fetchAndConsumeWithServerProxyTimeout(
      targetUrl(pathname),
      {
        headers: cookieHeader ? { cookie: cookieHeader } : undefined,
        cache: "no-store",
      },
      serverProxyTimeoutMs(pathname),
      async (response) =>
        response.ok
          ? {
              response,
              text: null,
              payload: (await response.json()) as T,
            }
          : {
              response,
              text: await response.text(),
              payload: null,
            }
    );
  } catch (error) {
    const payload =
      error instanceof ServerProxyTimeoutError
        ? serverProxyTimeoutPayload("GET")
        : serverProxyUnavailablePayload(
            error instanceof Error ? error.message : ""
          );

    throw new ServerProxyError(payload.code, {
      status:
        payload.code === SERVER_PROXY_ERROR_CODE.timeout ? 504 : 503,
      code: payload.code,
      retryable: payload.retryable,
      uncertain: payload.uncertain,
    });
  }

  const { response, text } = consumed;
  if (!response.ok) {
    const upstreamMessage = messageFromResponseText(text ?? "");
    throw new ServerProxyError(
      upstreamMessage || SERVER_PROXY_ERROR_CODE.upstream,
      {
        status: response.status,
        responseText: text ?? "",
        code: SERVER_PROXY_ERROR_CODE.upstream,
      }
    );
  }

  return consumed.payload as T;
}

export function getRemoteServerOrigin() {
  return new URL(requireRemoteServerUrl()).origin;
}

export async function mutateServerJson<T>(input: {
  pathname: string;
  cookieHeader?: string;
  body: unknown;
  signal?: AbortSignal;
}) {
  let consumed: { response: Response; text: string };
  try {
    consumed = await fetchAndConsumeWithServerProxyTimeout(
      targetUrl(input.pathname),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.cookieHeader ? { cookie: input.cookieHeader } : {}),
        },
        body: JSON.stringify(input.body),
        cache: "no-store",
        signal: input.signal,
      },
      serverProxyTimeoutMs(input.pathname),
      async (response) => ({ response, text: await response.text() })
    );
  } catch (error) {
    const payload =
      error instanceof ServerProxyTimeoutError
        ? serverProxyTimeoutPayload("POST")
        : serverProxyUnavailablePayload(
            error instanceof Error ? error.message : ""
          );
    throw new ServerProxyError(payload.code, {
      status: payload.code === SERVER_PROXY_ERROR_CODE.timeout ? 504 : 503,
      code: payload.code,
      retryable: payload.retryable,
      uncertain: payload.uncertain,
    });
  }

  if (!consumed.response.ok) {
    throw new ServerProxyError(
      messageFromResponseText(consumed.text) ||
        SERVER_PROXY_ERROR_CODE.upstream,
      {
        status: consumed.response.status,
        responseText: consumed.text,
        code: SERVER_PROXY_ERROR_CODE.upstream,
      }
    );
  }
  try {
    return JSON.parse(consumed.text) as T;
  } catch {
    throw new ServerProxyError(SERVER_PROXY_ERROR_CODE.invalidResponse, {
      status: 502,
      code: SERVER_PROXY_ERROR_CODE.invalidResponse,
      responseText: consumed.text.slice(0, 500),
    });
  }
}

export async function proxyToServer(
  request: NextRequest,
  pathname: string,
  options: ProxyOptions = {}
) {
  const proxyStartedAt = performance.now();
  const headers: Record<string, string> = {};
  const cookie = request.headers.get("cookie");

  if (cookie) {
    headers.cookie = cookie;
  }
  headers["x-quickhack-client-family"] = String(process.env.QUICKHACK_CLIENT_FAMILY ?? "BROWSER_DEVELOPMENT");
  headers["x-quickhack-client-version"] = String(process.env.QUICKHACK_CLIENT_VERSION ?? "0.0.0");
  headers["x-quickhack-update-channel"] = String(process.env.QUICKHACK_UPDATE_CHANNEL ?? "development");

  if (options.contentType !== null) {
    headers["content-type"] =
      options.contentType ||
      request.headers.get("content-type") ||
      "application/json";
  }

  let consumed: {
    response: Response;
    responseBody: ArrayBuffer | ReadableStream<Uint8Array> | null;
  };
  const method = options.method || request.method;

  try {
    consumed = await fetchAndConsumeWithServerProxyTimeout(
      targetUrl(
        appendRequestSearchToProxyPath(pathname, request.nextUrl.search)
      ),
      {
        method,
        headers,
        body: options.body,
        cache: "no-store",
        signal: request.signal,
      },
      serverProxyTimeoutMs(pathname),
      async (response) => ({
        response,
        responseBody:
          options.responseMode === "stream"
            ? response.body
            : await response.arrayBuffer(),
      })
    );
  } catch (error) {
    const payload =
      error instanceof ServerProxyTimeoutError
        ? serverProxyTimeoutPayload(method)
        : serverProxyUnavailablePayload(
            error instanceof Error ? error.message : ""
          );

    return NextResponse.json(
      payload,
      {
        status:
          payload.code === SERVER_PROXY_ERROR_CODE.timeout ? 504 : 503,
      }
    );
  }

  const { response, responseBody } = consumed;
  const contentType = response.headers.get("content-type") || "application/json";
  const proxied = new NextResponse(responseBody, {
    status: response.status,
    headers: {
      "content-type": contentType,
    },
  });
  const contentDisposition = response.headers.get("content-disposition");

  if (contentDisposition) {
    proxied.headers.set("content-disposition", contentDisposition);
  }

  copySetCookie(request, response, proxied);
  copyQuickHackObservabilityHeaders(
    response.headers,
    proxied.headers,
    performance.now() - proxyStartedAt
  );

  return proxied;
}

export async function proxyJsonBodyToServer(
  request: NextRequest,
  pathname: string,
  body: unknown
) {
  return proxyToServer(request, pathname, {
    method: request.method,
    body: JSON.stringify(body),
    contentType: "application/json",
  });
}
