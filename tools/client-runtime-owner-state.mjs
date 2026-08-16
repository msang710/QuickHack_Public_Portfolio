import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_KIND = "QUICKHACK_CLIENT_RUNTIME_OWNER";
const MANIFEST_VERSION = 2;
const MAX_STATE_BYTES = 16 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{48}$/u;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function defaultProcessExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statePayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    state: value.state,
    ownerToken: value.ownerToken,
    launcherPid: value.launcherPid,
    pid: value.pid,
    port: value.port,
    clientUrl: value.clientUrl,
    serverUrl: value.serverUrl,
    caCertificateFile: value.caCertificateFile,
    instanceId: value.instanceId,
    entry: value.entry,
    runtimeMode: value.runtimeMode,
    artifactKind: value.artifactKind,
    startedAt: value.startedAt,
  };
}

function stateChecksum(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(statePayload(value)), "utf8")
    .digest("hex");
}

function fsyncDirectory(fileSystem, directory) {
  let handle;
  try {
    handle = fileSystem.openSync(directory, "r");
    fileSystem.fsyncSync(handle);
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(error?.code)) throw error;
  } finally {
    if (handle !== undefined) fileSystem.closeSync(handle);
  }
}

function validateState(value) {
  const stateValid = value?.state === "PREPARED" || value?.state === "CLAIMED";
  const pidValid = value?.state === "PREPARED"
    ? value?.pid === null
    : Number.isInteger(value?.pid) && value.pid > 0;
  if (
    value?.schemaVersion !== MANIFEST_VERSION ||
    value?.kind !== MANIFEST_KIND ||
    !stateValid ||
    !TOKEN_PATTERN.test(String(value?.ownerToken ?? "")) ||
    !Number.isInteger(value?.launcherPid) ||
    value.launcherPid <= 0 ||
    !pidValid ||
    !Number.isInteger(value?.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value?.clientUrl !== "string" ||
    value.clientUrl.length > 2048 ||
    typeof value?.serverUrl !== "string" ||
    value.serverUrl.length > 2048 ||
    typeof value?.caCertificateFile !== "string" ||
    value.caCertificateFile.length > 4096 ||
    !TOKEN_PATTERN.test(String(value?.instanceId ?? "")) ||
    typeof value?.entry !== "string" ||
    value.entry.length > 4096 ||
    typeof value?.runtimeMode !== "string" ||
    value.runtimeMode.length > 64 ||
    typeof value?.artifactKind !== "string" ||
    value.artifactKind.length > 128 ||
    !Number.isFinite(Date.parse(String(value?.startedAt ?? ""))) ||
    !/^[a-f0-9]{64}$/u.test(String(value?.payloadChecksum ?? "")) ||
    stateChecksum(value) !== value.payloadChecksum
  ) {
    throw failure("CLIENT_RUNTIME_STATE_INVALID", "The client runtime owner state failed schema or checksum validation.");
  }
  return value;
}

function validateLegacyState(value) {
  if (
    value?.schemaVersion !== undefined ||
    value?.kind !== undefined ||
    !Number.isInteger(value?.pid) ||
    value.pid <= 0 ||
    !Number.isInteger(value?.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !TOKEN_PATTERN.test(String(value?.instanceId ?? "")) ||
    typeof value?.clientUrl !== "string" ||
    typeof value?.serverUrl !== "string" ||
    typeof value?.caCertificateFile !== "string" ||
    typeof value?.entry !== "string" ||
    typeof value?.runtimeMode !== "string" ||
    typeof value?.artifactKind !== "string" ||
    !Number.isFinite(Date.parse(String(value?.startedAt ?? "")))
  ) {
    throw failure("CLIENT_RUNTIME_STATE_INVALID", "The legacy client runtime owner state is invalid.");
  }
  return value;
}

function readRegularJson(fileSystem, filename, invalidCode) {
  const stat = fileSystem.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_STATE_BYTES) {
    throw failure(invalidCode, "The client runtime state file is unsafe.");
  }
  try {
    return { value: JSON.parse(fileSystem.readFileSync(filename, "utf8")), stat };
  } catch (error) {
    throw failure(invalidCode, "The client runtime state file is not valid JSON.", error);
  }
}

export function createClientRuntimeOwnerStateStore(options) {
  const fileSystem = options?.fileSystem ?? fs;
  const statePath = path.resolve(String(options?.statePath ?? ""));
  const directory = path.dirname(statePath);
  const lockPath = `${statePath}.lock`;
  const currentPid = options?.currentPid ?? process.pid;
  const processExists = options?.processExists ?? defaultProcessExists;
  const createToken = options?.createToken ?? (() => crypto.randomBytes(24).toString("hex"));
  const now = options?.now ?? (() => new Date());
  if (!String(options?.statePath ?? "").trim() || path.basename(statePath) === ".") {
    throw new TypeError("An absolute client runtime state path is required.");
  }

  function ensureDirectory() {
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fileSystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw failure("CLIENT_RUNTIME_STATE_INVALID", "The client runtime state directory is unsafe.");
    }
    try {
      fileSystem.chmodSync(directory, 0o700);
    } catch (error) {
      if (!["ENOSYS", "EPERM", "ENOTSUP"].includes(error?.code)) throw error;
    }
  }

  function read() {
    if (!fileSystem.existsSync(statePath)) return Object.freeze({ status: "MISSING", state: null });
    try {
      const { value } = readRegularJson(fileSystem, statePath, "CLIENT_RUNTIME_STATE_INVALID");
      try {
        return Object.freeze({ status: "VALID", state: Object.freeze(validateState(value)) });
      } catch (error) {
        try {
          return Object.freeze({ status: "LEGACY", state: Object.freeze(validateLegacyState(value)) });
        } catch {
          throw error;
        }
      }
    } catch (error) {
      return Object.freeze({ status: "INVALID", state: null, error });
    }
  }

  function writeAtomic(value, expected = {}) {
    ensureDirectory();
    if (expected.missing && fileSystem.existsSync(statePath)) {
      throw failure("CLIENT_RUNTIME_STATE_EXISTS", "A client runtime owner state already exists.");
    }
    if (expected.ownerToken) {
      const current = read();
      if (
        current.status !== "VALID" ||
        current.state.ownerToken !== expected.ownerToken ||
        (expected.state && current.state.state !== expected.state)
      ) {
        throw failure("CLIENT_RUNTIME_OWNER_MISMATCH", "The client runtime owner state changed before publish.");
      }
    }
    const manifest = { ...value };
    manifest.payloadChecksum = stateChecksum(manifest);
    validateState(manifest);
    const tempPath = path.join(directory, `${path.basename(statePath)}.prepared.${manifest.ownerToken}.${createToken()}.tmp`);
    let handle;
    try {
      handle = fileSystem.openSync(tempPath, "wx", 0o600);
      fileSystem.writeFileSync(handle, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      fileSystem.fsyncSync(handle);
      fileSystem.closeSync(handle);
      handle = undefined;
      fileSystem.renameSync(tempPath, statePath);
      fsyncDirectory(fileSystem, directory);
    } catch (error) {
      if (handle !== undefined) fileSystem.closeSync(handle);
      fileSystem.rmSync(tempPath, { force: true });
      throw error;
    }
    return Object.freeze(manifest);
  }

  function publishPrepared(input) {
    const manifest = {
      schemaVersion: MANIFEST_VERSION,
      kind: MANIFEST_KIND,
      state: "PREPARED",
      ownerToken: input.ownerToken,
      launcherPid: currentPid,
      pid: null,
      port: input.port,
      clientUrl: input.clientUrl,
      serverUrl: input.serverUrl,
      caCertificateFile: input.caCertificateFile,
      instanceId: input.instanceId,
      entry: input.entry,
      runtimeMode: input.runtimeMode,
      artifactKind: input.artifactKind ?? "",
      startedAt: input.startedAt ?? now().toISOString(),
    };
    return writeAtomic(manifest, { missing: true });
  }

  function publishClaimed(prepared, pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw failure("CLIENT_RUNTIME_SPAWN_FAILED", "The client runtime bootstrap did not expose a valid process id.");
    }
    return writeAtomic(
      { ...statePayload(prepared), state: "CLAIMED", pid },
      { ownerToken: prepared.ownerToken, state: "PREPARED" }
    );
  }

  function removeOwned(expected) {
    if (!fileSystem.existsSync(statePath)) return false;
    const cleanupPath = path.join(directory, `${path.basename(statePath)}.cleanup.${expected.ownerToken}.${createToken()}.tmp`);
    try {
      fileSystem.renameSync(statePath, cleanupPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    try {
      const { value } = readRegularJson(fileSystem, cleanupPath, "CLIENT_RUNTIME_STATE_INVALID");
      const current = validateState(value);
      if (
        current.ownerToken !== expected.ownerToken ||
        current.instanceId !== expected.instanceId ||
        (expected.pid !== undefined && current.pid !== expected.pid)
      ) {
        fileSystem.renameSync(cleanupPath, statePath);
        return false;
      }
      fileSystem.rmSync(cleanupPath, { force: true });
      fsyncDirectory(fileSystem, directory);
      return true;
    } catch (error) {
      if (fileSystem.existsSync(cleanupPath) && !fileSystem.existsSync(statePath)) {
        try { fileSystem.renameSync(cleanupPath, statePath); } catch {}
      }
      throw error;
    }
  }

  function recoverInactive() {
    if (!fileSystem.existsSync(statePath)) return false;
    const current = read();
    if (
      current.status === "VALID" &&
      ((current.state.state === "CLAIMED" && processExists(current.state.pid)) ||
        (current.state.state === "PREPARED" && processExists(current.state.launcherPid)))
    ) {
      throw failure("CLIENT_RUNTIME_OWNERSHIP_ACTIVE", "The client runtime owner state still has an active process.");
    }
    if (current.status === "LEGACY" && processExists(current.state.pid)) {
      throw failure("CLIENT_RUNTIME_OWNERSHIP_ACTIVE", "The legacy client runtime owner state still has an active process.");
    }
    const token = current.status === "VALID" ? current.state.ownerToken : createToken();
    const recoveryPath = path.join(directory, `${path.basename(statePath)}.quarantined.${token}.${createToken()}.tmp`);
    try {
      fileSystem.renameSync(statePath, recoveryPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    fileSystem.rmSync(recoveryPath, { force: true });
    fsyncDirectory(fileSystem, directory);
    return true;
  }

  function adoptLegacy(observed) {
    const current = read();
    if (
      current.status !== "LEGACY" ||
      current.state.instanceId !== observed?.instanceId ||
      !processExists(current.state.pid)
    ) {
      throw failure(
        "CLIENT_RUNTIME_OWNERSHIP_UNVERIFIED",
        "The legacy client runtime state cannot be safely adopted."
      );
    }
    const migrationPath = `${statePath}.legacy.${createToken()}.tmp`;
    fileSystem.renameSync(statePath, migrationPath);
    try {
      const { value } = readRegularJson(fileSystem, migrationPath, "CLIENT_RUNTIME_STATE_INVALID");
      const legacy = validateLegacyState(value);
      if (legacy.pid !== current.state.pid || legacy.instanceId !== current.state.instanceId) {
        throw failure("CLIENT_RUNTIME_OWNER_MISMATCH", "The legacy client runtime state changed during adoption.");
      }
      const adopted = writeAtomic({
        schemaVersion: MANIFEST_VERSION,
        kind: MANIFEST_KIND,
        state: "CLAIMED",
        ownerToken: createToken(),
        launcherPid: currentPid,
        pid: legacy.pid,
        port: legacy.port,
        clientUrl: legacy.clientUrl,
        serverUrl: legacy.serverUrl,
        caCertificateFile: legacy.caCertificateFile,
        instanceId: legacy.instanceId,
        entry: legacy.entry,
        runtimeMode: legacy.runtimeMode,
        artifactKind: legacy.artifactKind,
        startedAt: legacy.startedAt,
      }, { missing: true });
      fileSystem.rmSync(migrationPath, { force: true });
      fsyncDirectory(fileSystem, directory);
      return adopted;
    } catch (error) {
      if (!fileSystem.existsSync(statePath) && fileSystem.existsSync(migrationPath)) {
        try { fileSystem.renameSync(migrationPath, statePath); } catch {}
      }
      throw error;
    }
  }

  function acquireCommandLock() {
    ensureDirectory();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ownerToken = createToken();
      let handle;
      try {
        handle = fileSystem.openSync(lockPath, "wx", 0o600);
        const value = {
          schemaVersion: 1,
          kind: "QUICKHACK_CLIENT_RUNTIME_COMMAND_LOCK",
          ownerToken,
          pid: currentPid,
          createdAt: now().toISOString(),
        };
        fileSystem.writeFileSync(handle, `${JSON.stringify(value)}\n`, "utf8");
        fileSystem.fsyncSync(handle);
        fileSystem.closeSync(handle);
        handle = undefined;
        fsyncDirectory(fileSystem, directory);
        let released = false;
        return Object.freeze({
          ownerToken,
          release() {
            if (released) return false;
            released = true;
            if (!fileSystem.existsSync(lockPath)) return false;
            const releasePath = `${lockPath}.release.${ownerToken}`;
            fileSystem.renameSync(lockPath, releasePath);
            const { value: current } = readRegularJson(fileSystem, releasePath, "CLIENT_RUNTIME_LOCK_INVALID");
            if (current.ownerToken !== ownerToken || current.pid !== currentPid) {
              fileSystem.renameSync(releasePath, lockPath);
              throw failure("CLIENT_RUNTIME_LOCK_OWNER_MISMATCH", "The client runtime command lock owner changed.");
            }
            fileSystem.rmSync(releasePath, { force: true });
            fsyncDirectory(fileSystem, directory);
            return true;
          },
        });
      } catch (error) {
        if (handle !== undefined) fileSystem.closeSync(handle);
        if (error?.code !== "EEXIST") throw error;
        let current;
        try {
          const parsed = readRegularJson(fileSystem, lockPath, "CLIENT_RUNTIME_LOCK_INVALID").value;
          if (
            parsed?.schemaVersion !== 1 ||
            parsed?.kind !== "QUICKHACK_CLIENT_RUNTIME_COMMAND_LOCK" ||
            !TOKEN_PATTERN.test(String(parsed?.ownerToken ?? "")) ||
            !Number.isInteger(parsed?.pid) ||
            parsed.pid <= 0
          ) {
            throw failure("CLIENT_RUNTIME_LOCK_INVALID", "The client runtime command lock is invalid.");
          }
          current = parsed;
        } catch (lockError) {
          throw lockError;
        }
        if (processExists(current.pid)) {
          throw failure("CLIENT_RUNTIME_COMMAND_IN_PROGRESS", "Another client runtime command is already running.");
        }
        const recoveryPath = `${lockPath}.recover.${current.ownerToken}.${createToken()}`;
        try { fileSystem.renameSync(lockPath, recoveryPath); } catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw renameError;
        }
        const recovered = readRegularJson(fileSystem, recoveryPath, "CLIENT_RUNTIME_LOCK_INVALID").value;
        if (recovered.ownerToken !== current.ownerToken || recovered.pid !== current.pid) {
          fileSystem.renameSync(recoveryPath, lockPath);
          throw failure("CLIENT_RUNTIME_LOCK_OWNER_MISMATCH", "The stale command lock changed during recovery.");
        }
        fileSystem.rmSync(recoveryPath, { force: true });
      }
    }
    throw failure("CLIENT_RUNTIME_COMMAND_IN_PROGRESS", "The client runtime command lock could not be acquired.");
  }

  return Object.freeze({
    statePath,
    read,
    publishPrepared,
    publishClaimed,
    removeOwned,
    recoverInactive,
    adoptLegacy,
    acquireCommandLock,
  });
}

export function assertObservedClientRuntimeOwnership(observed, stateResult, isProcessRunning = defaultProcessExists) {
  if (
    stateResult?.status !== "VALID" ||
    stateResult.state.state !== "CLAIMED" ||
    stateResult.state.instanceId !== observed?.instanceId ||
    !isProcessRunning(stateResult.state.pid)
  ) {
    throw failure(
      "CLIENT_RUNTIME_OWNERSHIP_UNVERIFIED",
      "A client runtime is reachable, but its durable owner state cannot be verified."
    );
  }
  return stateResult.state;
}

export async function waitForClientRuntime(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export async function launchClientRuntimeWithOwnerState(options) {
  const prepared = options.stateStore.publishPrepared(options.preparedState);
  let child;
  let claimed;
  let cleanupFailure;
  try {
    child = options.spawnBootstrap(prepared);
    claimed = options.stateStore.publishClaimed(prepared, child?.pid);
    const ready = await options.waitFor(async () => {
      if (!options.isProcessRunning(child.pid)) {
        throw failure("CLIENT_RUNTIME_EXITED", "The client runtime bootstrap exited before readiness.");
      }
      const observed = await options.probeRuntime();
      return observed.role === "client" && observed.instanceId === claimed.instanceId
        ? observed
        : null;
    }, options.timeoutMs);
    if (!ready) {
      throw failure("CLIENT_RUNTIME_READINESS_TIMEOUT", "The client runtime did not become ready before the startup deadline.");
    }
    child.unref();
    return Object.freeze({ ready, state: claimed });
  } catch (error) {
    if (child?.pid && options.isProcessRunning(child.pid)) {
      try {
        options.terminateOwnedDetachedProcess(child.pid);
      } catch (terminationError) {
        if (options.isProcessRunning(child.pid)) cleanupFailure = terminationError;
      }
    }
    if (child?.pid) {
      let exited = await options.waitFor(
        async () => !options.isProcessRunning(child.pid),
        options.cleanupTimeoutMs ?? 5000,
        100
      );
      if (!exited) {
        try {
          options.terminateOwnedDetachedProcess(child.pid, { force: true });
          cleanupFailure = undefined;
          exited = await options.waitFor(
            async () => !options.isProcessRunning(child.pid),
            options.cleanupTimeoutMs ?? 5000,
            100
          );
        } catch (forceError) {
          cleanupFailure = forceError;
        }
      }
      if (!exited && !cleanupFailure) cleanupFailure = new Error("The owned client runtime process did not exit.");
    }
    if (child?.pid && !cleanupFailure) {
      try {
        const observed = await options.probeRuntime();
        if (observed?.role === "client" && observed.instanceId === prepared.instanceId) {
          cleanupFailure = new Error("The owned client runtime endpoint remained reachable after termination.");
        }
      } catch (probeError) {
        cleanupFailure = probeError;
      }
    }
    try {
      options.stateStore.removeOwned({
        ownerToken: prepared.ownerToken,
        instanceId: prepared.instanceId,
        ...(claimed ? { pid: claimed.pid } : {}),
      });
    } catch (stateCleanupError) {
      cleanupFailure ??= stateCleanupError;
    }
    if (cleanupFailure) {
      throw failure(
        "CLIENT_RUNTIME_CLEANUP_FAILED",
        "Client runtime startup failed and the owned process/state could not be fully recovered.",
        error
      );
    }
    throw error;
  }
}

export function readClientRuntimeOwnerStateFile(filename, fileSystem = fs) {
  try {
    const { value } = readRegularJson(fileSystem, filename, "CLIENT_RUNTIME_STATE_INVALID");
    return validateState(value);
  } catch {
    return null;
  }
}
