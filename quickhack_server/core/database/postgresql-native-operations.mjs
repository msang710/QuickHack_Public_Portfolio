import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  NativeRuntimeContractError,
  POSTGRESQL_MAJOR_VERSION,
  POSTGRESQL_TOOL_CAPABILITIES,
  assertPostgresqlToolVersions,
} from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import {
  LIFECYCLE_DAY_MS,
  defineLifecyclePolicy,
  isStrictlyBeforeLifecycleCutoff,
  lifecycleAgeMs,
  lifecycleCutoffExclusive,
  resolveLifecycleBatchSize,
} from "../../../quickhack_shared/lifecycle/lifecycle-policy.mjs";

export const POSTGRESQL_BACKUP_PROTOCOL = "QUICKHACK_POSTGRESQL_BACKUP_V1";
export { POSTGRESQL_MAJOR_VERSION };
const BACKUP_EXTENSION = ".qhb";
const MANIFEST_EXTENSION = ".qhb.json";
const BACKUP_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUARANTINE_METADATA_FILE = "quarantine.json";
const QUARANTINE_PENDING_PREFIX = ".pending-";
const QUARANTINE_FINAL_PREFIX = "quarantine-";
const ACTIVE_BACKUP_OPERATION_KEYS = new Set();
export const POSTGRESQL_BACKUP_QUARANTINE_POLICY = defineLifecyclePolicy({
  retentionMs: 30 * LIFECYCLE_DAY_MS,
  maxBatchSize: 100,
});
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export class PostgresqlNativeOperationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PostgresqlNativeOperationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PostgresqlNativeOperationError(code, message, details);
}

function assertIdentifier(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(normalized)) {
    fail("POSTGRESQL_IDENTIFIER_INVALID", `${label} is not a safe PostgreSQL identifier.`);
  }
  return normalized;
}

function quoteIdentifier(value) {
  return `"${assertIdentifier(value, "database identifier")}"`;
}

function parseConnection(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail("POSTGRESQL_CONNECTION_INVALID", "The PostgreSQL connection is invalid.");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    fail("POSTGRESQL_CONNECTION_INVALID", "The PostgreSQL connection protocol is invalid.");
  }
  const host = url.hostname.toLowerCase();
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host)) {
    fail("POSTGRESQL_CONNECTION_NOT_LOOPBACK", "PostgreSQL native operations require a loopback server.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = Number(url.port || 5432);
  if (!database || !user || !password || !Number.isSafeInteger(port)) {
    fail("POSTGRESQL_CONNECTION_INVALID", "The PostgreSQL connection is incomplete.");
  }
  return { host, port, database, user, password };
}

function pgPassValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

async function withPgPassFile(connection, privateDirectory, operation) {
  await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const passPath = path.join(privateDirectory, `.pgpass.${process.pid}.${randomUUID()}`);
  const payload = Buffer.from(
    `${pgPassValue(connection.host)}:${connection.port}:*:${pgPassValue(connection.user)}:${pgPassValue(connection.password)}\n`,
    "utf8"
  );
  try {
    const handle = await fs.open(passPath, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await operation(passPath);
  } finally {
    payload.fill(0);
    await fs.rm(passPath, { force: true }).catch(() => undefined);
  }
}

function toolExecutable(binDirectory, tool, processExecution) {
  if (!processExecution || typeof processExecution.postgresqlExecutable !== "function") {
    throw new TypeError("PostgreSQL native operations require a server process adapter.");
  }
  return processExecution.postgresqlExecutable(path.resolve(binDirectory), tool);
}

function readPostgresqlToolVersion({ tool, executable, processExecution, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: processExecution.childEnvironment({
        source: process.env,
        executableDirectories: [path.dirname(executable)],
      }),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_VERSION_OUTPUT_BYTES) {
        child.kill();
        finish(() =>
          reject(
            new PostgresqlNativeOperationError(
              "POSTGRESQL_NATIVE_TOOL_VERSION_INVALID",
              `PostgreSQL tool version output exceeded the limit: ${tool}.`
            )
          )
        );
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) =>
      finish(() =>
        reject(
          new PostgresqlNativeOperationError(
            "POSTGRESQL_NATIVE_TOOL_VERSION_INVALID",
            `PostgreSQL tool version check failed: ${tool}.`,
            { cause: error instanceof Error ? error.message : String(error) }
          )
        )
      )
    );
    child.once("close", (code) =>
      finish(() => {
        if (code !== 0) {
          reject(
            new PostgresqlNativeOperationError(
              "POSTGRESQL_NATIVE_TOOL_VERSION_INVALID",
              `PostgreSQL tool version check failed: ${tool}.`,
              { exitCode: code }
            )
          );
          return;
        }
        resolve(`${stdout}\n${stderr}`.trim());
      })
    );
    timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new PostgresqlNativeOperationError(
            "POSTGRESQL_NATIVE_TOOL_VERSION_TIMEOUT",
            `PostgreSQL tool version check timed out: ${tool}.`
          )
        )
      );
    }, timeoutMs);
  });
}

