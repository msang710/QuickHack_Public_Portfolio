import {
  AUTH_SERVER_PROXY_TIMEOUT_MS,
  DEFAULT_SERVER_PROXY_TIMEOUT_MS,
  SERVER_PROXY_ERROR_CODE,
  serverProxyTimeoutMs,
  serverProxyTimeoutPayload,
  serverProxyUnavailablePayload,
} from "../../quickhack_shared/core/server-proxy-policy.ts";
import {
  ServerProxyTimeoutError,
  fetchAndConsumeWithServerProxyTimeout,
} from "../../quickhack_shared/core/server-proxy.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  serverProxyTimeoutMs("/api/auth/logout") ===
    AUTH_SERVER_PROXY_TIMEOUT_MS,
  "Auth routes did not use the 15 second timeout."
);
assert(
  serverProxyTimeoutMs("/api/catalog/sales-offers") ===
    DEFAULT_SERVER_PROXY_TIMEOUT_MS,
  "General routes did not use the 120 second timeout."
);

const readTimeout = serverProxyTimeoutPayload("GET");
assert(
  readTimeout.code === SERVER_PROXY_ERROR_CODE.timeout &&
    readTimeout.retryable &&
    !readTimeout.uncertain,
  "Read timeout recovery metadata is incorrect."
);

const writeTimeout = serverProxyTimeoutPayload("POST");
assert(
  writeTimeout.code === SERVER_PROXY_ERROR_CODE.timeout &&
    !writeTimeout.retryable &&
    writeTimeout.uncertain &&
    writeTimeout.message.includes("자동으로 다시 보내지 않았습니다"),
  "Write timeout uncertainty metadata is incorrect."
);

const unavailable = serverProxyUnavailablePayload("connection refused");
assert(
  unavailable.code === SERVER_PROXY_ERROR_CODE.unavailable &&
    !unavailable.retryable &&
    !unavailable.uncertain,
  "Connection failures were not classified as unavailable."
);

const abortingFetch = ((_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(init.signal.reason),
      { once: true }
    );
  })) ;

await assertRejectsTimeoutBeforeHeaders();
await assertRejectsTimeoutWhileReadingBody();

async function assertRejectsTimeoutBeforeHeaders() {
  try {
    await fetchAndConsumeWithServerProxyTimeout(
      "http://quickhack.invalid/slow",
      {},
      5,
      async (response) => response.text(),
      abortingFetch
    );
    throw new Error("Timed fetch unexpectedly resolved.");
  } catch (error) {
    assert(
      error instanceof ServerProxyTimeoutError && error.timeoutMs === 5,
      "Timed fetch did not surface ServerProxyTimeoutError."
    );
  }
}

async function assertRejectsTimeoutWhileReadingBody() {
  const headerThenStallingFetch = (async (_input, init) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"started":true'));
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(init.signal.reason),
          { once: true }
        );
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    await fetchAndConsumeWithServerProxyTimeout(
      "http://quickhack.invalid/stalled-body",
      {},
      5,
      async (response) => response.text(),
      headerThenStallingFetch
    );
    throw new Error("A response with a stalled body unexpectedly resolved.");
  } catch (error) {
    assert(
      error instanceof ServerProxyTimeoutError && error.timeoutMs === 5,
      "A stalled response body did not surface ServerProxyTimeoutError."
    );
  }
}

const callerController = new AbortController();
const callerAbortPromise = fetchAndConsumeWithServerProxyTimeout(
  "http://quickhack.invalid/cancelled",
  { signal: callerController.signal },
  1_000,
  async (response) => response.text(),
  abortingFetch
);
callerController.abort(new Error("caller cancelled"));

try {
  await callerAbortPromise;
  throw new Error("Caller cancellation unexpectedly resolved.");
} catch (error) {
  assert(
    !(error instanceof ServerProxyTimeoutError),
    "Caller cancellation was misclassified as a timeout."
  );
}

console.log("Server proxy timeout policy verified.");
