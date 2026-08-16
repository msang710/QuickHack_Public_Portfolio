import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
const REQUEST_KEY_SOURCE = String.raw`LOGEN-LABEL-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
const CONTENT_HASH_SOURCE = String.raw`[0-9a-f]{64}`;
const SPOOL_FILE_PATTERN = new RegExp(
  `^(${REQUEST_KEY_SOURCE})-(${CONTENT_HASH_SOURCE})\\.bin$`,
  "i"
);
const RECOVERY_FILE_PATTERN = new RegExp(
  `^(${REQUEST_KEY_SOURCE})-(${CONTENT_HASH_SOURCE})\\.unknown\\.json$`,
  "i"
);
const REQUEST_KEY_PATTERN = new RegExp(`^${REQUEST_KEY_SOURCE}$`, "i");
const CONTENT_HASH_PATTERN = new RegExp(`^${CONTENT_HASH_SOURCE}$`, "i");
const RECOVERY_VERSION = 1;
const RECOVERY_REASON_CODES = new Set([
  "ORPHANED_PRINT_SPOOL",
  "PRINT_ATTEMPT_STARTED",
  "REQUEST_KEY_CONTENT_CONFLICT",
]);

export class ClientPrintSpoolError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ClientPrintSpoolError";
    this.code = code;
  }
}

function normalizedClientDataDir(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new TypeError("clientDataDir is required for the client print spool.");
  }
  if (!path.isAbsolute(normalized)) {
    throw new TypeError("clientDataDir must be an absolute path.");
  }
  return path.normalize(normalized);
}

export function getClientPrintSpoolPaths(options = {}) {
  const clientDataDir = normalizedClientDataDir(options.clientDataDir);
  return {
    clientDataDir,
    spoolDir: path.join(clientDataDir, "print-spool"),
    recoveryDir: path.join(clientDataDir, "print-spool-recovery"),
    recoveryIndexDir: path.join(
      clientDataDir,
      "print-spool-recovery",
      "by-request"
    ),
  };
}

function assertRequestIdentity(requestKey, contentHash) {
  if (!REQUEST_KEY_PATTERN.test(String(requestKey || ""))) {
    throw new ClientPrintSpoolError(
      "INVALID_PRINT_REQUEST_KEY",
      "The print request key is invalid."
    );
  }
  if (!CONTENT_HASH_PATTERN.test(String(contentHash || ""))) {
    throw new ClientPrintSpoolError(
      "INVALID_PRINT_CONTENT_HASH",
      "The print spool content hash is invalid."
    );
  }
}

export function parseClientPrintSpoolFileName(filename) {
  const match = SPOOL_FILE_PATTERN.exec(String(filename || ""));
  return match
    ? {
        requestKey: match[1],
        contentHash: match[2].toLowerCase(),
      }
    : null;
}

function recoveryFilename(requestKey) {
  if (!REQUEST_KEY_PATTERN.test(String(requestKey || ""))) {
    throw new ClientPrintSpoolError(
      "INVALID_PRINT_REQUEST_KEY",
      "The print request key is invalid."
    );
  }
  return `${requestKey}.unknown.json`;
}

function recoveryConflictFilename(requestKey) {
  if (!REQUEST_KEY_PATTERN.test(String(requestKey || ""))) {
    throw new ClientPrintSpoolError(
      "INVALID_PRINT_REQUEST_KEY",
      "The print request key is invalid."
    );
  }
  return `${requestKey}.conflict.json`;
}

async function ensurePrivateDirectory(directory, options) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_UNSAFE_DIRECTORY",
      "The local print spool path is not a private directory."
    );
  }
  if (options.platform === "win32") {
    if (typeof options.applyWindowsAcl !== "function") {
      throw new ClientPrintSpoolError(
        "PRINT_SPOOL_SECURITY_ADAPTER_MISSING",
        "The Windows print spool security adapter is required."
      );
    }
    await options.applyWindowsAcl(directory);
  } else {
    await chmod(directory, 0o700);
  }
}

async function assertPrivateDirectory(directory) {
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_UNSAFE_DIRECTORY",
      "The local print spool path is not a private directory."
    );
  }
}

async function readRecoveryMarker(filename) {
  const state = await lstat(filename);
  if (!state.isFile() || state.isSymbolicLink()) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const status = String(parsed?.status || "");
  const conflict = status === "CONFLICT";
  if (
    parsed?.version !== RECOVERY_VERSION ||
    (!conflict && status !== "UNKNOWN") ||
    !RECOVERY_REASON_CODES.has(String(parsed?.reasonCode || "")) ||
    !REQUEST_KEY_PATTERN.test(String(parsed?.requestKey || "")) ||
    (!conflict &&
      !CONTENT_HASH_PATTERN.test(String(parsed?.contentHash || "")))
  ) {
    return null;
  }
  return {
    version: RECOVERY_VERSION,
    status,
    reasonCode: String(parsed.reasonCode),
    requestKey: String(parsed.requestKey),
    contentHash: conflict ? null : String(parsed.contentHash).toLowerCase(),
    recoveredAt: String(parsed.recoveredAt || ""),
  };
}

async function recoveryPathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createRecoveryMarkerFile(directory, filename, marker) {
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.recovery-${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, target);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function persistRecoveryConflictMarker(recoveryIndexDir, requestKey, now) {
  const marker = {
    version: RECOVERY_VERSION,
    status: "CONFLICT",
    reasonCode: "REQUEST_KEY_CONTENT_CONFLICT",
    requestKey,
    contentHash: null,
    recoveredAt: now().toISOString(),
  };
  await createRecoveryMarkerFile(
    recoveryIndexDir,
    recoveryConflictFilename(requestKey),
    marker
  );
  return marker;
}

async function persistRecoveryMarker(
  recoveryIndexDir,
  requestKey,
  contentHash,
  now,
  reasonCode = "ORPHANED_PRINT_SPOOL"
) {
  assertRequestIdentity(requestKey, contentHash);
  const filename = recoveryFilename(requestKey);
  const target = path.join(recoveryIndexDir, filename);
  const conflictTarget = path.join(
    recoveryIndexDir,
    recoveryConflictFilename(requestKey)
  );
  if (await recoveryPathExists(conflictTarget)) {
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_RECOVERY_MARKER_CONFLICT",
      "The local print recovery marker has a request-key content conflict."
    );
  }
  const marker = {
    version: RECOVERY_VERSION,
    status: "UNKNOWN",
    reasonCode,
    requestKey,
    contentHash: contentHash.toLowerCase(),
    recoveredAt: now().toISOString(),
  };
  if (await createRecoveryMarkerFile(recoveryIndexDir, filename, marker)) {
    return marker;
  }
  const existing = await readRecoveryMarker(target);
  if (
    existing?.status === "UNKNOWN" &&
    existing.requestKey.toLowerCase() === requestKey.toLowerCase() &&
    existing.contentHash === contentHash.toLowerCase()
  ) {
    return existing;
  }
  await persistRecoveryConflictMarker(recoveryIndexDir, requestKey, now);
  throw new ClientPrintSpoolError(
    "PRINT_SPOOL_RECOVERY_MARKER_CONFLICT",
    "The local print recovery marker conflicts with the orphaned spool."
  );
}

async function migrateLegacyRecoveryMarkers(paths, now) {
  const entries = await readdir(paths.recoveryDir);
  let migratedRecoveryCount = 0;
  let conflictedRecoveryCount = 0;

  for (const name of entries) {
    const match = RECOVERY_FILE_PATTERN.exec(name);
    if (!match) continue;

    const legacyPath = path.join(paths.recoveryDir, name);
    const requestKey = match[1];
    const contentHash = match[2].toLowerCase();
    const marker = await readRecoveryMarker(legacyPath);
    const valid =
      marker?.status === "UNKNOWN" &&
      marker.requestKey.toLowerCase() === requestKey.toLowerCase() &&
      marker.contentHash === contentHash;

    if (!valid) {
      await persistRecoveryConflictMarker(
        paths.recoveryIndexDir,
        requestKey,
        now
      );
      conflictedRecoveryCount += 1;
    } else {
      try {
        await persistRecoveryMarker(
          paths.recoveryIndexDir,
          requestKey,
          contentHash,
          now,
          marker.reasonCode
        );
        migratedRecoveryCount += 1;
      } catch (error) {
        if (
          !(error instanceof ClientPrintSpoolError) ||
          error.code !== "PRINT_SPOOL_RECOVERY_MARKER_CONFLICT"
        ) {
          throw error;
        }
        conflictedRecoveryCount += 1;
      }
    }

    // The indexed marker or its conflict sentinel is durable before the
    // legacy file is removed, so an interrupted migration remains fail-closed.
    await unlink(legacyPath);
  }

  return { migratedRecoveryCount, conflictedRecoveryCount };
}

export async function initializeClientPrintSpool(options = {}) {
  const paths = getClientPrintSpoolPaths(options);
  const platform = String(options.platform || "");
  if (platform !== "win32" && platform !== "linux") {
    throw new TypeError("An explicit supported client platform is required for the print spool.");
  }
  const runtimeOptions = {
    platform,
    applyWindowsAcl: options.applyWindowsAcl,
  };
  const now = options.now || (() => new Date());

  try {
    await ensurePrivateDirectory(paths.spoolDir, runtimeOptions);
    await ensurePrivateDirectory(paths.recoveryDir, runtimeOptions);
    await ensurePrivateDirectory(paths.recoveryIndexDir, runtimeOptions);
    const recoveryMigration = await migrateLegacyRecoveryMarkers(paths, now);
    const entries = await readdir(paths.spoolDir);
    let recoveredCount = 0;
    let skippedCount = 0;
    const skippedNames = [];

    for (const name of entries) {
      const identity = parseClientPrintSpoolFileName(name);
      const filename = path.join(paths.spoolDir, name);
      let state;
      try {
        state = await lstat(filename);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!identity || !state.isFile() || state.isSymbolicLink()) {
        skippedCount += 1;
        skippedNames.push(name);
        continue;
      }
      await persistRecoveryMarker(
        paths.recoveryIndexDir,
        identity.requestKey,
        identity.contentHash,
        now,
        "ORPHANED_PRINT_SPOOL"
      );
      await unlink(filename);
      recoveredCount += 1;
    }

    return {
      ok: true,
      ...paths,
      ...recoveryMigration,
      recoveredCount,
      skippedCount,
      skippedNames,
    };
  } catch (error) {
    if (error instanceof ClientPrintSpoolError) throw error;
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_SECURITY_INITIALIZATION_FAILED",
      "The private local print spool could not be initialized.",
      error
    );
  }
}

export async function armClientPrintSpoolAttempt(options) {
  const requestKey = String(options?.requestKey || "");
  const contentHash = String(options?.contentHash || "").toLowerCase();
  assertRequestIdentity(requestKey, contentHash);
  const paths = getClientPrintSpoolPaths(options);
  await assertPrivateDirectory(paths.spoolDir);
  await assertPrivateDirectory(paths.recoveryDir);
  await assertPrivateDirectory(paths.recoveryIndexDir);

  const spoolPath = path.join(
    paths.spoolDir,
    `${requestKey}-${contentHash}.bin`
  );
  const state = await lstat(spoolPath);
  if (!state.isFile() || state.isSymbolicLink()) {
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_UNSAFE_FILE",
      "The local print spool attempt could not be armed safely."
    );
  }

  return persistRecoveryMarker(
    paths.recoveryIndexDir,
    requestKey,
    contentHash,
    options.now || (() => new Date()),
    "PRINT_ATTEMPT_STARTED"
  );
}

export async function inspectClientPrintSpoolRecovery(options) {
  const requestKey = String(options?.requestKey || "");
  const contentHash = String(options?.contentHash || "").toLowerCase();
  assertRequestIdentity(requestKey, contentHash);
  const { recoveryIndexDir } = getClientPrintSpoolPaths(options);
  try {
    await assertPrivateDirectory(recoveryIndexDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "NONE", marker: null };
    }
    throw error;
  }
  const conflictPath = path.join(
    recoveryIndexDir,
    recoveryConflictFilename(requestKey)
  );
  if (await recoveryPathExists(conflictPath)) {
    return { status: "CONFLICT", marker: null };
  }

  const markerPath = path.join(recoveryIndexDir, recoveryFilename(requestKey));
  let marker;
  try {
    marker = await readRecoveryMarker(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "NONE", marker: null };
    }
    throw error;
  }
  if (
    marker?.status !== "UNKNOWN" ||
    marker.requestKey.toLowerCase() !== requestKey.toLowerCase()
  ) {
    return { status: "CONFLICT", marker: null };
  }
  return marker.contentHash === contentHash
    ? { status: "MATCH", marker }
    : { status: "CONFLICT", marker: null };
}

export async function createPrivatePrintSpoolFile(options) {
  const requestKey = String(options?.requestKey || "");
  const contentHash = String(options?.contentHash || "").toLowerCase();
  assertRequestIdentity(requestKey, contentHash);
  if (!Buffer.isBuffer(options?.payload)) {
    throw new ClientPrintSpoolError(
      "INVALID_PRINT_SPOOL_PAYLOAD",
      "The local print spool payload is invalid."
    );
  }
  const platform = String(options?.platform || "");
  if (platform !== "win32" && platform !== "linux") {
    throw new TypeError("An explicit supported client platform is required for the print spool.");
  }
  const { spoolDir } = getClientPrintSpoolPaths(options);
  await assertPrivateDirectory(spoolDir);
  const filename = path.join(
    spoolDir,
    `${requestKey}-${contentHash}.bin`
  );
  let handle = null;
  let created = false;
  try {
    handle = await open(filename, "wx", 0o600);
    created = true;
    await handle.writeFile(options.payload);
    await handle.sync();
    if (platform !== "win32") {
      await handle.chmod(0o600);
    }
    await handle.close();
    handle = null;
    return filename;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) {
      await rm(filename, { force: true }).catch(() => {});
    }
    if (error instanceof ClientPrintSpoolError) throw error;
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_FILE_CREATE_FAILED",
      "The private local print spool file could not be created.",
      error
    );
  }
}

export async function removePrivatePrintSpoolFile(filename, options = {}) {
  const { spoolDir } = getClientPrintSpoolPaths(options);
  const resolved = path.resolve(String(filename || ""));
  if (path.dirname(resolved) !== path.resolve(spoolDir)) {
    throw new ClientPrintSpoolError(
      "PRINT_SPOOL_PATH_OUTSIDE_DIRECTORY",
      "The local print spool file path is invalid."
    );
  }
  const identity = parseClientPrintSpoolFileName(path.basename(resolved));
  if (!identity) {
    throw new ClientPrintSpoolError(
      "INVALID_PRINT_SPOOL_FILENAME",
      "The local print spool filename is invalid."
    );
  }
  try {
    await unlink(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
