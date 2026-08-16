import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy.ts";
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from "../../quickhack_shared/http/bounded-request-body.ts";
import {
  QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES,
} from "../../quickhack_shared/http/request-body-policy.mjs";
import {
  apiSandboxOutboundHeaders,
  resolveApiSandboxTarget,
} from "../../quickhack_server/api/developer/api-sandbox.ts";
import { normalizeInternalServerOrigin } from "../../quickhack_shared/core/runtime-config-service.ts";

function mutationRequest(input = {}) {
  const url = input.url || "http://127.0.0.1:3000/api/supplies";
  return new NextRequest(url, {
    method: input.method || "POST",
    headers: {
      host: new URL(url).host,
      ...(input.forwarded === false
        ? {}
        : {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "quickhack.lan:3443",
          }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.contentType === undefined
        ? {}
        : { "content-type": input.contentType }),
    },
    body: input.body === undefined ? "{}" : input.body,
  });
}

let response = proxy(
  mutationRequest({
    origin: "https://quickhack.lan:3443",
    contentType: "application/json; charset=utf-8",
  })
);
assert.equal(response.status, 200, "The canonical HTTPS origin was rejected.");

response = proxy(
  mutationRequest({
    origin: "https://quickhack.lan:9443",
    contentType: "application/json",
  })
);
assert.equal(response.status, 403, "A same-host different-port origin was accepted.");

process.env.QUICKHACK_ALLOWED_ORIGINS = "https://attacker.example";
response = proxy(
  mutationRequest({
    origin: "https://attacker.example",
    contentType: "application/json",
  })
);
delete process.env.QUICKHACK_ALLOWED_ORIGINS;
assert.equal(response.status, 403, "An ambient origin allowlist bypassed the boundary.");

response = proxy(
  mutationRequest({ origin: "null", contentType: "application/json" })
);
assert.equal(response.status, 403, "Origin null was accepted.");

response = proxy(
  mutationRequest({ contentType: "text/plain" })
);
assert.equal(response.status, 415, "A text/plain JSON mutation was accepted.");

response = proxy(
  mutationRequest({ contentType: undefined, body: null, method: "POST" })
);
assert.equal(response.status, 200, "A bodyless POST was incorrectly rejected.");

response = proxy(
  mutationRequest({
    forwarded: false,
    url: "http://127.0.0.1:3001/api/supplies",
    origin: "http://127.0.0.1:3001",
    contentType: "application/json",
  })
);
assert.equal(response.status, 200, "The exact client runtime origin was rejected.");

const exactBody = "x".repeat(QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES);
const exactRequest = new Request("http://127.0.0.1/api/auth/login", {
  method: "POST",
  body: exactBody,
});
assert.equal(
  (await readBoundedRequestText(exactRequest)).length,
  exactBody.length,
  "The bounded reader rejected the exact auth limit."
);

const oversizedRequest = new Request("http://127.0.0.1/api/auth/login", {
  method: "POST",
  body: `${exactBody}x`,
});
await assert.rejects(
  () => readBoundedRequestText(oversizedRequest),
  RequestBodyTooLargeError
);

assert.equal(
  normalizeInternalServerOrigin("http://127.0.0.1:3000"),
  "http://127.0.0.1:3000"
);
for (const invalidOrigin of [
  "https://127.0.0.1:3000",
  "http://example.com:3000",
  "http://user:secret@127.0.0.1:3000",
  "http://127.0.0.1:3000/base",
]) {
  assert.throws(() => normalizeInternalServerOrigin(invalidOrigin));
}

const sandboxTarget = resolveApiSandboxTarget(
  "http://127.0.0.1:3000",
  "/api/runtime?probe=1"
);
assert.equal(
  sandboxTarget.href,
  "http://127.0.0.1:3000/api/runtime?probe=1",
  "The sandbox did not use the fixed loopback destination."
);
const sandboxHeaders = apiSandboxOutboundHeaders({
  internalOrigin: "http://127.0.0.1:3000",
  url: sandboxTarget,
  cookie: "quickhack_session=secret",
  method: "GET",
});
assert.equal(
  sandboxHeaders.cookie,
  "quickhack_session=secret",
  "The authenticated sandbox lost its exact-origin cookie."
);
assert.throws(() =>
  apiSandboxOutboundHeaders({
    internalOrigin: "http://127.0.0.1:3000",
    url: new URL("http://attacker.example/api/runtime"),
    cookie: "quickhack_session=secret",
    method: "GET",
  })
);

console.log("Mutation origin, JSON, bounded body, and sandbox destination boundaries verified.");
