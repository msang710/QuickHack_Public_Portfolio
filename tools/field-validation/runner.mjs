import { performance } from "node:perf_hooks";
import { scenarioFixture } from "./manifest.mjs";
import { compareBusinessState } from "./oracle.mjs";
import { summarizeRun } from "./report.mjs";

function loopbackBaseUrl(value) {
  const url = new URL(value);
  if (!(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) || url.username || url.password) {
    throw new TypeError("Field validation HTTP destination must be loopback without credentials.");
  }
  return url;
}

function localUrl(base, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Scenario paths must be absolute local paths.");
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new TypeError("Scenario path escaped the loopback origin.");
  return url;
}

async function requestJson(base, action, timeoutMs, fetchImpl, cookie) {
  const started = performance.now();
  const method = String(action.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new TypeError("Only GET and POST scenario actions are supported.");
  try {
    const response = await fetchImpl(localUrl(base, action.path), {
      method,
      redirect: "error",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-quickhack-validation-run-id": action.runId, "x-quickhack-validation-scenario-id": action.scenarioId, ...(cookie ? { Cookie: cookie } : {}) },
      body: method === "POST" ? JSON.stringify(action.body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* A malformed response is still recorded. */ }
    const actualCode = payload?.data?.code ?? payload?.code ?? null;
    const codeMatches = action.expectedCode === undefined || actualCode === action.expectedCode;
    return {
      id: action.id,
      outcome: response.ok && (text === "" || payload !== null) && codeMatches ? "SUCCESS" : "FAILED",
      status: response.status,
      businessCodeMatched: action.expectedCode === undefined ? null : codeMatches,
      durationMs: Math.round(performance.now() - started),
      traceId: response.headers.get("x-quickhack-trace-id"),
      evidenceClass: "MOCK",
      payload,
    };
  } catch (error) {
    return {
      id: action.id,
      outcome: error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT" : "FAILED",
      status: null,
      durationMs: Math.round(performance.now() - started),
      traceId: null,
      evidenceClass: "MOCK",
      payload: null,
    };
  }
}

export async function runHttpScenario({ manifest, baseUrl, actions, snapshotPath, expectedState, timeoutMs = 10_000, cookie, fetchImpl = fetch }) {
  const base = loopbackBaseUrl(baseUrl);
  if (!Array.isArray(actions) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Invalid field validation actions or timeout.");
  }
  if (cookie !== undefined && (typeof cookie !== "string" || /[\r\n]/.test(cookie) || cookie.length > 4096)) {
    throw new TypeError("Invalid ephemeral session cookie.");
  }
  const requests = [];
  for (const action of actions) {
    requests.push(await requestJson(base, { ...action, runId: manifest.runId, scenarioId: manifest.scenarioId }, timeoutMs, fetchImpl, cookie));
  }
  const snapshot = await requestJson(base, { id: "snapshot", method: "GET", path: snapshotPath, runId: manifest.runId, scenarioId: manifest.scenarioId }, timeoutMs, fetchImpl, cookie);
  const oracle = snapshot.outcome === "SUCCESS"
    ? compareBusinessState(expectedState, snapshot.payload)
    : { ok: false, mismatches: [{ path: "$snapshot", expected: "readable", actual: snapshot.outcome }] };
  const report = summarizeRun({
    manifest,
    requests,
    oracle,
    access: [
      { provider: "DELIVERYAPI", status: "NOT_RUN" },
      { provider: "CAFE24", status: "NOT_RUN" },
      { provider: "ANDROID_DEVICE", status: "NOT_RUN" },
      { provider: "NETWORK_RTT", status: "NOT_RUN" },
    ],
  });
  return { ...report, snapshotStatus: snapshot.outcome, requests: requests.map(({ payload, ...rest }) => rest) };
}

export function materializeScenario(scenario, manifest) {
  const fixture = scenarioFixture(manifest);
  const variables = { "{{PG_NO}}": fixture.pgNo, "{{ORDER_ID}}": fixture.orderId };
  function substitute(value) {
    if (typeof value === "string") {
      return value.replace(/\{\{(?:PG_NO|ORDER_ID)\}\}/g, (match) => variables[match]);
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
    }
    return value;
  }
  return substitute(scenario);
}