export async function inspectPostgresqlToolchain({
  binDirectory,
  capability = "backup",
  processExecution,
  runVersion = readPostgresqlToolVersion,
}) {
  const requiredTools = POSTGRESQL_TOOL_CAPABILITIES[capability];
  if (!requiredTools) {
    throw new TypeError(`Unknown PostgreSQL capability: ${capability}`);
  }
  const root = path.resolve(binDirectory);
  const observedVersions = {};
  for (const tool of requiredTools) {
    const executable = toolExecutable(root, tool, processExecution);
    const stat = await fs.lstat(executable).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      fail(
        "POSTGRESQL_NATIVE_TOOL_MISSING",
        `Required PostgreSQL tool was not found: ${tool}.`,
        { capability, tool, binDirectory: root }
      );
    }
    observedVersions[tool] = await runVersion({ tool, executable, processExecution });
  }
  try {
    return assertPostgresqlToolVersions(observedVersions, { capability });
  } catch (error) {
    if (error instanceof NativeRuntimeContractError) {
      fail(error.code, error.message, {
        ...error.details,
        binDirectory: root,
      });
    }
    throw error;
  }
}

export async function runPostgresqlTool({
  tool,
  args,
  connectionString,
  binDirectory,
  privateDirectory,
  processExecution,
  timeoutMs = 15 * 60_000,
}) {
  const connection = parseConnection(connectionString);
  const executable = toolExecutable(binDirectory, tool, processExecution);
  const stat = await fs.lstat(executable).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail("POSTGRESQL_NATIVE_TOOL_MISSING", `Required PostgreSQL tool was not found: ${tool}`);
  }

  return withPgPassFile(connection, privateDirectory, (passPath) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        [
          "--host", connection.host,
          "--port", String(connection.port),
          "--username", connection.user,
          "--no-password",
          ...args,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: processExecution.childEnvironment({
            source: process.env,
            executableDirectories: [path.dirname(executable)],
            overrides: {
              PGPASSFILE: passPath,
              PGCONNECT_TIMEOUT: "10",
            },
          }),
        }
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const append = (current, chunk) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
          child.kill();
          reject(new PostgresqlNativeOperationError(
            "POSTGRESQL_NATIVE_TOOL_OUTPUT_LIMIT",
            `${tool} produced too much output.`
          ));
        }
        return next;
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new PostgresqlNativeOperationError(
          "POSTGRESQL_NATIVE_TOOL_START_FAILED",
          `${tool} could not be started.`,
          { cause: error instanceof Error ? error.message : String(error) }
        ));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new PostgresqlNativeOperationError(
          "POSTGRESQL_NATIVE_TOOL_FAILED",
          `${tool} failed.`,
          { code, signal, stderr: stderr.slice(-4000) }
        ));
      });
    })
  );
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
}

async function regularFile(filePath) {
  const stat = await fs.lstat(filePath).catch(() => null);
  return stat && stat.isFile() && !stat.isSymbolicLink() ? stat : null;
}

function backupBaseName(createdAt, id = randomUUID()) {
  const timestamp = createdAt.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  return `quickhack-postgresql-${timestamp}-${id}`;
}

function normalizedBackupOperationId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!BACKUP_OPERATION_ID_PATTERN.test(normalized)) {
    fail(
      "POSTGRESQL_BACKUP_OPERATION_ID_INVALID",
      "The backup operation ID must be a UUID."
    );
  }
  return normalized;
}

function operationBackupBaseName(operationId) {
  const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
  return `quickhack-postgresql-operation-${digest.slice(0, 40)}`;
}

function backupPath(backupDirectory, fileName) {
  const baseName = path.basename(String(fileName));
  if (baseName !== fileName || !/^quickhack-postgresql-[A-Za-z0-9-]+\.qhb$/.test(baseName)) {
    fail("POSTGRESQL_BACKUP_PATH_INVALID", "The backup file name is invalid.");
  }
  const root = path.resolve(backupDirectory);
  const resolved = path.resolve(root, baseName);
  if (path.dirname(resolved) !== root) {
    fail("POSTGRESQL_BACKUP_PATH_INVALID", "The backup path escaped its directory.");
  }
  return resolved;
}

async function writeJsonExclusive(filePath, value) {
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    payload.fill(0);
    await handle.close();
  }
}

