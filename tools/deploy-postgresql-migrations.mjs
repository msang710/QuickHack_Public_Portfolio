// QuickHack note: 서버 소유 migrator 자격 증명으로 PostgreSQL migration을 직렬 적용합니다.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";
import { serverRuntimeConfigService as runtimeConfigService } from "../quickhack_server/platform/server-runtime.ts";

const { Pool } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaCli = path.join(rootDir, "node_modules", "prisma", "build", "index.js");
const MIGRATION_LOCK_KEY = 1_894_475_101;
const APPEND_ONLY_TABLES = [
  "domain_audit_events",
  "domain_audit_event_changes",
  "employee_activity_logs",
  "employee_activity_log_changes",
];

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Unsafe PostgreSQL role identifier.");
  }
  return `"${value}"`;
}

async function grantApplicationPrivileges(client) {
  const runtime = runtimeConfigService.read();
  const runtimeUser = runtime.database.postgresql.runtimeUser;
  const backupUser = "quickhack_backup";
  const roles = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
    [[runtimeUser, backupUser]]
  );
  if (roles.rowCount !== 2) {
    if (String(process.env.NODE_ENV || "") === "test") return;
    throw new Error("QuickHack PostgreSQL runtime and backup roles are not provisioned.");
  }
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(runtimeUser)}, ${quoteIdentifier(backupUser)}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(runtimeUser)}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(runtimeUser)}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(backupUser)}`);
  await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(backupUser)}`);
  for (const table of APPEND_ONLY_TABLES) {
    await client.query(`REVOKE UPDATE, DELETE ON TABLE ${quoteIdentifier(table)} FROM ${quoteIdentifier(runtimeUser)}`);
  }
  await client.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE "_prisma_migrations" FROM ${quoteIdentifier(runtimeUser)}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${quoteIdentifier(runtimeUser)}, ${quoteIdentifier(backupUser)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdentifier(runtimeUser)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quoteIdentifier(runtimeUser)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdentifier(backupUser)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${quoteIdentifier(backupUser)}`);
}

function runPrismaMigrateDeploy(runtimeConfigPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: rootDir,
      env: {
        ...process.env,
        QUICKHACK_PRISMA_RUNTIME_CONFIG_PATH: path.resolve(runtimeConfigPath),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error([stdout, stderr].filter(Boolean).join("\n")));
    });
  });
}

export async function deployPostgresqlMigrations() {
  const runtime = runtimeConfigService.read();
  const runtimeConfigPath = runtime.serverConfig?.configPath;
  if (!runtimeConfigPath) {
    throw new Error("PostgreSQL migration requires a server runtime configuration path.");
  }
  const connectionString = resolvePostgresqlConnectionStringSync({
    role: "migrator",
    applicationName: "quickhack-migration-lock",
    runtimeConfigPath,
  });
  const pool = new Pool({
    connectionString,
    application_name: "quickhack-migration-lock",
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 60_000,
  });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const result = await runPrismaMigrateDeploy(runtimeConfigPath);
    await grantApplicationPrivileges(client);
    return result;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await deployPostgresqlMigrations();
    const summary = [result.stdout, result.stderr]
      .join("\n")
      .split(/\r?\n/)
      .filter((line) => /migration|applied|database schema is up to date/i.test(line));
    console.log(summary.join("\n") || "PostgreSQL migrations applied.");
  } catch (error) {
    console.error(
      `PostgreSQL migration failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
