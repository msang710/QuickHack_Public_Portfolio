import assert from "node:assert/strict";
import { QUICKHACK_RUNTIME_CONTRACT_VERSION } from "../../quickhack_shared/core/package-runtime-identity.mjs";
import { validateCentralServerProbeResponse } from "../../tools/client-runtime-probe.mjs";

const origin = "https://quickhack.example:3443";
const validPayload = {
  ok: true,
  runtimeContractVersion: QUICKHACK_RUNTIME_CONTRACT_VERSION,
  role: "server",
  deploymentFlavor: "",
  artifactKind: "",
  publicOrigin: origin,
  serverUrl: "",
  instanceId: "",
};
const validate = (overrides = {}) => validateCentralServerProbeResponse({
  statusCode: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(validPayload),
  expectedOrigin: origin,
  ...overrides,
});

assert.deepEqual(validate(), validPayload);
for (const statusCode of [204, 301, 302, 400, 404, 500]) {
  assert.throws(() => validate({ statusCode }), (error) =>
    error?.code === "CENTRAL_SERVER_PROBE_STATUS_INVALID"
  );
}
assert.throws(() => validate({ contentType: "text/html" }), (error) =>
  error?.code === "CENTRAL_SERVER_PROBE_CONTENT_TYPE_INVALID"
);
for (const body of ["", "{", "[]", "null"]) {
  assert.throws(() => validate({ body }), (error) =>
    ["CENTRAL_SERVER_PROBE_PAYLOAD_INVALID", "CENTRAL_SERVER_PROBE_SCHEMA_INVALID"].includes(error?.code)
  );
}
for (const patch of [
  { ok: "true" },
  { runtimeContractVersion: QUICKHACK_RUNTIME_CONTRACT_VERSION + 1 },
  { role: "client" },
  { serverUrl: origin },
  { instanceId: "server-instance" },
]) {
  assert.throws(
    () => validate({ body: JSON.stringify({ ...validPayload, ...patch }) }),
    (error) => error?.code === "CENTRAL_SERVER_PROBE_SCHEMA_INVALID"
  );
}
assert.throws(
  () => validate({ body: JSON.stringify({ ...validPayload, extra: true }) }),
  (error) => error?.code === "CENTRAL_SERVER_PROBE_SCHEMA_INVALID"
);
for (const publicOrigin of [
  "https://other.example:3443",
  "http://quickhack.example:3443",
  "https://quickhack.example:3443/path",
]) {
  assert.throws(
    () => validate({ body: JSON.stringify({ ...validPayload, publicOrigin }) }),
    (error) => ["CENTRAL_SERVER_PROBE_ORIGIN_INVALID", "CENTRAL_SERVER_PROBE_ORIGIN_MISMATCH"].includes(error?.code)
  );
}

console.log("Strict central server probe contract verified.");
