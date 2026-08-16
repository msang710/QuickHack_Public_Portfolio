import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import packageJson from "../package.json" with { type: "json" };
import {
  inspectPostgresqlToolchain,
  restorePostgresqlBackup,
  runPostgresqlTool,
} from "../quickhack_server/core/database/postgresql-native-operations.mjs";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";
import { decryptBackupFile } from "../quickhack_server/security/backup-encryption-core.mjs";
import { createBackupKeyProvider } from "../quickhack_server/security/backup-key-provider-core.mjs";
import { readServerRuntimeConfigSync } from "../quickhack_shared/core/server-runtime-config.mjs";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";

const { Pool } = pg;
const serverPlatform = composeServerPlatform();
const serverProcessExecution = serverPlatform.processExecution;
const SCHEMA_VERSION = "20260811010000_postgresql_baseline";
const PROHIBITED_TABLES = [
  "coupang_product_inquiry_raw",
  "coupang_call_center_inquiry_raw",
  "coupang_inquiry_work",
  "coupang_inquiry_order_link",
];
const APPEND_ONLY_TABLES = [
  "domain_audit_events",
  "domain_audit_event_changes",
  "employee_activity_logs",
  "employee_activity_log_changes",
];
export const RESTORE_BARRIER_FILE_NAME = "postgresql-restore-barrier.json";
export const RESTORE_BARRIER_PROTOCOL = "QUICKHACK_POSTGRESQL_RESTORE_BARRIER_V1";

function parseArguments(argv) {
  const values = {
    command: "restore",
    installDir: "",
    runtimeConfig: "",
    fileName: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--install-dir") values.installDir = argv[++index] || "";
    else if (argument === "--runtime-config") values.runtimeConfig = argv[++index] || "";
    else if (argument === "--backup-file") values.fileName = argv[++index] || "";
    else if (argument === "--recover-cutover") values.command = "recover-cutover";
    else throw new Error(`Unsupported argument: ${argument}`);
  }
  if (
    !values.installDir ||
    !values.runtimeConfig ||
    (values.command === "restore" && !values.fileName)
  ) {
    throw new Error("Restore requires install dir, runtime config, and backup file name.");
  }
  return {
    installDir: path.resolve(values.installDir),
    runtimeConfig: path.resolve(values.runtimeConfig),
    fileName: values.fileName,
  };
}

function stagingConnectionString(operatorConnectionString, database) {
  const url = new URL(operatorConnectionString);
  url.pathname = `/${database}`;
  url.searchParams.set("application_name", "quickhack-restore-security-barrier");
  return url.toString();
}

