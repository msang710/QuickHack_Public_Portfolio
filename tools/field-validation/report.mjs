const VALID_CLASSES = new Set(["MOCK", "PROVIDER", "DEVICE", "PHYSICAL"]);
const VALID_OUTCOMES = new Set(["SUCCESS", "FAILED", "TIMEOUT", "UNCERTAIN", "NOT_RUN"]);

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function summarizeRun({ manifest, requests = [], oracle = null, access = [], network = [] }) {
  if (!manifest?.runId) throw new TypeError("A run manifest is required.");
  const evidence = {};
  const durations = [];
  let timeoutCount = 0;
  let uncertainCount = 0;
  let traceMissingCount = 0;
  let failureCount = 0;
  for (const request of requests) {
    if (!VALID_CLASSES.has(request.evidenceClass) || !VALID_OUTCOMES.has(request.outcome)) {
      throw new TypeError("Invalid request evidence class or outcome.");
    }
    const bucket = evidence[request.evidenceClass] ??= { sampleSize: 0, failures: 0, timeouts: 0 };
    bucket.sampleSize += 1;
    if (request.outcome === "TIMEOUT") { timeoutCount += 1; bucket.timeouts += 1; }
    if (request.outcome === "UNCERTAIN") uncertainCount += 1;
    if (request.outcome === "FAILED" || request.outcome === "UNCERTAIN") { failureCount += 1; bucket.failures += 1; }
    if (!request.traceId) traceMissingCount += 1;
    if (Number.isFinite(request.durationMs) && request.durationMs >= 0) durations.push(request.durationMs);
  }
  durations.sort((a, b) => a - b);
  const networkBySegment = {};
  for (const sample of network) {
    if (!["client", "external"].includes(sample.segment) || !Number.isFinite(sample.measuredRttMs) || sample.measuredRttMs < 0) {
      throw new TypeError("Invalid network observation.");
    }
    const bucket = networkBySegment[sample.segment] ??= { configuredDelayMs: sample.configuredDelayMs, measured: [] };
    if (bucket.configuredDelayMs !== sample.configuredDelayMs) throw new TypeError("Mixed configured delays in one segment.");
    bucket.measured.push(sample.measuredRttMs);
  }
  const networkReport = Object.fromEntries(Object.entries(networkBySegment).map(([segment, bucket]) => {
    bucket.measured.sort((a, b) => a - b);
    return [segment, {
      configuredDelayMs: bucket.configuredDelayMs,
      sampleSize: bucket.measured.length,
      measuredP50RttMs: percentile(bucket.measured, 0.5),
      measuredP95RttMs: percentile(bucket.measured, 0.95),
    }];
  }));
  const notRun = access.filter((item) => item.status !== "AVAILABLE");
  const verdict = oracle?.ok === false || failureCount || timeoutCount
    ? "FAIL"
    : requests.length === 0
      ? "NOT_RUN"
      : oracle?.ok !== true || notRun.length || traceMissingCount
        ? "INCONCLUSIVE"
        : "PASS";
  return {
    schema: "quickhack-field-validation-report/v1",
    manifest,
    sampleSize: requests.length,
    measuredSampleSize: durations.length,
    failureCount,
    timeoutCount,
    uncertainCount,
    errorRate: requests.length ? (failureCount + timeoutCount) / requests.length : null,
    traceMissingCount,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? null,
    evidence,
    network: networkReport,
    oracle,
    access,
    verdict,
  };
}
