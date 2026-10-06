import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

export function createEventWriter(path) {
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  let closed = false;
  let streamError = null;
  stream.on("error", (error) => { streamError = error; });
  return {
    async write(event) {
      if (closed) throw new Error("Load event writer is closed.");
      if (streamError) throw streamError;
      if (!stream.write(`${JSON.stringify(event)}\n`)) await once(stream, "drain");
      if (streamError) throw streamError;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (streamError) throw streamError;
      stream.end();
      await once(stream, "finish");
      if (streamError) throw streamError;
    },
  };
}

function serverTiming(value) {
  const timing = {};
  for (const entry of String(value ?? "").split(",")) {
    const match = /^\s*([a-z0-9-]+)\s*;\s*dur\s*=\s*([\d.]+)/i.exec(entry);
    if (match && Number.isFinite(Number(match[2]))) timing[match[1]] = Number(match[2]);
  }
  return timing;
}

export async function measuredRequest({ baseUrl, path, method = "GET", body, credential, phaseId, runId, worker, businessId, attempt = 1, timeoutMs = 30_000, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  const target = new URL(path, base);
  if (target.origin !== base.origin || !path.startsWith("/") || path.startsWith("//")) throw new TypeError("Load request must remain on the configured target origin.");
  const started = performance.now();
  const startedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(target, {
      method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(credential ? { cookie: `quickhack_session=${credential.sessionToken}` } : {}),
        ...(runId ? { "x-quickhack-validation-run-id": runId, "x-quickhack-validation-scenario-id": phaseId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const headersMs = Math.round(performance.now() - started);
    const responseText = await response.text();
    let payload = null;
    try { payload = responseText ? JSON.parse(responseText) : null; } catch { /* Invalid JSON is classified below. */ }
    const durationMs = Math.round(performance.now() - started);
    return {
      type: "request", phaseId, worker, businessId, attempt, method, route: target.pathname,
      startedAt, headersMs, durationMs, status: response.status,
      outcome: response.ok && (responseText === "" || payload !== null) && payload?.ok !== false ? "SUCCESS" : "FAILED",
      businessCode: payload?.data?.code ?? payload?.code ?? null,
      traceId: response.headers.get("x-quickhack-trace-id"),
      traceRecorded: response.headers.get("x-quickhack-trace-recorded") === "1",
      serverTiming: serverTiming(response.headers.get("server-timing")),
      responseBytes: Buffer.byteLength(responseText),
    };
  } catch (error) {
    return {
      type: "request", phaseId, worker, businessId, attempt, method, route: target.pathname,
      startedAt, headersMs: null, durationMs: Math.round(performance.now() - started), status: null,
      outcome: error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT" : "FAILED",
      errorCode: error?.name ?? "ERROR", businessCode: null, traceId: null, traceRecorded: false,
      serverTiming: {}, responseBytes: 0,
    };
  }
}