function validateManifest(value) {
  const expectedKeys = new Set([
    "protocol",
    "applicationVersion",
    "schemaVersion",
    "postgresqlMajor",
    "database",
    "fileName",
    "createdAt",
    "encryptedSize",
    "encryptedSha256",
    "dumpSha256",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expectedKeys.size ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.protocol !== POSTGRESQL_BACKUP_PROTOCOL
  ) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup manifest protocol is invalid.");
  }
  if (value.postgresqlMajor !== POSTGRESQL_MAJOR_VERSION) {
    fail("POSTGRESQL_BACKUP_VERSION_UNSUPPORTED", "The backup PostgreSQL major version is unsupported.");
  }
  assertIdentifier(value.database, "backup database");
  if (
    typeof value.applicationVersion !== "string" ||
    value.applicationVersion.length < 1 ||
    value.applicationVersion.length > 128 ||
    typeof value.schemaVersion !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(value.schemaVersion) ||
    typeof value.fileName !== "string" ||
    !/^quickhack-postgresql-[A-Za-z0-9-]+\.qhb$/.test(value.fileName)
  ) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup manifest identity is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(value.encryptedSha256) || !/^[a-f0-9]{64}$/.test(value.dumpSha256)) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup checksums are invalid.");
  }
  if (!Number.isSafeInteger(value.encryptedSize) || value.encryptedSize <= 0) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup size is invalid.");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup timestamp is invalid.");
  }
  return value;
}

async function readManifest(manifestPath) {
  const stat = await regularFile(manifestPath);
  if (!stat || stat.size <= 0 || stat.size > 64 * 1024) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup manifest file is invalid.");
  }
  try {
    return validateManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof PostgresqlNativeOperationError) throw error;
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup manifest JSON is invalid.");
  }
}

async function observeOperationBackupPair(finalPath, finalManifestPath) {
  const [payloadStat, manifestStat] = await Promise.all([
    regularFile(finalPath),
    regularFile(finalManifestPath),
  ]);
  const payloadExists = await fs.lstat(finalPath).catch(() => null);
  const manifestExists = await fs.lstat(finalManifestPath).catch(() => null);
  if (!payloadExists && !manifestExists) return null;
  if (
    (payloadExists && !payloadStat) ||
    (manifestExists && !manifestStat)
  ) {
    fail(
      "POSTGRESQL_BACKUP_OPERATION_ARTIFACT_UNSAFE",
      "The operation-bound backup artifact is not a regular file."
    );
  }
  if (!payloadStat || !manifestStat) {
    await fs.rm(finalManifestPath, { force: true });
    await fs.rm(finalPath, { force: true });
    return null;
  }
  let manifest;
  try {
    manifest = await readManifest(finalManifestPath);
  } catch (error) {
    if (error instanceof PostgresqlNativeOperationError) {
      return { invalidReasonCode: error.code };
    }
    throw error;
  }
  if (manifest.fileName !== path.basename(finalPath)) {
    return { invalidReasonCode: "POSTGRESQL_BACKUP_MANIFEST_INVALID" };
  }
  if (
    payloadStat.size !== manifest.encryptedSize ||
    (await sha256(finalPath)) !== manifest.encryptedSha256
  ) {
    return { invalidReasonCode: "POSTGRESQL_BACKUP_CORRUPT" };
  }
  return { backup: { ...manifest, path: finalPath }, observed: true };
}

export async function listPostgresqlBackups(backupDirectory) {
  const root = path.resolve(backupDirectory);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(MANIFEST_EXTENSION)) continue;
    const manifestPath = path.join(root, entry.name);
    try {
      const manifest = await readManifest(manifestPath);
      const fileName = entry.name.slice(0, -".json".length);
      if (manifest.fileName !== fileName) throw new Error("manifest file mismatch");
      const payloadPath = backupPath(root, fileName);
      const stat = await regularFile(payloadPath);
      backups.push({
        fileName,
        createdAt: manifest.createdAt,
        sizeBytes: stat?.size ?? 0,
        valid: Boolean(stat && stat.size === manifest.encryptedSize),
        validationCode:
          stat && stat.size === manifest.encryptedSize
            ? null
            : "POSTGRESQL_BACKUP_CORRUPT",
        applicationVersion: manifest.applicationVersion,
        schemaVersion: manifest.schemaVersion,
      });
    } catch (error) {
      backups.push({
        fileName: entry.name.slice(0, -".json".length),
        createdAt: null,
        sizeBytes: 0,
        valid: false,
        validationCode:
          error instanceof PostgresqlNativeOperationError
            ? error.code
            : "POSTGRESQL_BACKUP_MANIFEST_INVALID",
        applicationVersion: null,
        schemaVersion: null,
      });
    }
  }
  return backups.sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) ||
    right.fileName.localeCompare(left.fileName)
  );
}

function quarantineRoot(backupDirectory) {
  return path.join(path.resolve(backupDirectory), "quarantine");
}

function quarantineTimestamp(value) {
  return value.toISOString().replace(/[-:.]/g, "");
}

