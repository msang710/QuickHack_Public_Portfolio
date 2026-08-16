import fs from "node:fs";
import https from "node:https";
import {
  QUICKHACK_RUNTIME_CONTRACT_VERSION,
  assertClientServerPackagePair,
} from "../quickhack_shared/core/package-runtime-identity.mjs";
import { normalizePublicHttpsOrigin } from "../quickhack_shared/security/transport-security-policy.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const RUNTIME_RESPONSE_KEYS = Object.freeze([
  "artifactKind",
  "deploymentFlavor",
  "instanceId",
  "ok",
  "publicOrigin",
  "role",
  "runtimeContractVersion",
  "serverUrl",
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readCaFile(filename) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw failure("CENTRAL_SERVER_CA_INVALID", "QuickHack central server CA bundle is missing.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024) {
    throw failure("CENTRAL_SERVER_CA_INVALID", "QuickHack central server CA bundle is unsafe.");
  }
  return fs.readFileSync(filename);
}

export function validateCentralServerProbeResponse(input) {
  const expectedOrigin = normalizePublicHttpsOrigin(input.expectedOrigin);
  if (input.statusCode !== 200) {
    throw failure(
      "CENTRAL_SERVER_PROBE_STATUS_INVALID",
      `QuickHack central server health check requires HTTP 200, received ${input.statusCode ?? "unknown"}.`
    );
  }
  const contentType = String(input.contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw failure("CENTRAL_SERVER_PROBE_CONTENT_TYPE_INVALID", "QuickHack central server probe did not return JSON.");
  }
  let payload;
  try {
    payload = JSON.parse(String(input.body ?? ""));
  } catch {
    throw failure("CENTRAL_SERVER_PROBE_PAYLOAD_INVALID", "QuickHack central server probe returned malformed JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw failure("CENTRAL_SERVER_PROBE_PAYLOAD_INVALID", "QuickHack central server probe payload must be an object.");
  }
  if (
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(RUNTIME_RESPONSE_KEYS) ||
    payload.ok !== true ||
    payload.runtimeContractVersion !== QUICKHACK_RUNTIME_CONTRACT_VERSION ||
    payload.role !== "server" ||
    typeof payload.deploymentFlavor !== "string" ||
    typeof payload.artifactKind !== "string" ||
    payload.serverUrl !== "" ||
    payload.instanceId !== "" ||
    typeof payload.publicOrigin !== "string"
  ) {
    throw failure("CENTRAL_SERVER_PROBE_SCHEMA_INVALID", "QuickHack central server runtime contract is invalid.");
  }
  let observedOrigin;
  try {
    observedOrigin = normalizePublicHttpsOrigin(payload.publicOrigin);
  } catch {
    throw failure("CENTRAL_SERVER_PROBE_ORIGIN_INVALID", "QuickHack central server reported an invalid public origin.");
  }
  if (observedOrigin !== expectedOrigin || payload.publicOrigin !== observedOrigin) {
    throw failure("CENTRAL_SERVER_PROBE_ORIGIN_MISMATCH", "QuickHack central server public origin does not match the configured origin.");
  }
  if (input.expectedIdentity) {
    assertClientServerPackagePair(input.expectedIdentity, payload);
  }
  return Object.freeze(payload);
}

export function probeCentralServer(
  serverUrl,
  caCertificateFile,
  timeoutMs = 5000,
  expectedIdentity = null,
  requestImplementation = https.request
) {
  const origin = normalizePublicHttpsOrigin(serverUrl);
  const ca = readCaFile(caCertificateFile);
  return new Promise((resolve, reject) => {
    const request = requestImplementation(
      new URL("/api/runtime", `${origin}/`),
      {
        method: "GET",
        ca,
        rejectUnauthorized: true,
        timeout: timeoutMs,
        headers: { accept: "application/json" },
      },
      (response) => {
        const chunks = [];
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy(
              failure("CENTRAL_SERVER_PROBE_PAYLOAD_TOO_LARGE", "QuickHack central server probe response is too large.")
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(validateCentralServerProbeResponse({
              statusCode: response.statusCode,
              contentType: response.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf8"),
              expectedOrigin: origin,
              expectedIdentity,
            }));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("timeout", () =>
      request.destroy(failure("CENTRAL_SERVER_PROBE_TIMEOUT", "QuickHack central server connection timed out."))
    );
    request.on("error", reject);
    request.end();
  });
}
