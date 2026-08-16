import path from "node:path";
import { normalizePublicHttpsOrigin } from "../quickhack_shared/security/transport-security-policy.mjs";
import { readClientTrustBundleSync } from "./trust-bundle.mjs";

export const CLIENT_RUNTIME_HOST = "127.0.0.1";
export const CLIENT_RUNTIME_PORT = 3001;

export function clientRuntimePortForArtifact(artifactKind) {
  if (artifactKind === "DEMONSTRATION_CLIENT") return 3001;
  if (artifactKind === "OPERATIONAL_CLIENT") return 3002;
  const error = new TypeError(`Unsupported QuickHack client artifact: ${artifactKind || "empty"}.`);
  error.code = "PACKAGE_ARTIFACT_INVALID";
  throw error;
}

export function normalizeServerUrl(value) {
  try {
    return normalizePublicHttpsOrigin(value);
  } catch (error) {
    throw new Error(
      `Invalid QuickHack server URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function resolveClientTrustBundle(root, now = Date.now(), configDirectory = "") {
  const directory = path.resolve(configDirectory || path.join(root, "config"));
  return readClientTrustBundleSync(directory, { now });
}

export function resolveClientServerUrl(root, localRuntimePort = CLIENT_RUNTIME_PORT, configDirectory = "") {
  void localRuntimePort; // Kept for compatibility; an HTTPS origin cannot equal the HTTP loopback runtime.
  return resolveClientTrustBundle(root, Date.now(), configDirectory).origin;
}

export function resolveClientCaCertificateFile(root, now = Date.now(), configDirectory = "") {
  return resolveClientTrustBundle(root, now, configDirectory).paths.combinedCa;
}
