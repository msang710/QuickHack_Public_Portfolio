import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateServerRuntimeConfig, writeServerRuntimeConfigAtomicSync } from "../quickhack_shared/core/server-runtime-config.mjs";

const PROTOCOL = "QUICKHACK_RUNTIME_SETTINGS_TRANSACTION_V1";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 128 * 1024;
const MISSING = "MISSING";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function runtimeSettingsMarkerPath(configPath) {
  return path.join(path.dirname(configPath), `.${path.basename(configPath)}.pending`);
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function readRegularFile(filePath, maxBytes) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw Object.assign(new Error("The runtime settings transaction path is invalid."), { code: "RUNTIME_SETTINGS_FILE_INVALID" });
  }
  return fs.readFileSync(filePath);
}

function writeAtomic(filePath, bytes) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function removeMarker(filePath) {
  fs.rmSync(filePath, { force: true });
  syncDirectory(path.dirname(filePath));
}

function readMarker(filePath) {
  const bytes = readRegularFile(filePath, MAX_MARKER_BYTES);
  if (!bytes) return null;
  let marker;
  try { marker = JSON.parse(bytes.toString("utf8")); }
  catch { marker = null; }
  const previous = marker?.previousBase64 === null
    ? null
    : typeof marker?.previousBase64 === "string"
      ? Buffer.from(marker.previousBase64, "base64")
      : undefined;
  if (
    marker?.protocol !== PROTOCOL || !["PENDING", "COMMITTED"].includes(marker.phase) ||
    !/^(?:[a-f0-9]{64}|MISSING)$/u.test(marker.previousDigest) ||
    !/^[a-f0-9]{64}$/u.test(marker.nextDigest) ||
    (previous !== null && (previous === undefined || previous.length > MAX_CONFIG_BYTES || digest(previous) !== marker.previousDigest)) ||
    (previous === null && marker.previousDigest !== MISSING)
  ) {
    throw Object.assign(new Error("The runtime settings recovery marker is invalid."), { code: "RUNTIME_SETTINGS_MARKER_INVALID" });
  }
  if (previous !== null) {
    try { validateServerRuntimeConfig(JSON.parse(previous.toString("utf8"))); }
    catch { throw Object.assign(new Error("The previous runtime settings are invalid."), { code: "RUNTIME_SETTINGS_MARKER_INVALID" }); }
  }
  return { ...marker, previous };
}

function currentDigest(configPath) {
  const bytes = readRegularFile(configPath, MAX_CONFIG_BYTES);
  return bytes === null ? MISSING : digest(bytes);
}

function restorePrevious(configPath, marker) {
  const actual = currentDigest(configPath);
  if (actual !== marker.previousDigest && actual !== marker.nextDigest) {
    throw Object.assign(new Error("The runtime settings file changed during recovery."), { code: "RUNTIME_SETTINGS_RECOVERY_CONFLICT" });
  }
  if (actual === marker.previousDigest) return;
  if (marker.previous === null) {
    fs.rmSync(configPath, { force: true });
    syncDirectory(path.dirname(configPath));
  } else {
    writeAtomic(configPath, marker.previous);
  }
}

function recoveryError(original, code, rollback) {
  return Object.assign(new Error("Runtime settings require recovery before another change."), {
    code, statusCode: 409, originalCode: original?.code || "UNKNOWN",
    ...(rollback ? { rollbackCode: rollback?.code || "UNKNOWN" } : {}),
    ...(original?.shutdownOperationId ? { shutdownOperationId: original.shutdownOperationId } : {}),
    ...(original?.remainingPids ? { remainingPids: original.remainingPids } : {}),
  });
}

export function recoverServerRuntimeSettings(configPath) {
  const filePath = runtimeSettingsMarkerPath(configPath);
  const marker = readMarker(filePath);
  if (!marker) return { recovered: false };
  const actual = currentDigest(configPath);
  if (marker.phase === "COMMITTED") {
    if (actual !== marker.nextDigest) {
      throw Object.assign(new Error("The committed runtime settings changed after restart."), { code: "RUNTIME_SETTINGS_RECOVERY_CONFLICT" });
    }
    removeMarker(filePath);
    return { recovered: false, committed: true };
  }
  restorePrevious(configPath, marker);
  removeMarker(filePath);
  return { recovered: true };
}

export async function updateServerRuntimeSettings({ configPath, next, wasRunning, stop, start, canRestore }) {
  const normalized = validateServerRuntimeConfig(next);
  const filePath = runtimeSettingsMarkerPath(configPath);
  if (readMarker(filePath)) {
    throw Object.assign(new Error("A runtime settings transaction is pending recovery."), { code: "RUNTIME_SETTINGS_RECOVERY_REQUIRED", statusCode: 409 });
  }
  const previous = readRegularFile(configPath, MAX_CONFIG_BYTES);
  const marker = {
    protocol: PROTOCOL,
    phase: "PENDING",
    previousDigest: previous === null ? MISSING : digest(previous),
    previousBase64: previous === null ? null : previous.toString("base64"),
    nextDigest: digest(Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8")),
  };
  writeAtomic(filePath, Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"));
  let stopCompleted = false;
  try {
    if (wasRunning) {
      await stop();
      stopCompleted = true;
    }
    writeServerRuntimeConfigAtomicSync(configPath, normalized);
    syncDirectory(path.dirname(configPath));
    if (wasRunning) await start();
  } catch (original) {
    if (!stopCompleted && currentDigest(configPath) === marker.previousDigest) {
      removeMarker(filePath);
      throw original;
    }
    if (!canRestore()) throw recoveryError(original, "RUNTIME_SETTINGS_RECOVERY_REQUIRED");
    try {
      restorePrevious(configPath, { ...marker, previous });
      if (wasRunning) await start();
      removeMarker(filePath);
    } catch (rollback) {
      throw recoveryError(original, "RUNTIME_SETTINGS_ROLLBACK_FAILED", rollback);
    }
    throw Object.assign(new Error("Runtime settings failed and the previous settings were restored."), {
      code: "RUNTIME_SETTINGS_ROLLED_BACK", originalCode: original?.code || "UNKNOWN",
    });
  }
  try {
    writeAtomic(filePath, Buffer.from(`${JSON.stringify({ ...marker, phase: "COMMITTED" })}\n`, "utf8"));
  } catch (error) {
    try { removeMarker(filePath); }
    catch { throw recoveryError(error, "RUNTIME_SETTINGS_COMMIT_INCOMPLETE"); }
  }
  try { removeMarker(filePath); }
  catch { /* A committed marker is safe to clear on the next launch. */ }
  return { changed: true, runtimeSettings: normalized, restarted: wasRunning, message: "Runtime settings updated." };
}
