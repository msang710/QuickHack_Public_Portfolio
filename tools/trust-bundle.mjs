import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizePublicHttpsOrigin } from "../quickhack_shared/security/transport-security-policy.mjs";

export const TRUST_BUNDLE_VERSION = 1;
export const TRUST_BUNDLE_FILENAMES = Object.freeze({
  manifest: "trust-bundle.json",
  serverUrl: "server-url.txt",
  currentCa: "quickhack-ca.pem",
  previousCa: "quickhack-previous-ca.pem",
  combinedCa: "quickhack-ca-bundle.pem",
  readme: "README.txt",
});

const MAX_FILE_BYTES = 128 * 1024;
const BASE_MANIFEST_KEYS = Object.freeze([
  "currentCaSha256",
  "generatedAt",
  "origin",
  "version",
]);
const ROTATION_MANIFEST_KEYS = Object.freeze([
  ...BASE_MANIFEST_KEYS,
  "previousCaSha256",
  "rotationNotBefore",
].sort());
const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;

function invalid(message, code = "TRUST_BUNDLE_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw invalid(`${label} has unknown or missing fields.`);
  }
}

function regularFile(filename, required = true) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    if (!required) return null;
    throw invalid(`Trust bundle file is missing: ${filename}`, "TRUST_BUNDLE_INCOMPLETE");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    throw invalid(`Trust bundle file is not a bounded regular file: ${filename}`);
  }
  return stat;
}

function boundedText(filename, required = true) {
  const stat = regularFile(filename, required);
  return stat ? fs.readFileSync(filename, "utf8").replace(/^\uFEFF/u, "") : "";
}

function parseIsoTimestamp(value, label) {
  const text = String(value ?? "").trim();
  const time = Date.parse(text);
  if (!text || !Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw invalid(`${label} must be a canonical ISO timestamp.`);
  }
  return { text, time };
}

