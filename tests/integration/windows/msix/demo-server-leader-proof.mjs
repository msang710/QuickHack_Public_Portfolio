import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../../../../quickhack_server/core/database/postgresql-credential.mjs";
import { verifyPassword } from "../../../../tools/password.mjs";

const { Pool } = pg;
const INPUT_MAX_BYTES = 4 * 1024;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > INPUT_MAX_BYTES) throw new Error("LEADER_PROOF_INPUT_INVALID");
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  const input = JSON.parse(source);
  const oldPassword = String(input?.oldPassword ?? "");
  const newPassword = String(input?.newPassword ?? "");
  const expectedUserId = Number(input?.expectedUserId);
  const expectedGeneration = Number(input?.expectedGeneration);
  if (
    !/^[A-Za-z0-9_-]{32,128}$/u.test(oldPassword) ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(newPassword) ||
    oldPassword === newPassword ||
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId < 1 ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 2
  ) {
    throw new Error("LEADER_PROOF_INPUT_INVALID");
  }
  return { oldPassword, newPassword, expectedUserId, expectedGeneration };
}

async function main() {
  const runtimeConfigPath = argumentValue("--runtime-config");
  if (!runtimeConfigPath) throw new Error("LEADER_PROOF_RUNTIME_CONFIG_REQUIRED");
  const input = await readInput();
  const pool = new Pool({
    connectionString: resolvePostgresqlConnectionStringSync({
      role: "migrator",
      applicationName: "quickhack-msix-leader-proof",
      runtimeConfigPath,
    }),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  try {
    const result = await pool.query(
      `SELECT user_id, username, password_hash, role, must_change_password,
              is_active, credential_revision
       FROM users
       ORDER BY user_id`
    );
    const row = result.rows[0];
    const oldValid = row
      ? await verifyPassword(input.oldPassword, row.password_hash)
      : false;
    const newValid = row
      ? await verifyPassword(input.newPassword, row.password_hash)
      : false;
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      userCount: result.rowCount,
      userId: Number(row?.user_id ?? 0),
      username: String(row?.username ?? ""),
      role: String(row?.role ?? ""),
      mustChangePassword: Number(row?.must_change_password ?? 0),
      isActive: Number(row?.is_active ?? 0),
      credentialRevision: Number(row?.credential_revision ?? -1),
      expectedUserId: input.expectedUserId,
      expectedGeneration: input.expectedGeneration,
      oldValid,
      newValid,
    })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write("errorCode=LEADER_PROOF_FAILED\n");
  process.exitCode = 1;
});