function validateQuarantineMetadata(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.protocol !== "QUICKHACK_POSTGRESQL_BACKUP_QUARANTINE_V1" ||
    typeof value.originalFileName !== "string" ||
    !/^quickhack-postgresql-[A-Za-z0-9-]+\.qhb$/.test(
      value.originalFileName
    ) ||
    typeof value.reasonCode !== "string" ||
    !/^[A-Z0-9_]{1,128}$/.test(value.reasonCode) ||
    typeof value.quarantinedAt !== "string" ||
    !Number.isFinite(Date.parse(value.quarantinedAt)) ||
    new Date(value.quarantinedAt).toISOString() !== value.quarantinedAt ||
    typeof value.finalDirectoryName !== "string" ||
    !new RegExp(`^${QUARANTINE_FINAL_PREFIX}[A-Za-z0-9-]+$`).test(
      value.finalDirectoryName
    )
  ) {
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_METADATA_INVALID",
      "The backup quarantine metadata is invalid."
    );
  }
  return value;
}

async function readQuarantineMetadata(directory) {
  let payload;
  try {
    payload = await fs.readFile(
      path.join(directory, QUARANTINE_METADATA_FILE),
      "utf8"
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_METADATA_INVALID",
      "The backup quarantine metadata is missing."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_METADATA_INVALID",
      "The backup quarantine metadata JSON is invalid."
    );
  }
  return validateQuarantineMetadata(parsed);
}

async function moveRegularFileIfPresent(source, target) {
  const state = await fs.lstat(source).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isFile() || state.isSymbolicLink()) {
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_SOURCE_UNSAFE",
      "The backup quarantine source is not a regular file."
    );
  }
  const targetState = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (targetState) {
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_CONFLICT",
      "The backup quarantine target already exists."
    );
  }
  await fs.rename(source, target);
  return true;
}

async function finalizePendingQuarantineDirectory(backupDirectory, pendingPath) {
  const root = quarantineRoot(backupDirectory);
  const pendingState = await fs.lstat(pendingPath);
  if (!pendingState.isDirectory() || pendingState.isSymbolicLink()) {
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_PATH_UNSAFE",
      "The backup quarantine staging path is unsafe."
    );
  }
  const metadata = await readQuarantineMetadata(pendingPath);
  const payloadSource = backupPath(
    backupDirectory,
    metadata.originalFileName
  );
  const manifestSource = `${payloadSource}.json`;
  await moveRegularFileIfPresent(
    manifestSource,
    path.join(pendingPath, path.basename(manifestSource))
  );
  await moveRegularFileIfPresent(
    payloadSource,
    path.join(pendingPath, path.basename(payloadSource))
  );
  const finalPath = path.join(root, metadata.finalDirectoryName);
  if (path.dirname(finalPath) !== root) {
    fail(
      "POSTGRESQL_BACKUP_QUARANTINE_PATH_UNSAFE",
      "The backup quarantine target escaped its directory."
    );
  }
  await fs.rename(pendingPath, finalPath);
  return { directory: metadata.finalDirectoryName, ...metadata };
}

async function recoverPendingPostgresqlBackupQuarantines(backupDirectory) {
  const root = quarantineRoot(backupDirectory);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const recovered = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.name.startsWith(QUARANTINE_PENDING_PREFIX)) continue;
    const pendingPath = path.join(root, entry.name);
    const state = await fs.lstat(pendingPath);
    if (!state.isDirectory() || state.isSymbolicLink()) continue;
    try {
      recovered.push(
        await finalizePendingQuarantineDirectory(
          backupDirectory,
          pendingPath
        )
      );
    } catch (error) {
      if (
        error instanceof PostgresqlNativeOperationError &&
        error.code === "POSTGRESQL_BACKUP_QUARANTINE_METADATA_INVALID"
      ) {
        // A crash can leave the private directory before its metadata is
        // durable. Preserve that staging evidence and let the active backup
        // candidate be classified independently in this verification pass.
        continue;
      }
      throw error;
    }
  }
  return recovered;
}

async function quarantinePostgresqlBackup({
  backupDirectory,
  fileName,
  reasonCode,
  now,
}) {
  const root = quarantineRoot(backupDirectory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const identity = randomUUID();
  const finalDirectoryName = `${QUARANTINE_FINAL_PREFIX}${quarantineTimestamp(
    now
  )}-${identity}`;
  const pendingPath = path.join(root, `${QUARANTINE_PENDING_PREFIX}${identity}`);
  await fs.mkdir(pendingPath, { mode: 0o700 });
  const metadata = {
    protocol: "QUICKHACK_POSTGRESQL_BACKUP_QUARANTINE_V1",
    originalFileName: fileName,
    reasonCode,
    quarantinedAt: now.toISOString(),
    finalDirectoryName,
  };
  await writeJsonExclusive(
    path.join(pendingPath, QUARANTINE_METADATA_FILE),
    metadata
  );
  return finalizePendingQuarantineDirectory(backupDirectory, pendingPath);
}

async function readPostgresqlBackupQuarantines(backupDirectory) {
  const root = quarantineRoot(backupDirectory);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const quarantines = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.name.startsWith(QUARANTINE_FINAL_PREFIX)) continue;
    const directory = path.join(root, entry.name);
    const state = await fs.lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink()) continue;
    try {
      const metadata = await readQuarantineMetadata(directory);
      if (metadata.finalDirectoryName !== entry.name) continue;
      quarantines.push({ directory, ...metadata });
    } catch {
      // Malformed quarantine entries are retained for operator review.
    }
  }
  return quarantines;
}

