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

const previousRole = process.env.QUICKHACK_RUNTIME_ROLE;
const previousServerUrl = process.env.QUICKHACK_SERVER_URL;
const previousFetch = globalThis.fetch;
let forwarded = [];
let successfulLogin = false;
try {
  process.env.QUICKHACK_RUNTIME_ROLE = "client";
  process.env.QUICKHACK_SERVER_URL = "https://quickhack.example:3443";
  globalThis.fetch = async (url, options) => {
    forwarded.push({ url: String(url), method: options.method, body: options.body });
    return new Response(JSON.stringify(successfulLogin ? { ok: true } : { ok: false, code: "LOGIN_INVALID_CREDENTIALS" }), {
      status: successfulLogin ? 200 : 401,
      headers: {
        "content-type": "application/json",
        ...(successfulLogin ? { "set-cookie": "quickhack_session=token; Path=/; HttpOnly; Secure; SameSite=Lax" } : {}),
      },
    });
  };

  response = await proxy(mutationRequest({
    url: "http://127.0.0.1:3001/api/auth/login",
    forwarded: false,
    origin: "http://127.0.0.1:3001",
    contentType: "application/json",
    body: '{"username":"admin","password":"invalid"}',
  }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "LOGIN_INVALID_CREDENTIALS");
  assert.deepEqual(forwarded, [{
    url: "https://quickhack.example:3443/api/auth/login",
    method: "POST",
    body: '{"username":"admin","password":"invalid"}',
  }]);

  response = await proxy(new NextRequest("http://127.0.0.1:3001/api/statistics/dashboard"));
  assert.equal(response.status, 401, "A server API outside auth was not forwarded.");
  assert.equal(forwarded[1].url, "https://quickhack.example:3443/api/statistics/dashboard");

  successfulLogin = true;
  response = await proxy(mutationRequest({
    url: "http://127.0.0.1:3001/api/auth/login",
    forwarded: false,
    origin: "http://127.0.0.1:3001",
    contentType: "application/json",
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /quickhack_session=token/u);
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /; Secure/u);

  response = proxy(new NextRequest("http://127.0.0.1:3001/api/runtime"));
  assert.equal(response.status, 200, "The client runtime endpoint must stay local.");
  response = proxy(new NextRequest("http://127.0.0.1:3001/api/desktop/native"));
  assert.equal(response.status, 200, "The native broker endpoint must stay local.");
  assert.equal(forwarded.length, 3);

  response = proxy(mutationRequest({
    url: "http://127.0.0.1:3001/api/auth/login",
    forwarded: false,
    origin: "https://attacker.example",
    contentType: "application/json",
  }));
  assert.equal(response.status, 403);
  assert.equal(forwarded.length, 3, "A rejected cross-origin request reached the server.");
} finally {
  if (previousRole === undefined) delete process.env.QUICKHACK_RUNTIME_ROLE;
  else process.env.QUICKHACK_RUNTIME_ROLE = previousRole;
  if (previousServerUrl === undefined) delete process.env.QUICKHACK_SERVER_URL;
  else process.env.QUICKHACK_SERVER_URL = previousServerUrl;
  globalThis.fetch = previousFetch;
}

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