function parseCertificateList(pem, label) {
  const matches = String(pem ?? "").match(CERTIFICATE_PATTERN) ?? [];
  const residue = String(pem ?? "").replace(CERTIFICATE_PATTERN, "").trim();
  if (matches.length === 0 || residue) {
    throw invalid(`${label} is not a PEM certificate list.`);
  }
  try {
    return matches.map((value) => new crypto.X509Certificate(value));
  } catch (error) {
    throw invalid(`${label} contains an invalid certificate: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function certificateSha256(certificate) {
  const value = certificate instanceof crypto.X509Certificate
    ? certificate
    : new crypto.X509Certificate(certificate);
  return crypto.createHash("sha256").update(value.raw).digest("hex");
}

export function inspectCaCertificate(pem, options = {}) {
  const [certificate, ...extra] = parseCertificateList(pem, options.label ?? "CA certificate");
  if (extra.length > 0) throw invalid(`${options.label ?? "CA certificate"} must contain exactly one certificate.`);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (certificate.ca !== true) throw invalid(`${options.label ?? "CA certificate"} is not a CA certificate.`);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo <= now) {
    throw invalid(`${options.label ?? "CA certificate"} is not currently valid.`);
  }
  return Object.freeze({
    certificate,
    fingerprintSha256: certificateSha256(certificate),
    validFrom: new Date(validFrom).toISOString(),
    validTo: new Date(validTo).toISOString(),
  });
}

export function trustBundleIdentityDigest(manifest) {
  const value = [
    String(manifest.version),
    manifest.origin,
    manifest.currentCaSha256,
    manifest.previousCaSha256 ?? "",
    manifest.rotationNotBefore ?? "",
    manifest.generatedAt,
  ].join("\n");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function createTrustBundle(input) {
  const origin = normalizePublicHttpsOrigin(input.origin);
  const generatedAt = parseIsoTimestamp(
    input.generatedAt ?? new Date().toISOString(),
    "generatedAt"
  );
  const currentPem = String(input.currentCaPem ?? "").trim() + "\n";
  const current = inspectCaCertificate(currentPem, { now: input.now, label: "current CA" });
  const previousPem = String(input.previousCaPem ?? "").trim();
  let previous = null;
  let rotationNotBefore = null;
  if (previousPem) {
    previous = inspectCaCertificate(`${previousPem}\n`, { now: input.now, label: "previous CA" });
    if (previous.fingerprintSha256 === current.fingerprintSha256) {
      throw invalid("Current and previous CA certificates must differ.");
    }
    rotationNotBefore = parseIsoTimestamp(input.rotationNotBefore, "rotationNotBefore");
    if (rotationNotBefore.time > generatedAt.time) {
      throw invalid("rotationNotBefore cannot be after generatedAt.");
    }
  } else if (input.rotationNotBefore != null && String(input.rotationNotBefore).trim()) {
    throw invalid("rotationNotBefore requires a previous CA certificate.");
  }

  const manifest = Object.freeze({
    version: TRUST_BUNDLE_VERSION,
    origin,
    currentCaSha256: current.fingerprintSha256,
    ...(previous ? { previousCaSha256: previous.fingerprintSha256 } : {}),
    ...(rotationNotBefore ? { rotationNotBefore: rotationNotBefore.text } : {}),
    generatedAt: generatedAt.text,
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const combinedCaPem = `${currentPem}${previous ? `${previousPem.trim()}\n` : ""}`;
  return Object.freeze({
    manifest,
    manifestText,
    origin,
    currentCaPem: currentPem,
    previousCaPem: previous ? `${previousPem.trim()}\n` : "",
    combinedCaPem,
    identityDigestSha256: trustBundleIdentityDigest(manifest),
  });
}

export function trustBundlePaths(directory) {
  const root = path.resolve(directory);
  return Object.freeze(Object.fromEntries(
    Object.entries(TRUST_BUNDLE_FILENAMES).map(([key, filename]) => [key, path.join(root, filename)])
  ));
}

export function writeClientTrustBundleSync(directory, input) {
  const bundle = createTrustBundle(input);
  const paths = trustBundlePaths(directory);
  fs.mkdirSync(path.resolve(directory), { recursive: true, mode: 0o755 });
  const write = (filename, value) => fs.writeFileSync(filename, value, { encoding: "utf8", mode: 0o644, flag: "wx" });
  write(paths.manifest, bundle.manifestText);
  write(paths.serverUrl, `${bundle.origin}\n`);
  write(paths.currentCa, bundle.currentCaPem);
  if (bundle.previousCaPem) write(paths.previousCa, bundle.previousCaPem);
  write(paths.combinedCa, bundle.combinedCaPem);
  write(
    paths.readme,
    "QuickHack HTTPS client configuration\n\n" +
      "Copy this complete directory as one unit. Do not copy server private keys or PFX files.\n" +
      "QuickHack rejects incomplete, mixed-origin, or fingerprint-mismatched bundles.\n"
  );
  return Object.freeze({ ...bundle, paths });
}

export function readClientTrustBundleSync(directory, options = {}) {
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(path.resolve(directory));
  } catch {
    throw invalid(`Trust bundle directory is missing: ${path.resolve(directory)}`, "TRUST_BUNDLE_INCOMPLETE");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw invalid("Trust bundle directory must be a real directory, not a link.");
  }
  const paths = trustBundlePaths(directory);
  let manifest;
  try {
    manifest = JSON.parse(boundedText(paths.manifest));
  } catch (error) {
    if (error?.code) throw error;
    throw invalid(`Trust bundle manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  exactObject(manifest, "Trust bundle manifest");
  const rotated = Object.hasOwn(manifest, "previousCaSha256") || Object.hasOwn(manifest, "rotationNotBefore");
  exactKeys(manifest, rotated ? ROTATION_MANIFEST_KEYS : BASE_MANIFEST_KEYS, "Trust bundle manifest");
  if (manifest.version !== TRUST_BUNDLE_VERSION) throw invalid("Trust bundle version is unsupported.");
  const origin = normalizePublicHttpsOrigin(manifest.origin);
  if (origin !== manifest.origin) throw invalid("Trust bundle origin is not canonical.");
  if (!/^[a-f0-9]{64}$/u.test(String(manifest.currentCaSha256 ?? ""))) {
    throw invalid("Trust bundle current CA fingerprint is invalid.");
  }
  const generatedAt = parseIsoTimestamp(manifest.generatedAt, "generatedAt");
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  if (generatedAt.time > now + 5 * 60_000) throw invalid("Trust bundle generatedAt is in the future.");

  let rotationNotBefore = null;
  if (rotated) {
    if (!/^[a-f0-9]{64}$/u.test(String(manifest.previousCaSha256 ?? ""))) {
      throw invalid("Trust bundle previous CA fingerprint is invalid.");
    }
    rotationNotBefore = parseIsoTimestamp(manifest.rotationNotBefore, "rotationNotBefore");
    if (rotationNotBefore.time > generatedAt.time) throw invalid("rotationNotBefore cannot be after generatedAt.");
  }

  const serverUrlText = boundedText(paths.serverUrl).trim();
  if (serverUrlText !== origin) throw invalid("server-url.txt does not match the trust bundle origin.");
  const currentCaPem = boundedText(paths.currentCa);
  const current = inspectCaCertificate(currentCaPem, { now, label: "current CA" });
  if (current.fingerprintSha256 !== manifest.currentCaSha256) {
    throw invalid("Current CA fingerprint does not match the trust bundle manifest.");
  }

  regularFile(paths.previousCa, rotated);
  if (!rotated && fs.existsSync(paths.previousCa)) {
    throw invalid("A stale previous CA exists outside a rotation window.");
  }
  const previousCaPem = rotated ? boundedText(paths.previousCa) : "";
  const previous = rotated
    ? inspectCaCertificate(previousCaPem, { now, label: "previous CA" })
    : null;
  if (previous && previous.fingerprintSha256 !== manifest.previousCaSha256) {
    throw invalid("Previous CA fingerprint does not match the trust bundle manifest.");
  }
  if (previous && previous.fingerprintSha256 === current.fingerprintSha256) {
    throw invalid("Current and previous CA certificates must differ.");
  }

  const combinedCaPem = boundedText(paths.combinedCa);
  const combined = parseCertificateList(combinedCaPem, "combined CA bundle");
  const expectedFingerprints = [current.fingerprintSha256, ...(previous ? [previous.fingerprintSha256] : [])];
  if (
    combined.length !== expectedFingerprints.length ||
    combined.some((certificate, index) => certificateSha256(certificate) !== expectedFingerprints[index])
  ) {
    throw invalid("Combined CA bundle order or contents do not match the manifest.");
  }
  regularFile(paths.readme);

  const normalizedManifest = Object.freeze({
    version: TRUST_BUNDLE_VERSION,
    origin,
    currentCaSha256: current.fingerprintSha256,
    ...(previous ? { previousCaSha256: previous.fingerprintSha256, rotationNotBefore: rotationNotBefore.text } : {}),
    generatedAt: generatedAt.text,
  });
  return Object.freeze({
    manifest: normalizedManifest,
    origin,
    currentCaPem,
    previousCaPem,
    combinedCaPem,
    identityDigestSha256: trustBundleIdentityDigest(normalizedManifest),
    currentCertificate: current.certificate,
    previousCertificate: previous?.certificate ?? null,
    paths,
  });
}