export async function listPostgresqlBackupQuarantines(backupDirectory) {
  return (await readPostgresqlBackupQuarantines(backupDirectory)).map(
    ({ directory, ...entry }) => ({
      ...entry,
      directoryName: path.basename(directory),
    })
  );
}

export async function cleanupPostgresqlBackupQuarantine({
  backupDirectory,
  now = new Date(),
  dryRun = false,
  maxBatchSize,
} = {}) {
  const reference = new Date(now);
  if (!Number.isFinite(reference.getTime())) {
    throw new TypeError("now must be a valid date.");
  }
  const cutoffExclusive = lifecycleCutoffExclusive(
    reference,
    POSTGRESQL_BACKUP_QUARANTINE_POLICY
  );
  const batchSize = resolveLifecycleBatchSize(
    POSTGRESQL_BACKUP_QUARANTINE_POLICY,
    maxBatchSize
  );
  const eligibleBefore = (await readPostgresqlBackupQuarantines(backupDirectory))
    .filter((entry) =>
      isStrictlyBeforeLifecycleCutoff(
        entry.quarantinedAt,
        cutoffExclusive
      )
    )
    .sort((left, right) => left.directory.localeCompare(right.directory));
  const candidates = eligibleBefore.slice(0, batchSize);
  let changedCount = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      const state = await fs.lstat(candidate.directory).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!state || !state.isDirectory() || state.isSymbolicLink()) continue;
      const current = await readQuarantineMetadata(candidate.directory);
      if (
        current.finalDirectoryName !== path.basename(candidate.directory) ||
        !isStrictlyBeforeLifecycleCutoff(
          current.quarantinedAt,
          cutoffExclusive
        )
      ) {
        continue;
      }
      await fs.rm(candidate.directory, { recursive: true });
      changedCount += 1;
    }
  }
  const remaining = (await readPostgresqlBackupQuarantines(backupDirectory))
    .filter((entry) =>
      isStrictlyBeforeLifecycleCutoff(
        entry.quarantinedAt,
        cutoffExclusive
      )
    );
  const oldest = remaining
    .map((entry) => new Date(entry.quarantinedAt))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return {
    dryRun: Boolean(dryRun),
    cutoffExclusive,
    maxBatchSize: batchSize,
    attemptedCount: candidates.length,
    changedCount: dryRun ? 0 : changedCount,
    backlogCount: remaining.length,
    oldestEligibleAgeMs: oldest ? lifecycleAgeMs(reference, oldest) : null,
  };
}

export async function applyPostgresqlBackupRetention(
  backupDirectory,
  retentionCount,
  options = {}
) {
  const keep = Number(retentionCount);
  if (!Number.isSafeInteger(keep) || keep <= 0) {
    fail("POSTGRESQL_BACKUP_RETENTION_INVALID", "The backup retention count is invalid.");
  }
  const verifiedFileNames = options.verifiedFileNames
    ? new Set(options.verifiedFileNames)
    : null;
  const backups = (await listPostgresqlBackups(backupDirectory)).filter(
    (item) =>
      item.valid &&
      (!verifiedFileNames || verifiedFileNames.has(item.fileName))
  );
  const removed = [];
  for (const backup of backups.slice(keep)) {
    const payloadPath = backupPath(backupDirectory, backup.fileName);
    // Delete the payload first. If the process stops between the two deletes,
    // the remaining manifest is rediscovered as invalid and quarantined on the
    // next integrity pass instead of leaving an invisible orphan payload.
    await fs.rm(payloadPath, { force: true });
    await fs.rm(`${payloadPath}.json`, { force: true });
    removed.push(backup.fileName);
  }
  return { retainedCount: Math.min(backups.length, keep), removed };
}

