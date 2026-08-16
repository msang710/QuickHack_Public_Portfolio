import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLIENT_RUNTIME_HOST = "127.0.0.1";
export const CLIENT_RUNTIME_PORT = 3001;

export function clientRuntimePortForArtifact(artifactKind) {
  if (artifactKind === "DEMONSTRATION_CLIENT") return 3001;
  if (artifactKind === "OPERATIONAL_CLIENT") return 3002;
  const error = new TypeError(`Unsupported QuickHack client artifact: ${artifactKind || "empty"}.`);
  error.code = "PACKAGE_ARTIFACT_INVALID";
  throw error;
}

function firstLine(filename) {
  if (!fs.existsSync(filename)) {
    return "";
  }

  return fs.readFileSync(filename, "utf8").split(/\r?\n/, 1)[0].trim();
}

export function normalizeServerUrl(value) {
  let parsed;

  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(`Invalid QuickHack server URL: ${value}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error("QuickHack central server URL must use https://.");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "QuickHack server URL must contain only protocol, host, and port."
    );
  }

  return parsed.origin;
}

export function resolveClientServerUrl(root, localRuntimePort = CLIENT_RUNTIME_PORT, configDirectory = "") {
  const filename = path.join(configDirectory || path.join(root, "config"), "server-url.txt");
  const configured = firstLine(filename);

  if (!configured) {
    throw new Error(
      `QuickHack central server URL was not found. Expected: ${filename}`
    );
  }

  const normalized = normalizeServerUrl(configured);
  const clientUrl = `http://${CLIENT_RUNTIME_HOST}:${localRuntimePort}`;

  if (normalized === clientUrl) {
    throw new Error("The central server URL cannot be the local client runtime URL.");
  }

  return normalized;
}

export function resolveClientCaCertificateFile(root, now = Date.now(), configDirectory = "") {
  const certificateFile = path.join(configDirectory || path.join(root, "config"), "quickhack-ca.pem");

  if (!fs.existsSync(certificateFile)) {
    throw new Error(
      `QuickHack HTTPS CA certificate was not found. Expected: ${certificateFile}`
    );
  }

  try {
    const certificate = new crypto.X509Certificate(
      fs.readFileSync(certificateFile)
    );

    if (new Date(certificate.validTo).getTime() <= now) {
      throw new Error("The QuickHack HTTPS CA certificate has expired.");
    }
  } catch (error) {
    throw new Error(
      `QuickHack HTTPS CA certificate is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return certificateFile;
}