async function writeBarrierFile(dataDir, value) {
  const directory = path.join(dataDir, "security");
  await serverPlatform.secretProtector.ensureDirectory(directory);
  const target = path.join(directory, RESTORE_BARRIER_FILE_NAME);
  const temporary = path.join(directory, `.${RESTORE_BARRIER_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    payload.fill(0);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return target;
}

function restoreBarrierPath(dataDir) {
  return path.join(dataDir, "security", RESTORE_BARRIER_FILE_NAME);
}

async function readBarrierFile(dataDir) {
  const filePath = restoreBarrierPath(dataDir);
  const stat = await fs.lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024) {
    throw new Error("The PostgreSQL restore cutover marker is invalid.");
  }
  const value = JSON.parse(await fs.readFile(filePath, "utf8"));
  for (const key of ["liveDatabase", "stagingDatabase", "previousDatabase"]) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(String(value[key] ?? ""))) {
      throw new Error("The PostgreSQL restore cutover database identity is invalid.");
    }
  }
  if (
    value.protocol !== RESTORE_BARRIER_PROTOCOL ||
    !Number.isSafeInteger(value.expectedInstanceEpoch) ||
    value.expectedInstanceEpoch <= 0 ||
    !new Set([
      "STAGING_READY",
      "LIVE_RENAMED",
      "DATABASE_ACTIVATED",
      "CUTOVER_COMPLETE",
    ]).has(value.cutoverPhase)
  ) {
    throw new Error("The PostgreSQL restore cutover marker payload is invalid.");
  }
  return { filePath, ...value };
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Unsafe PostgreSQL restore database identifier.");
  }
  return `"${value}"`;
}

async function databaseEpoch(operatorConnectionString, database) {
  const pool = new Pool({
    connectionString: stagingConnectionString(operatorConnectionString, database),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  try {
    const result = await pool.query(`
      SELECT instance_epoch
      FROM server_instance_state
      WHERE singleton_key = 'QUICKHACK'
    `);
    return result.rowCount === 1 ? Number(result.rows[0].instance_epoch) : null;
  } catch (error) {
    if (error?.code === "3D000") return null;
    throw error;
  } finally {
    await pool.end();
  }
}

async function updateCutoverBarrier(dataDir, barrier, cutoverPhase) {
  if (cutoverPhase === "ROLLED_BACK") {
    await fs.rm(barrier.filePath ?? restoreBarrierPath(dataDir), { force: true });
    return;
  }
  await writeBarrierFile(dataDir, {
    protocol: RESTORE_BARRIER_PROTOCOL,
    expectedInstanceEpoch: barrier.expectedInstanceEpoch,
    backupFileName: barrier.backupFileName,
    createdAt: barrier.createdAt,
    liveDatabase: barrier.liveDatabase,
    stagingDatabase: barrier.stagingDatabase,
    previousDatabase: barrier.previousDatabase,
    cutoverPhase,
  });
}

export function planPostgresqlCutoverRecovery({
  expectedInstanceEpoch,
  liveEpoch,
  stagingEpoch,
  previousEpoch,
}) {
  if (liveEpoch === expectedInstanceEpoch) {
    return "COMPLETE_ACTIVATED";
  }
  if (stagingEpoch === expectedInstanceEpoch) {
    if (liveEpoch !== null && previousEpoch !== null) {
      throw new Error("PostgreSQL restore cutover recovery found two previous live databases.");
    }
    return liveEpoch === null
      ? "ACTIVATE_STAGING"
      : "MOVE_LIVE_AND_ACTIVATE_STAGING";
  }
  if (liveEpoch === null && previousEpoch !== null) {
    return "ROLLBACK_PREVIOUS";
  }
  if (liveEpoch !== null && previousEpoch !== null) {
    throw new Error("PostgreSQL restore cutover recovery found an ambiguous previous database.");
  }
  if (liveEpoch !== null) {
    return "DISCARD_STALE_MARKER";
  }
  throw new Error("PostgreSQL restore cutover requires operator review before QuickHack can start.");
}

async function applyStagingSecurityBarrier({
  operatorConnectionString,
  stagingDatabase,
  dataDir,
  fileName,
  runtime,
  liveDatabase,
  previousDatabase,
}) {
  const pool = new Pool({
    connectionString: stagingConnectionString(operatorConnectionString, stagingDatabase),
    application_name: "quickhack-restore-security-barrier",
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  const client = await pool.connect();
  try {
    const migrations = await client.query(`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at
    `);
    const applied = migrations.rows.filter((row) => row.finished_at && !row.rolled_back_at);
    if (applied.length !== 1 || applied[0].migration_name !== SCHEMA_VERSION) {
      throw new Error("The restored database schema does not match this QuickHack release.");
    }
    const invalidConstraints = await client.query(`
      SELECT conname
      FROM pg_catalog.pg_constraint
      WHERE connamespace = current_schema()::regnamespace
        AND NOT convalidated
    `);
    if (invalidConstraints.rowCount !== 0) {
      throw new Error("The restored database contains unvalidated constraints.");
    }
    const prohibitedTables = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [PROHIBITED_TABLES]
    );
    if (prohibitedTables.rowCount !== 0) {
      throw new Error("The restored database contains prohibited legacy tables.");
    }
    const runtimeUser = `"${runtime.database.runtimeUser}"`;
    const backupUser = '"quickhack_backup"';
    await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeUser}, ${backupUser}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeUser}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeUser}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backupUser}`);
    await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${backupUser}`);
    for (const table of APPEND_ONLY_TABLES) {
      await client.query(`REVOKE UPDATE, DELETE ON TABLE "${table}" FROM ${runtimeUser}`);
    }
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE "_prisma_migrations" FROM ${runtimeUser}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${runtimeUser}, ${backupUser}`);
    await client.query("BEGIN");
    const epoch = await client.query(`
      UPDATE server_instance_state
      SET instance_epoch = instance_epoch + 1,
          revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_key = 'QUICKHACK'
      RETURNING instance_epoch
    `);
    if (epoch.rowCount !== 1) {
      throw new Error("The restored server security state is missing.");
    }
    await client.query("DELETE FROM user_sessions");
    await client.query("DELETE FROM mobile_registered_devices");
    await client.query("DELETE FROM user_totp_credentials");
    await client.query("DELETE FROM login_attempts");
    await client.query(`
      UPDATE server_worker_jobs
      SET status = 'IDLE',
          locked_by = NULL,
          lease_token = NULL,
          locked_until = NULL,
          started_at = NULL,
          finished_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'RUNNING'
         OR locked_by IS NOT NULL
         OR lease_token IS NOT NULL
         OR locked_until IS NOT NULL
    `);
    await client.query(`
      UPDATE users
      SET credential_revision = credential_revision + 1,
          revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP
    `);
    await client.query("COMMIT");
    const expectedInstanceEpoch = Number(epoch.rows[0].instance_epoch);
    await writeBarrierFile(dataDir, {
      protocol: RESTORE_BARRIER_PROTOCOL,
      expectedInstanceEpoch,
      backupFileName: fileName,
      createdAt: new Date().toISOString(),
      liveDatabase,
      stagingDatabase,
      previousDatabase,
      cutoverPhase: "STAGING_READY",
    });
    return { expectedInstanceEpoch };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function recoverOperationalPostgresqlCutover(input) {
  const runtime = readServerRuntimeConfigSync({
    configPath: input.runtimeConfig,
    kind: "operational",
  }).config;
  const barrier = await readBarrierFile(runtime.dataDirectory);
  if (!barrier) return { recovered: false, pending: false };
  const operatorConnectionString = resolvePostgresqlConnectionStringSync({
    role: "operator",
    applicationName: "quickhack-restore-cutover-recovery",
  });
  const binDirectory = path.join(input.installDir, "runtime", "postgresql", "bin");
  await inspectPostgresqlToolchain({
    binDirectory,
    capability: "backup",
    processExecution: serverProcessExecution,
  });
  const privateDirectory = path.join(
    runtime.dataDirectory,
    "security",
    "postgresql-operations"
  );
  const sql = (command) => runPostgresqlTool({
    tool: "psql",
    args: ["--dbname", "postgres", "--set", "ON_ERROR_STOP=1", "--command", command],
    connectionString: operatorConnectionString,
    binDirectory,
    privateDirectory,
    processExecution: serverProcessExecution,
  });
  const terminate = (database) =>
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`;
  const [liveEpoch, stagingEpoch, previousEpoch] = await Promise.all([
    databaseEpoch(operatorConnectionString, barrier.liveDatabase),
    databaseEpoch(operatorConnectionString, barrier.stagingDatabase),
    databaseEpoch(operatorConnectionString, barrier.previousDatabase),
  ]);
  const recoveryPlan = planPostgresqlCutoverRecovery({
    expectedInstanceEpoch: barrier.expectedInstanceEpoch,
    liveEpoch,
    stagingEpoch,
    previousEpoch,
  });

  if (recoveryPlan === "COMPLETE_ACTIVATED") {
    if (stagingEpoch !== null) {
      await sql(`DROP DATABASE ${quoteIdentifier(barrier.stagingDatabase)} WITH (FORCE)`);
    }
    if (previousEpoch !== null) {
      await sql(`DROP DATABASE ${quoteIdentifier(barrier.previousDatabase)} WITH (FORCE)`);
    }
    await updateCutoverBarrier(runtime.dataDirectory, barrier, "CUTOVER_COMPLETE");
    return { recovered: true, activated: true };
  }

  if (
    recoveryPlan === "ACTIVATE_STAGING" ||
    recoveryPlan === "MOVE_LIVE_AND_ACTIVATE_STAGING"
  ) {
    if (recoveryPlan === "MOVE_LIVE_AND_ACTIVATE_STAGING") {
      await sql(terminate(barrier.liveDatabase));
      await sql(
        `ALTER DATABASE ${quoteIdentifier(barrier.liveDatabase)} RENAME TO ${quoteIdentifier(barrier.previousDatabase)}`
      );
    }
    await sql(terminate(barrier.stagingDatabase));
    await sql(
      `ALTER DATABASE ${quoteIdentifier(barrier.stagingDatabase)} RENAME TO ${quoteIdentifier(barrier.liveDatabase)}`
    );
    await updateCutoverBarrier(runtime.dataDirectory, barrier, "DATABASE_ACTIVATED");
    await sql(`DROP DATABASE IF EXISTS ${quoteIdentifier(barrier.previousDatabase)} WITH (FORCE)`);
    await updateCutoverBarrier(runtime.dataDirectory, barrier, "CUTOVER_COMPLETE");
    return { recovered: true, activated: true };
  }

  if (recoveryPlan === "ROLLBACK_PREVIOUS") {
    await sql(
      `ALTER DATABASE ${quoteIdentifier(barrier.previousDatabase)} RENAME TO ${quoteIdentifier(barrier.liveDatabase)}`
    );
    await updateCutoverBarrier(runtime.dataDirectory, barrier, "ROLLED_BACK");
    return { recovered: true, activated: false };
  }
  if (recoveryPlan === "DISCARD_STALE_MARKER") {
    await updateCutoverBarrier(runtime.dataDirectory, barrier, "ROLLED_BACK");
    return { recovered: true, activated: false };
  }
  throw new Error("PostgreSQL restore cutover recovery plan is unsupported.");
}

export async function restoreOperationalPostgresqlBackup(input) {
  const runtime = readServerRuntimeConfigSync({
    configPath: input.runtimeConfig,
    kind: "operational",
  }).config;
  const backupDirectory = path.join(runtime.dataDirectory, "backups");
  const privateDirectory = path.join(runtime.dataDirectory, "security", "postgresql-operations");
  const provider = createBackupKeyProvider({
    dataDir: runtime.dataDirectory,
    backupDirectory,
    secretProtector: serverPlatform.secretProtector,
  });
  const keyStatus = await provider.getStatus();
  if (keyStatus.state !== "READY") throw new Error(keyStatus.message);
  const operatorConnectionString = resolvePostgresqlConnectionStringSync({
    role: "operator",
    applicationName: "quickhack-native-restore",
  });
  return restorePostgresqlBackup({
    backupDirectory,
    fileName: input.fileName,
    operatorConnectionString,
    binDirectory: path.join(input.installDir, "runtime", "postgresql", "bin"),
    privateDirectory,
    expectedDatabase: runtime.database.name,
    restoredDatabaseOwner: runtime.database.migratorUser,
    expectedApplicationVersion: packageJson.version,
    expectedSchemaVersion: SCHEMA_VERSION,
    decryptFile: (source, target) =>
      provider.withKey((key) => decryptBackupFile(source, target, key)),
    processExecution: serverProcessExecution,
    onStagingRestored: ({ liveDatabase, stagingDatabase, previousDatabase }) =>
      applyStagingSecurityBarrier({
        operatorConnectionString,
        stagingDatabase,
        dataDir: runtime.dataDirectory,
        fileName: input.fileName,
        runtime,
        liveDatabase,
        previousDatabase,
      }),
    onCutoverPhase: async (state) => {
      const barrier = await readBarrierFile(runtime.dataDirectory);
      if (!barrier) {
        throw new Error("PostgreSQL restore cutover marker disappeared.");
      }
      if (
        barrier.liveDatabase !== state.liveDatabase ||
        barrier.stagingDatabase !== state.stagingDatabase ||
        barrier.previousDatabase !== state.previousDatabase
      ) {
        throw new Error("PostgreSQL restore cutover marker changed ownership.");
      }
      await updateCutoverBarrier(runtime.dataDirectory, barrier, state.phase);
    },
  });
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const input = parseArguments(process.argv.slice(2));
    const result = input.command === "recover-cutover"
      ? await recoverOperationalPostgresqlCutover(input)
      : await restoreOperationalPostgresqlBackup(input);
    console.log(
      input.command === "recover-cutover"
        ? `QuickHack PostgreSQL cutover recovery completed: ${JSON.stringify(result)}`
        : `QuickHack PostgreSQL restore completed: ${result.fileName}`
    );
  } catch (error) {
    console.error(
      `QuickHack PostgreSQL restore failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
