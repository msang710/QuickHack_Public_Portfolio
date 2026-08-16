export const QUICKHACK_TRACE_ID_HEADER = "x-quickhack-trace-id";
export const QUICKHACK_TRACE_RECORDED_HEADER = "x-quickhack-trace-recorded";
export const SERVER_TIMING_HEADER = "server-timing";
export const CLIENT_TRACE_OBSERVATION_PATH =
  "/api/observability/client-traces";

export const QUICKHACK_SERVER_TIMING_NAMES = [
  "qh",
  "qh-auth",
  "qh-service",
  "qh-db-sum",
  "qh-db-max",
  "qh-tx-enter",
  "qh-tx-run",
  "qh-gateway",
] as const;

export type QuickHackServerTimingName =
  (typeof QUICKHACK_SERVER_TIMING_NAMES)[number];

export type QuickHackServerTiming = Partial<
  Record<QuickHackServerTimingName, number>
>;

export type ClientHttpTraceObservationInput = {
  traceId: string;
  responseStatus: number;
  headerReceivedMs: number;
  responseCompleteMs: number | null;
  bodyProcessingMs: number | null;
  gatewayMs: number | null;
  observedAt: string;
};

const QUICKHACK_TIMING_NAME_SET = new Set<string>(
  QUICKHACK_SERVER_TIMING_NAMES
);

function finiteDuration(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(600_000, Math.round(parsed * 10) / 10);
}

export function formatQuickHackServerTiming(
  timing: QuickHackServerTiming
) {
  return QUICKHACK_SERVER_TIMING_NAMES.flatMap((name) => {
    const duration = finiteDuration(timing[name]);
    return duration === null ? [] : [`${name};dur=${duration}`];
  }).join(", ");
}

export function parseQuickHackServerTiming(
  value: string | null | undefined
): QuickHackServerTiming {
  const parsed: QuickHackServerTiming = {};

  for (const entry of String(value ?? "").split(",")) {
    const parts = entry
      .trim()
      .split(";")
      .map((part) => part.trim());
    const name = parts.shift() ?? "";

    if (!QUICKHACK_TIMING_NAME_SET.has(name)) continue;
    const durationPart = parts.find((part) => /^dur\s*=/i.test(part));

    if (!durationPart) continue;
    const duration = finiteDuration(durationPart.slice(durationPart.indexOf("=") + 1));

    if (duration !== null) {
      parsed[name as QuickHackServerTimingName] = duration;
    }
  }

  return parsed;
}

export function appendQuickHackServerTiming(
  currentValue: string | null | undefined,
  timing: QuickHackServerTiming
) {
  const appended = formatQuickHackServerTiming(timing);

  if (!appended) return String(currentValue ?? "").trim();
  const current = String(currentValue ?? "").trim();
  return current ? `${current}, ${appended}` : appended;
}

export function copyQuickHackObservabilityHeaders(
  source: Headers,
  target: Headers,
  gatewayMs: number
) {
  const traceId = source.get(QUICKHACK_TRACE_ID_HEADER);

  if (!traceId) return;
  target.set(QUICKHACK_TRACE_ID_HEADER, traceId);

  const recorded = source.get(QUICKHACK_TRACE_RECORDED_HEADER);
  if (recorded) target.set(QUICKHACK_TRACE_RECORDED_HEADER, recorded);

  target.set(
    SERVER_TIMING_HEADER,
    appendQuickHackServerTiming(source.get(SERVER_TIMING_HEADER), {
      "qh-gateway": Math.max(0, Math.round(gatewayMs)),
    })
  );
}
