// QuickHack note: migration 이후 비어 있는 PostgreSQL DB에 최초 LEADER를 한 번만 생성합니다.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";
import { hashPassword } from "./password.mjs";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";

const { Pool } = pg;
const INITIAL_LEADER_LOCK_KEY = 1_894_475_102;
export const INITIAL_LEADER_RESULT_PROTOCOL =
  "QUICKHACK_INITIAL_LEADER_RESULT_V1";
export const INITIAL_LEADER_USERNAME = "admin";
export const INITIAL_LEADER_DISPLAY_NAME = "관리자";

function resultLines(input) {
  const lines = [INITIAL_LEADER_RESULT_PROTOCOL, `status=${input.status}`];
  if (input.status === "CREATED") {
    lines.push(
      `userId=${input.userId}`,
      `username=${INITIAL_LEADER_USERNAME}`,
      `temporaryPassword=${input.temporaryPassword}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeResultFile(resultPath, input) {
  let descriptor;
  let fileCreated = false;
  try {
    descriptor = openSync(resultPath, "wx", 0o600);
    fileCreated = true;
    writeFileSync(descriptor, resultLines(input), { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    if (fileCreated) {
      try {
        unlinkSync(resultPath);
      } catch {}
    }
    throw error;
  }
}

function removeCreatedResult(resultPath) {
  try {
    unlinkSync(resultPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function provisioningConnectionString(explicitConnectionString) {
  if (explicitConnectionString) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Explicit PostgreSQL provisioning connection is test-only.");
    }
    return explicitConnectionString;
  }
  return resolvePostgresqlConnectionStringSync({
    role: "runtime",
    applicationName: "quickhack-initial-leader",
  });
}

export async function provisionInitialLeader({
  resultPath,
  allowCreate,
  connectionString = "",
}) {
  const resolvedResultPath = path.resolve(resultPath);
  if (existsSync(resolvedResultPath)) {
    throw new Error("Initial leader result file already exists.");
  }

  const temporaryPassword = allowCreate
    ? randomBytes(24).toString("base64url")
    : null;
  const passwordHash = temporaryPassword
    ? await hashPassword(temporaryPassword)
    : null;
  const pool = new Pool({
    connectionString: provisioningConnectionString(connectionString),
    application_name: "quickhack-initial-leader",
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  const client = await pool.connect();
  let resultFileCreated = false;

  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      INITIAL_LEADER_LOCK_KEY,
    ]);
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const countResult = await client.query("SELECT COUNT(*) AS count FROM users");
    const userCount = BigInt(countResult.rows[0]?.count ?? "0");

    if (userCount > 0n) {
      await client.query("COMMIT");
      writeResultFile(resolvedResultPath, { status: "ALREADY_INITIALIZED" });
      return { status: "ALREADY_INITIALIZED" };
    }

    if (!allowCreate || !temporaryPassword || !passwordHash) {
      await client.query("ROLLBACK");
      writeResultFile(resolvedResultPath, { status: "INTERACTION_REQUIRED" });
      return { status: "INTERACTION_REQUIRED" };
    }

    const inserted = await client.query(
      `INSERT INTO users (
         username, password_hash, must_change_password, role,
         is_developer, mobile_packing_enabled, is_active
       ) VALUES ($1, $2, 1, 'LEADER', 0, 0, 1)
       RETURNING user_id`,
      [INITIAL_LEADER_USERNAME, passwordHash]
    );
    const userId = inserted.rows[0].user_id;
    await client.query(
      `INSERT INTO employee_profiles (user_id, display_name)
       VALUES ($1, $2)`,
      [userId, INITIAL_LEADER_DISPLAY_NAME]
    );

    writeResultFile(resolvedResultPath, {
      status: "CREATED",
      userId,
      temporaryPassword,
    });
    resultFileCreated = true;
    await client.query("COMMIT");
    return { status: "CREATED", userId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (resultFileCreated) removeCreatedResult(resolvedResultPath);
    throw error;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [INITIAL_LEADER_LOCK_KEY])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

function parseArguments(argv) {
  let resultPath = "";
  let allowCreate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-create") {
      allowCreate = true;
    } else if (argument === "--result-file") {
      resultPath = argv[++index] || "";
    } else if (argument === "--runtime-config") {
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  if (!resultPath) throw new Error("--result-file is required.");
  return { allowCreate, resultPath };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = path.normalize(fileURLToPath(import.meta.url));
  const invokedPath = path.normalize(path.resolve(process.argv[1]));
  return composeOperatorPlatform().processExecution.sameExecutablePath(
    modulePath,
    invokedPath
  );
}

if (isMainModule()) {
  try {
    const result = await provisionInitialLeader(
      parseArguments(process.argv.slice(2))
    );
    console.log(`INITIAL_LEADER_PROVISIONING=${result.status}`);
    if (result.status === "INTERACTION_REQUIRED") process.exitCode = 2;
  } catch (error) {
    console.error(
      `Initial leader provisioning failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
