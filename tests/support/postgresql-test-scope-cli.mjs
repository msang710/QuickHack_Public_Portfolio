import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import path from "node:path";
import { projectRoot } from "./project-root.mjs";

const { Pool } = pg;

function baseConnectionString() {
  const value = String(
    process.env.QUICKHACK_TEST_ADMIN_DATABASE_URL ||
      process.env.QUICKHACK_TEST_DATABASE_URL ||
      ""
  ).trim();
  if (!value) {
    throw new Error(
      "PostgreSQL integration tests require QUICKHACK_TEST_ADMIN_DATABASE_URL or QUICKHACK_TEST_DATABASE_URL."
    );
  }
  return value;
}

function identifier(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^qh_test_[a-z0-9_]{1,54}$/.test(normalized)) {
    throw new Error("Invalid QuickHack PostgreSQL test schema identifier.");
  }
  return normalized;
}

function scopedConnectionString(baseUrl, schema) {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

function migrationCommand(scopedUrl) {
  const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      QUICKHACK_TEST_MIGRATOR_DATABASE_URL: scopedUrl,
      QUICKHACK_TEST_DATABASE_URL: scopedUrl,
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr, result.error?.message]
        .filter(Boolean)
        .join("\n")
    );
  }
}

async function createScope(prefix) {
  const safePrefix = String(prefix || "suite")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  const schema = identifier(
    `qh_test_${safePrefix || "suite"}_${process.pid}_${crypto.randomBytes(6).toString("hex")}`
  );
  const baseUrl = baseConnectionString();
  const pool = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await pool.end();
  }

  const scopedUrl = scopedConnectionString(baseUrl, schema);
  try {
    migrationCommand(scopedUrl);
  } catch (error) {
    const cleanupPool = new Pool({ connectionString: baseUrl, max: 1 });
    try {
      await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanupPool.end();
    }
    throw error;
  }

  process.stdout.write(`${JSON.stringify({ schema, databaseUrl: scopedUrl })}\n`);
}

async function dropScope(schemaInput) {
  const schema = identifier(schemaInput);
  const pool = new Pool({ connectionString: baseConnectionString(), max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

const [command, value] = process.argv.slice(2);
if (command === "create") {
  await createScope(value);
} else if (command === "drop") {
  await dropScope(value);
} else {
  throw new Error("Expected create <prefix> or drop <schema>.");
}
