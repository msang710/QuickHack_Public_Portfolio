import { ordersPerMinute, validateLoadProfile } from "./profile.mjs";

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function summarizeLoadRun(profileInput, phaseId, events, oracle = null, runResult = null) {
  const profile = validateLoadProfile(profileInput);
  const phase = profile.phases.find((item) => item.id === phaseId);
  if (!phase) throw new TypeError("Unknown load phase.");
  const requests = events.filter((event) => event.type === "request" && event.phaseId === phaseId);
  const measuredRequests = requests.filter((event) => !event.expectedDuplicate);
  const arrivals = events.filter((event) => event.type === "arrival" && event.phaseId === phaseId);
  const resources = events.filter((event) => event.type === "resource");
  const resourceErrors = events.filter((event) => event.type === "resource-error");
  const deadlockDelta = resources.length > 1
    ? Number(resources.at(-1).database?.deadlocks ?? 0) - Number(resources[0].database?.deadlocks ?? 0)
    : null;
  const byRoute = {};
  let unexpectedFailures = 0;
  let traceMissing = 0;
  let duplicateViolations = 0;
  for (const request of requests) {
    if (request.expectedDuplicate) {
      if (!request.duplicateRejected) duplicateViolations += 1;
      if (!request.traceId) traceMissing += 1;
      continue;
    }
    const bucket = byRoute[request.route] ??= { count: 0, success: 0, failure: 0, timeout: 0, latencyMs: [] };
    bucket.count += 1;
    if (request.outcome === "SUCCESS") { bucket.success += 1; bucket.latencyMs.push(request.durationMs); }
    else if (request.outcome === "TIMEOUT") bucket.timeout += 1;
    else bucket.failure += 1;
    if (request.outcome !== "SUCCESS" || request.status >= 500 || (request.method === "POST" && request.businessCode !== "MATCH")) unexpectedFailures += 1;
    if (!request.traceId) traceMissing += 1;
  }
  const routes = Object.fromEntries(Object.entries(byRoute).map(([route, bucket]) => [route, {
    count: bucket.count, success: bucket.success, failure: bucket.failure, timeout: bucket.timeout,
    p50Ms: percentile(bucket.latencyMs, 0.5), p95Ms: percentile(bucket.latencyMs, 0.95),
    p99Ms: percentile(bucket.latencyMs, 0.99), maxMs: bucket.latencyMs.length ? bucket.latencyMs.reduce((max, value) => Math.max(max, value), 0) : null,
  }]));
  const read = measuredRequests.filter((event) => event.method === "GET" && event.outcome === "SUCCESS").map((event) => event.durationMs);
  const write = measuredRequests.filter((event) => event.method !== "GET" && event.outcome === "SUCCESS" && event.businessCode === "MATCH").map((event) => event.durationMs);
  const scheduledArrivals = arrivals.length;
  const appendedArrivals = arrivals.filter((event) => event.outcome === "APPENDED").length;
  const expectedArrivals = Math.floor(ordersPerMinute(profile, phase.orderMultiplier) * phase.durationSeconds / 60);
  const arrivalCoverage = expectedArrivals ? appendedArrivals / expectedArrivals : null;
  const readP95Ms = percentile(read, 0.95);
  const writeP95Ms = percentile(write, 0.95);
  const metricPass = readP95Ms !== null && writeP95Ms !== null &&
    readP95Ms <= profile.criteria.readP95Ms && writeP95Ms <= profile.criteria.writeP95Ms &&
    unexpectedFailures <= profile.criteria.unexpectedFailureCount && traceMissing === 0 && duplicateViolations === 0 &&
    resources.length > 0 && resourceErrors.length === 0 && (deadlockDelta === null || deadlockDelta === 0);
  const commitMatched = !runResult || oracle?.findings?.packedActiveCount === runResult.nextPack;
  const loadMet = scheduledArrivals >= expectedArrivals && appendedArrivals >= expectedArrivals * 0.99;
  const verdict = !loadMet || !oracle || oracle.verdict === "INCONCLUSIVE" ? "INCONCLUSIVE"
    : oracle.verdict === "FAIL" || !commitMatched || (phase.scored && !metricPass) ? "FAIL" : "PASS";
  return {
    schema: "quickhack-load-report/v1", runId: profile.runId, phaseId, scored: phase.scored,
    targetOrdersPerMinute: ordersPerMinute(profile, phase.orderMultiplier), expectedArrivals,
    scheduledArrivals, appendedArrivals, arrivalCoverage,
    requestCount: measuredRequests.length, duplicateAttempts: requests.length - measuredRequests.length, duplicateViolations, unexpectedFailures, traceMissing,
    resourceSampleCount: resources.length, resourceErrorCount: resourceErrors.length, deadlockDelta,
    readP95Ms, writeP95Ms, commitMatched, routes, oracle, verdict,
  };
}