export async function createPostgresqlBackup({
  connectionString,
  binDirectory,
  privateDirectory,
  backupDirectory,
  applicationVersion,
  schemaVersion,
  encryptFile,
  processExecution,
  runTool = runPostgresqlTool,
  now = new Date(),
  operationId,
}) {
  if (typeof encryptFile !== "function") {
    fail("POSTGRESQL_BACKUP_ENCRYPTION_REQUIRED", "Backup encryption is required.");
  }
  if (runTool === runPostgresqlTool) {
    await inspectPostgresqlToolchain({
      binDirectory,
      capability: "backup",
      processExecution,
    });
    runTool = (input) => runPostgresqlTool({ ...input, processExecution });
  }
  const connection = parseConnection(connectionString);
  const root = path.resolve(backupDirectory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const normalizedOperationId = normalizedBackupOperationId(operationId);
  const operationKey = normalizedOperationId
    ? `${root}\0${normalizedOperationId}`
    : null;
  if (operationKey && ACTIVE_BACKUP_OPERATION_KEYS.has(operationKey)) {
    fail(
      "POSTGRESQL_BACKUP_OPERATION_IN_PROGRESS",
      "The logical backup operation is already running in this process."
    );
  }
  if (operationKey) ACTIVE_BACKUP_OPERATION_KEYS.add(operationKey);
  const baseName = normalizedOperationId
    ? operationBackupBaseName(normalizedOperationId)
    : backupBaseName(now);
  const attemptId = randomUUID();
  const rawPath = path.join(root, `.${baseName}.${attemptId}.dump.tmp`);
  const candidatePath = path.join(
    root,
    `.${baseName}.${attemptId}.qhb.candidate`
  );
  const finalPath = path.join(root, `${baseName}${BACKUP_EXTENSION}`);
  const candidateManifestPath = `${candidatePath}.json`;
  const finalManifestPath = `${finalPath}.json`;
  try {
    const prePublicationQuarantined = [];
    if (normalizedOperationId) {
      const observed = await observeOperationBackupPair(
        finalPath,
        finalManifestPath
      );
      if (observed?.invalidReasonCode) {
        prePublicationQuarantined.push(
          await quarantinePostgresqlBackup({
            backupDirectory,
            fileName: path.basename(finalPath),
            reasonCode: observed.invalidReasonCode,
            now,
          })
        );
      } else if (observed) {
        return { ...observed, prePublicationQuarantined };
      }
    }
    let payloadPublished = false;
    try {
      await runTool({
        tool: "pg_dump",
        args: [
          "--dbname", connection.database,
          "--format", "custom",
          "--compress", "9",
          "--no-owner",
          "--no-privileges",
          "--file", rawPath,
        ],
        connectionString,
        binDirectory,
        privateDirectory,
      });
      const rawStat = await regularFile(rawPath);
      if (!rawStat || rawStat.size <= 0) {
        fail("POSTGRESQL_BACKUP_EMPTY", "pg_dump did not create a backup payload.");
      }
      await runTool({
        tool: "pg_restore",
        args: ["--list", rawPath],
        connectionString,
        binDirectory,
        privateDirectory,
      });
      const dumpSha256 = await sha256(rawPath);
      await encryptFile(rawPath, candidatePath);
      const encryptedStat = await regularFile(candidatePath);
      if (!encryptedStat || encryptedStat.size <= 0) {
        fail("POSTGRESQL_BACKUP_ENCRYPTION_FAILED", "Backup encryption produced no payload.");
      }
      const manifest = {
        protocol: POSTGRESQL_BACKUP_PROTOCOL,
        applicationVersion: String(applicationVersion),
        schemaVersion: String(schemaVersion),
        postgresqlMajor: POSTGRESQL_MAJOR_VERSION,
        database: connection.database,
        fileName: path.basename(finalPath),
        createdAt: now.toISOString(),
        encryptedSize: encryptedStat.size,
        encryptedSha256: await sha256(candidatePath),
        dumpSha256,
      };
      await writeJsonExclusive(candidateManifestPath, manifest);
      await fs.link(candidatePath, finalPath);
      payloadPublished = true;
      await fs.link(candidateManifestPath, finalManifestPath);
      return {
        backup: { ...manifest, path: finalPath },
        observed: false,
        prePublicationQuarantined,
      };
    } catch (error) {
      if (payloadPublished) {
        await fs.rm(finalManifestPath, { force: true }).catch(() => undefined);
        await fs.rm(finalPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      await Promise.all([
        fs.rm(rawPath, { force: true }).catch(() => undefined),
        fs.rm(candidatePath, { force: true }).catch(() => undefined),
        fs.rm(candidateManifestPath, { force: true }).catch(() => undefined),
      ]);
    }
  } finally {
    if (operationKey) ACTIVE_BACKUP_OPERATION_KEYS.delete(operationKey);
  }
}

export async function verifyPostgresqlBackupsAndApplyRetention({
  backupDirectory,
  connectionString,
  binDirectory,
  privateDirectory,
  retentionCount,
  decryptFile,
  processExecution,
  runTool = runPostgresqlTool,
  now = new Date(),
  requiredFileName = null,
}) {
  const verifiedRunTool = runTool === runPostgresqlTool
    ? (input) => runPostgresqlTool({ ...input, processExecution })
    : runTool;
  if (runTool === runPostgresqlTool) {
    await inspectPostgresqlToolchain({
      binDirectory,
      capability: "backup",
      processExecution,
    });
  }
  const reference = new Date(now);
  if (!Number.isFinite(reference.getTime())) {
    throw new TypeError("now must be a valid date.");
  }
  const recoveredQuarantines =
    await recoverPendingPostgresqlBackupQuarantines(backupDirectory);
  const backups = await listPostgresqlBackups(backupDirectory);
  let verifiedCount = 0;
  const verifiedFileNames = [];
  const quarantined = [];
  for (const backup of backups) {
    if (!backup.valid) {
      quarantined.push(
        await quarantinePostgresqlBackup({
          backupDirectory,
          fileName: backup.fileName,
          reasonCode:
            backup.validationCode ?? "POSTGRESQL_BACKUP_MANIFEST_INVALID",
          now: reference,
        })
      );
      continue;
    }
    try {
      await withInspectedPostgresqlBackup({
        backupDirectory,
        fileName: backup.fileName,
        connectionString,
        binDirectory,
        privateDirectory,
        processExecution,
        decryptFile,
        runTool: verifiedRunTool,
        operation: async () => undefined,
      });
      verifiedCount += 1;
      verifiedFileNames.push(backup.fileName);
    } catch (error) {
      if (
        !(error instanceof PostgresqlNativeOperationError) ||
        !new Set([
          "POSTGRESQL_BACKUP_CORRUPT",
          "POSTGRESQL_BACKUP_MANIFEST_INVALID",
          "POSTGRESQL_BACKUP_VERSION_UNSUPPORTED",
        ]).has(error.code)
      ) {
        throw error;
      }
      quarantined.push(
        await quarantinePostgresqlBackup({
          backupDirectory,
          fileName: backup.fileName,
          reasonCode: error.code,
          now: reference,
        })
      );
    }
  }
  const retention = await applyPostgresqlBackupRetention(
    backupDirectory,
    retentionCount,
    { verifiedFileNames }
  );
  const quarantineCleanup = await cleanupPostgresqlBackupQuarantine({
    backupDirectory,
    now: reference,
  });
  const result = {
    candidateCount: backups.length,
    verifiedCount,
    remainingVerifiedCount: retention.retainedCount,
    verifiedFileNames,
    quarantinedCount: quarantined.length,
    quarantined,
    warningCount: quarantined.length,
    recoveredQuarantineCount: recoveredQuarantines.length,
    retention,
    quarantineCleanup,
  };
  if (
    requiredFileName &&
    quarantined.some((entry) => entry.originalFileName === requiredFileName)
  ) {
    fail(
      "POSTGRESQL_NEW_BACKUP_CORRUPT",
      "The newly published backup failed integrity verification.",
      result
    );
  }
  if (backups.length > 0 && verifiedCount === 0) {
    fail(
      "POSTGRESQL_BACKUP_NO_VERIFIED_RESTORE_POINT",
      "No verified PostgreSQL backup restore point remains.",
      result
    );
  }
  return {
    ...result,
  };
}

export async function withInspectedPostgresqlBackup({
  backupDirectory,
  fileName,
  connectionString,
  binDirectory,
  privateDirectory,
  decryptFile,
  processExecution,
  runTool = runPostgresqlTool,
  operation,
}) {
  if (typeof decryptFile !== "function" || typeof operation !== "function") {
    fail("POSTGRESQL_RESTORE_INPUT_INVALID", "Restore dependencies are incomplete.");
  }
  if (runTool === runPostgresqlTool) {
    await inspectPostgresqlToolchain({
      binDirectory,
      capability: "backup",
      processExecution,
    });
    runTool = (input) => runPostgresqlTool({ ...input, processExecution });
  }
  const payloadPath = backupPath(backupDirectory, fileName);
  const manifest = await readManifest(`${payloadPath}.json`);
  if (manifest.fileName !== fileName) {
    fail("POSTGRESQL_BACKUP_MANIFEST_INVALID", "The backup manifest does not match its payload.");
  }
  const payloadStat = await regularFile(payloadPath);
  if (!payloadStat || payloadStat.size !== manifest.encryptedSize) {
    fail("POSTGRESQL_BACKUP_CORRUPT", "The encrypted backup size does not match its manifest.");
  }
  if ((await sha256(payloadPath)) !== manifest.encryptedSha256) {
    fail("POSTGRESQL_BACKUP_CORRUPT", "The encrypted backup checksum does not match its manifest.");
  }
  const restoredDumpPath = path.join(
    path.resolve(privateDirectory),
    `.restore.${process.pid}.${randomUUID()}.dump`
  );
  await fs.mkdir(path.dirname(restoredDumpPath), { recursive: true, mode: 0o700 });
  try {
    await decryptFile(payloadPath, restoredDumpPath);
    if ((await sha256(restoredDumpPath)) !== manifest.dumpSha256) {
      fail("POSTGRESQL_BACKUP_CORRUPT", "The decrypted dump checksum does not match its manifest.");
    }
    try {
      await runTool({
        tool: "pg_restore",
        args: ["--list", restoredDumpPath],
        connectionString,
        binDirectory,
        privateDirectory,
      });
    } catch (error) {
      if (
        error instanceof PostgresqlNativeOperationError &&
        error.code === "POSTGRESQL_NATIVE_TOOL_FAILED"
      ) {
        fail(
          "POSTGRESQL_BACKUP_CORRUPT",
          "The decrypted backup is not a readable PostgreSQL archive.",
          { causeCode: error.code }
        );
      }
      throw error;
    }
    return await operation({ manifest, restoredDumpPath });
  } finally {
    await fs.rm(restoredDumpPath, { force: true }).catch(() => undefined);
  }
}

export async function restorePostgresqlBackup({
  backupDirectory,
  fileName,
  operatorConnectionString,
  binDirectory,
  privateDirectory,
  expectedDatabase,
  restoredDatabaseOwner,
  expectedApplicationVersion,
  expectedSchemaVersion,
  decryptFile,
  processExecution,
  runTool = runPostgresqlTool,
  onStagingRestored,
  onCutoverPhase,
}) {
  const liveDatabase = assertIdentifier(expectedDatabase, "live database");
  const liveDatabaseOwner = assertIdentifier(
    restoredDatabaseOwner,
    "restored database owner"
  );
  return withInspectedPostgresqlBackup({
    backupDirectory,
    fileName,
    connectionString: operatorConnectionString,
    binDirectory,
    privateDirectory,
    decryptFile,
    processExecution,
    runTool,
    operation: async ({ manifest, restoredDumpPath }) => {
      if (
        manifest.database !== liveDatabase ||
        manifest.applicationVersion !== String(expectedApplicationVersion) ||
        manifest.schemaVersion !== String(expectedSchemaVersion)
      ) {
        fail("POSTGRESQL_RESTORE_VERSION_MISMATCH", "The backup does not match this QuickHack release and schema.");
      }
      const stagingDatabase = assertIdentifier(
        `qh_restore_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        "staging database"
      );
      const previousDatabase = assertIdentifier(
        `qh_previous_${randomUUID().replaceAll("-", "").slice(0, 22)}`,
        "previous database"
      );
      const sql = async (command) => runTool({
        tool: "psql",
        args: ["--dbname", "postgres", "--set", "ON_ERROR_STOP=1", "--command", command],
        connectionString: operatorConnectionString,
        binDirectory,
        privateDirectory,
      });
      let stagingCreated = false;
      let liveRenamed = false;
      let cutoverComplete = false;
      const emitCutoverPhase = async (phase) => {
        if (typeof onCutoverPhase === "function") {
          await onCutoverPhase({
            phase,
            liveDatabase,
            stagingDatabase,
            previousDatabase,
            manifest,
          });
        }
      };
      try {
        await sql(`CREATE DATABASE ${quoteIdentifier(stagingDatabase)} TEMPLATE template0`);
        stagingCreated = true;
        await runTool({
          tool: "pg_restore",
          args: [
            "--dbname", stagingDatabase,
            "--exit-on-error",
            "--no-privileges",
            restoredDumpPath,
          ],
          connectionString: operatorConnectionString,
          binDirectory,
          privateDirectory,
        });
        await sql(
          `ALTER DATABASE ${quoteIdentifier(stagingDatabase)} OWNER TO ${quoteIdentifier(liveDatabaseOwner)}`
        );
        const stagingResult =
          typeof onStagingRestored === "function"
            ? await onStagingRestored({
                liveDatabase,
                stagingDatabase,
                previousDatabase,
                manifest,
              })
            : undefined;
        const terminate = (database) =>
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`;
        await emitCutoverPhase("STAGING_READY");
        await sql(terminate(liveDatabase));
        await sql(terminate(stagingDatabase));
        await sql(
          `ALTER DATABASE ${quoteIdentifier(liveDatabase)} RENAME TO ${quoteIdentifier(previousDatabase)}`
        );
        liveRenamed = true;
        await emitCutoverPhase("LIVE_RENAMED");
        await sql(
          `ALTER DATABASE ${quoteIdentifier(stagingDatabase)} RENAME TO ${quoteIdentifier(liveDatabase)}`
        );
        cutoverComplete = true;
        liveRenamed = false;
        await emitCutoverPhase("DATABASE_ACTIVATED");
        await sql(`DROP DATABASE ${quoteIdentifier(previousDatabase)} WITH (FORCE)`);
        await emitCutoverPhase("CUTOVER_COMPLETE");
        return {
          restored: true,
          fileName,
          database: liveDatabase,
          manifest,
          stagingResult,
        };
      } catch (error) {
        if (liveRenamed && !cutoverComplete) {
          try {
            await sql(
              `ALTER DATABASE ${quoteIdentifier(previousDatabase)} RENAME TO ${quoteIdentifier(liveDatabase)}`
            );
            liveRenamed = false;
            await emitCutoverPhase("ROLLED_BACK");
          } catch {
            // The durable cutover marker is intentionally left for offline recovery.
          }
        }
        if (stagingCreated && !cutoverComplete) {
          if (!liveRenamed) {
            await sql(`DROP DATABASE IF EXISTS ${quoteIdentifier(stagingDatabase)} WITH (FORCE)`).catch(() => undefined);
          }
        }
        throw error;
      }
    },
  });
}
