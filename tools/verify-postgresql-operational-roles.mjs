import assert from "node:assert/strict";
import path from "node:path";
import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";
import { readServerRuntimeConfigSync } from "../quickhack_shared/core/server-runtime-config.mjs";
import { createPostgresqlPackageManifest } from "../quickhack_shared/core/package-flavor-contract.mjs";

const { Pool } = pg;
const runtimeConfigIndex = process.argv.indexOf("--runtime-config");
const runtimeConfigPath =
  runtimeConfigIndex >= 0 ? String(process.argv[runtimeConfigIndex + 1] ?? "") : "";
const runtimeConfig = readServerRuntimeConfigSync(
  runtimeConfigPath
    ? { configPath: runtimeConfigPath, kind: "operational" }
    : undefined
).config;
const manifest = createPostgresqlPackageManifest(runtimeConfig);

async function withRole(role, operation) {
  const pool = new Pool({
    connectionString: resolvePostgresqlConnectionStringSync({
      role,
      applicationName: `quickhack-operational-role-smoke-${role}`,
      ...(runtimeConfigPath ? { runtimeConfigPath } : {}),
    }),
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

await withRole("operator", async (pool) => {
  const roles = await pool.query(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'quickhack_%' ORDER BY rolname"
  );
  assert.deepEqual(
    roles.rows.map((row) => row.rolname),
    manifest.roles.map((role) => role.user).sort()
  );
  const databases = await pool.query(
    "SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE 'quickhack_mock_%' ORDER BY datname",
    [runtimeConfig.database.name]
  );
  assert.deepEqual(
    databases.rows.map((row) => row.datname),
    manifest.databases.map((database) => database.name).sort()
  );

  for (const database of manifest.databases) {
    const publicConnect = await pool.query(
      `SELECT EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(
          (SELECT datacl FROM pg_database WHERE datname = $1),
          acldefault('d', (SELECT datdba FROM pg_database WHERE datname = $1))
        ))
        WHERE grantee = 0 AND privilege_type = 'CONNECT'
      ) AS allowed`,
      [database.name]
    );
    assert.equal(publicConnect.rows[0]?.allowed, false);
  }

  for (const role of manifest.roles) {
    for (const database of manifest.databases) {
      const privilege = await pool.query(
        "SELECT has_database_privilege($1, $2, 'CONNECT') AS allowed",
        [role.user, database.name]
      );
      const expected =
        role.kind === "operator" ||
        (database.kind === "main" &&
          ["migrator", "runtime", "backup"].includes(role.kind)) ||
        database.ownerRole === role.kind;
      assert.equal(
        privilege.rows[0]?.allowed,
        expected,
        `${role.kind} CONNECT ${database.kind}`
      );
    }
  }

  const mainDatabase = manifest.databases.find((database) => database.kind === "main");
  for (const role of manifest.roles) {
    const privilege = await pool.query(
      "SELECT has_database_privilege($1, $2, 'CREATE') AS allowed",
      [role.user, mainDatabase.name]
    );
    assert.equal(
      privilege.rows[0]?.allowed,
      role.kind === "operator" || role.kind === "migrator",
      `${role.kind} CREATE main`
    );
  }
});

async function assertPermissionDenied(pool, sql) {
  await assert.rejects(
    pool.query(sql),
    (error) => error?.code === "42501",
    `Expected PostgreSQL permission denial for: ${sql}`
  );
}

await withRole("runtime", async (pool) => {
  await pool.query("SELECT singleton_key FROM server_instance_state LIMIT 1");
  await pool.query('SELECT migration_name FROM "_prisma_migrations" LIMIT 1');
  await assertPermissionDenied(
    pool,
    "CREATE TABLE public.quickhack_runtime_ddl_probe (id integer)"
  );
  await assertPermissionDenied(
    pool,
    "CREATE SCHEMA quickhack_runtime_schema_probe"
  );
  await assertPermissionDenied(
    pool,
    "UPDATE domain_audit_events SET event_type = event_type WHERE false"
  );
  await assertPermissionDenied(
    pool,
    'UPDATE "_prisma_migrations" SET migration_name = migration_name WHERE false'
  );
});

await withRole("backup", async (pool) => {
  await pool.query("SELECT singleton_key FROM server_instance_state LIMIT 1");
  await pool.query("SELECT last_value FROM users_user_id_seq");
  await assertPermissionDenied(
    pool,
    "UPDATE users SET username = username WHERE false"
  );
});

console.log(
  `PostgreSQL ${manifest.flavor.toLowerCase()} role identities, catalog, CONNECT matrix, and main least-privilege roles verified (${path.basename(process.argv[1])}).`
);
