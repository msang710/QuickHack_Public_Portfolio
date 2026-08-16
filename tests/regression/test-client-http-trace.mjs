import {
  appendQuickHackServerTiming,
  copyQuickHackObservabilityHeaders,
  parseQuickHackServerTiming,
} from "@/quickhack_shared/observability/http-trace";
import { createQuickHackObservedFetch } from "@/quickhack_client/observability/client-http-trace";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const parsed = parseQuickHackServerTiming(
  "cache;desc=ignored, qh;dur=12.4, qh-db-sum;dur=8, qh-gateway;dur=3"
);
assert(parsed.qh === 12.4, "QuickHack total timing must be parsed.");
assert(parsed["qh-db-sum"] === 8, "QuickHack DB timing must be parsed.");
assert(!("cache" in parsed), "Unrelated Server-Timing metrics must be ignored.");
assert(
  appendQuickHackServerTiming("qh;dur=12", { "qh-gateway": 4 }) ===
    "qh;dur=12, qh-gateway;dur=4",
  "Gateway timing must append without destroying upstream metrics."
);

const upstreamHeaders = new Headers({
  "x-quickhack-trace-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-quickhack-trace-recorded": "1",
  "server-timing": "qh;dur=12",
  "x-private-header": "must-not-cross-the-proxy",
});
const proxiedHeaders = new Headers();
copyQuickHackObservabilityHeaders(upstreamHeaders, proxiedHeaders, 5.2);
assert(
  proxiedHeaders.get("x-quickhack-trace-id") ===
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "The client proxy must preserve the central Trace ID."
);
assert(
  proxiedHeaders.get("server-timing") === "qh;dur=12, qh-gateway;dur=5",
  "The client proxy must append its gateway duration."
);
assert(
  !proxiedHeaders.has("x-private-header"),
  "The proxy must forward only the observability allowlist."
);

const observations = [];
const clock = [0, 25, 40];
const observedFetch = createQuickHackObservedFetch({
  baseUrl: "http://127.0.0.1:3000/workspace",
  nativeFetch: async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-quickhack-trace-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "x-quickhack-trace-recorded": "1",
        "server-timing": "qh;dur=18, qh-gateway;dur=4",
      },
    }),
  report: (item) => observations.push(item),
  now: () => clock.shift() ?? 40,
  scheduleFallback: () => 1,
  cancelFallback: () => {},
});
const response = await observedFetch("/api/test");
await response.json();
assert(observations.length === 1, "A consumed recorded response must report once.");
assert(observations[0].headerReceivedMs === 25, "Header receive time must be measured.");
assert(observations[0].responseCompleteMs === 40, "Body completion time must be measured.");
assert(observations[0].bodyProcessingMs === 15, "Body processing time must be derived.");
assert(observations[0].gatewayMs === 4, "Gateway timing must be connected to the observation.");

const ignored = [];
const ignoredFetch = createQuickHackObservedFetch({
  baseUrl: "http://127.0.0.1:3000/",
  nativeFetch: async () =>
    new Response(null, {
      status: 204,
      headers: {
        "x-quickhack-trace-id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "x-quickhack-trace-recorded": "1",
      },
    }),
  report: (item) => ignored.push(item),
});
await ignoredFetch("/api/observability/client-traces", { method: "POST" });
assert(ignored.length === 0, "The ingestion endpoint must never observe itself.");

console.log("Client HTTP trace invariants passed.");
