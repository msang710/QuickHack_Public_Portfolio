import { createHash } from "node:crypto";
import {
  packageArtifactContract,
  packageArtifactPlatformIdentity,
} from "../package-artifact-contract.mjs";

export const QUICKHACK_PACKAGE_MANIFEST_SCHEMA_VERSION = 1;
export const QUICKHACK_PACKAGE_MANIFEST_FILENAME = "quickhack-package.json";

function invalid(message) {
  const error = new TypeError(message);
  error.code = "PACKAGE_ARTIFACT_INVALID";
  return error;
}

function requiredString(value, fieldName) {
  const result = String(value ?? "").trim();
  if (!result) throw invalid(`${fieldName} is required.`);
  return result;
}

function sha256(value, fieldName) {
  const result = requiredString(value, fieldName).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw invalid(`${fieldName} must be a SHA-256 digest.`);
  }
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

export function canonicalPackageManifestJson(manifest) {
  return `${JSON.stringify(stableValue(assertPackageManifest(manifest)), null, 2)}\n`;
}

export function packageManifestSha256(manifest) {
  return createHash("sha256")
    .update(canonicalPackageManifestJson(manifest), "utf8")
    .digest("hex");
}

export function createPackageManifest(input) {
  const artifact = packageArtifactContract(input?.artifactKind ?? input?.packageTarget);
  const platform = requiredString(input?.platform, "platform").toLowerCase();
  const identity = packageArtifactPlatformIdentity(artifact.artifactKind, platform);
  const architecture = requiredString(
    input?.architecture ?? (platform === "win32" ? "x64" : "x86_64"),
    "architecture"
  );
  const expectedArchitecture = platform === "win32" ? "x64" : "x86_64";
  if (architecture !== expectedArchitecture) {
    throw invalid(`Unsupported ${platform} architecture: ${architecture}.`);
  }
  const entrypoint = requiredString(input?.entrypoint ?? artifact.entrypoint, "entrypoint")
    .replaceAll("\\", "/");
  if (entrypoint.startsWith("/") || entrypoint.split("/").includes("..")) {
    throw invalid("entrypoint must be a package-relative path.");
  }
  return Object.freeze({
    schemaVersion: QUICKHACK_PACKAGE_MANIFEST_SCHEMA_VERSION,
    artifactKind: artifact.artifactKind,
    packageTarget: artifact.packageTarget,
    deploymentFlavor: artifact.packageFlavor,
    runtimeRole: artifact.role.toUpperCase(),
    platform,
    architecture,
    version: requiredString(input?.version, "version"),
    entrypoint,
    contentInventorySha256: sha256(input?.contentInventorySha256, "contentInventorySha256"),
    installedIdentity: identity.installedIdentity,
  });
}

export function assertPackageManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("QuickHack package manifest must be an object.");
  }
  if (value.schemaVersion !== QUICKHACK_PACKAGE_MANIFEST_SCHEMA_VERSION) {
    throw invalid("QuickHack package manifest schema version is unsupported.");
  }
  const recreated = createPackageManifest(value);
  const expectedKeys = Object.keys(recreated).sort();
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw invalid("QuickHack package manifest has unknown or missing fields.");
  }
  for (const key of expectedKeys) {
    if (value[key] !== recreated[key]) {
      throw invalid(`QuickHack package manifest field does not match its artifact: ${key}.`);
    }
  }
  return recreated;
}
