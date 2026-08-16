import path from "node:path";
import { packageArtifactContract } from "../package-artifact-contract.mjs";

export const QUICKHACK_PACKAGE_OPERATIONS = Object.freeze([
  "INSTALL",
  "UPGRADE",
  "REPAIR",
  "UNINSTALL",
  "PURGE",
]);

function failure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  return error;
}

function operation(value) {
  const result = String(value ?? "").trim().toUpperCase();
  if (!QUICKHACK_PACKAGE_OPERATIONS.includes(result)) {
    throw failure("PACKAGE_OPERATION_INVALID", `Unsupported package operation: ${result || "empty"}.`);
  }
  return result;
}

function normalizedAbsolute(value, fieldName, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const source = String(value ?? "").trim();
  if (!api.isAbsolute(source) || source.split(/[\\/]+/u).includes("..")) {
    throw failure("PACKAGE_ARTIFACT_INVALID", `${fieldName} must be an absolute contained path.`);
  }
  return api.normalize(source);
}

export function assertOwnedPurgeTargets(input) {
  const platform = input?.platform === "win32" ? "win32" : "linux";
  const api = platform === "win32" ? path.win32 : path.posix;
  const ownedRoot = normalizedAbsolute(input?.ownedRoot, "ownedRoot", platform);
  const targets = [...new Set((input?.targets ?? []).map((target) => normalizedAbsolute(target, "target", platform)))];
  for (const target of targets) {
    const relative = api.relative(ownedRoot, target);
    if (!relative || relative.startsWith("..") || api.isAbsolute(relative)) {
      throw failure("PACKAGE_ARTIFACT_INVALID", "Purge target escapes or equals the owned root.", {
        ownedRoot,
        target,
      });
    }
  }
  return Object.freeze(targets);
}

export function createPackageStateRecord(input) {
  const artifact = packageArtifactContract(input?.artifactKind ?? input?.packageTarget);
  const ownedRelativeRoots = [...new Set((input?.ownedRelativeRoots ?? []).map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort();
  if (ownedRelativeRoots.some((value) => value.startsWith("/") || value.split(/[\\/]+/u).includes(".."))) {
    throw failure("PACKAGE_ARTIFACT_INVALID", "Package state roots must be relative and contained.");
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: artifact.artifactKind,
    layoutVersion: 1,
    createdVersion: String(input?.createdVersion ?? "").trim(),
    lastSuccessfulVersion: String(input?.lastSuccessfulVersion ?? "").trim(),
    ownedRelativeRoots: Object.freeze(ownedRelativeRoots),
    lastVerifiedBackup: input?.lastVerifiedBackup
      ? Object.freeze({
          verified: input.lastVerifiedBackup.verified === true,
          verifiedAt: String(input.lastVerifiedBackup.verifiedAt ?? "").trim(),
          checksum: String(input.lastVerifiedBackup.checksum ?? "").trim(),
        })
      : null,
  });
}

export function createPackageLifecyclePlan(input) {
  const artifact = packageArtifactContract(input?.artifactKind ?? input?.packageTarget);
  const requestedOperation = operation(input?.operation);
  const binaryPaths = Object.freeze([...(input?.binaryPaths ?? [])].map(String).sort());
  const serviceIdentities = Object.freeze([...(input?.serviceIdentities ?? [])].map(String).sort());
  const mutablePaths = Object.freeze([...(input?.mutablePaths ?? [])].map(String).sort());

  if (requestedOperation === "PURGE") {
    if (input?.confirmation?.artifactKind !== artifact.artifactKind || input?.confirmation?.irreversible !== true) {
      throw failure("PURGE_CONFIRMATION_REQUIRED", "Exact artifact and irreversible purge confirmation are required.");
    }
    if (input?.backupVerified !== true && input?.confirmation?.noRecoveryAcknowledged !== true) {
      throw failure("PURGE_CONFIRMATION_REQUIRED", "Purge without a verified backup requires no-recovery acknowledgement.");
    }
  }

  return Object.freeze({
    operation: requestedOperation,
    artifactKind: artifact.artifactKind,
    removeBinaryPaths: requestedOperation === "UNINSTALL" || requestedOperation === "PURGE" ? binaryPaths : Object.freeze([]),
    removeServiceIdentities: requestedOperation === "UNINSTALL" || requestedOperation === "PURGE" ? serviceIdentities : Object.freeze([]),
    removeMutablePaths: requestedOperation === "PURGE" ? mutablePaths : Object.freeze([]),
    preserveMutableState: requestedOperation !== "PURGE",
  });
}
