import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./project-root.mjs";

const supportDirectory = import.meta.dirname;
export { projectRoot };
const scopeCliPath = path.join(supportDirectory, "postgresql-test-scope-cli.mjs");
const activeScopes = new Map();

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runtimeConfig(directory) {
  return {
    schemaVersion: 3,
    packageFlavor: "DEMONSTRATION",
    environment: "development",
    coupangWriteApiEnabled: true,
    logenWriteApiEnabled: true,
    dataDirectory: directory,
    backupRetentionCount: 30,
    database: {
      host: "127.0.0.1",
      port: 5432,
      name: "quickhack_test",
      runtimeUser: "quickhack_test_runtime",
      migratorUser: "quickhack_test_migrator",
      coupangMockName: "quickhack_test_coupang",
      coupangMockUser: "quickhack_test_coupang",
      logenMockName: "quickhack_test_logen",
      logenMockUser: "quickhack_test_logen",
    },
  };
}

function runScopeCommand(args) {
  const result = spawnSync(process.execPath, [scopeCliPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "test" },
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
  return String(result.stdout || "").trim();
}

export function createTemporaryDatabase(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtimeConfigPath = path.join(directory, "server-runtime.json");
  writeFileSync(
    runtimeConfigPath,
    `${JSON.stringify(runtimeConfig(directory), null, 2)}\n`,
    "utf8"
  );

  let created;
  try {
    created = JSON.parse(runScopeCommand(["create", prefix]));
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const scope = {
    directory,
    databaseUrl: created.databaseUrl,
    schema: created.schema,
    runtimeConfigPath,
    cleanup() {
      activeScopes.delete(created.databaseUrl);
      try {
        runScopeCommand(["drop", created.schema]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
  activeScopes.set(scope.databaseUrl, scope);
  return scope;
}

export function configureIntegrationTestEnvironment(databaseUrl) {
  const scope = activeScopes.get(databaseUrl);
  if (!scope) {
    throw new Error(
      "Integration tests must use a PostgreSQL scope created by createTemporaryDatabase()."
    );
  }
  const existingArgumentIndex = process.argv.indexOf("--runtime-config");
  if (existingArgumentIndex >= 0) process.argv.splice(existingArgumentIndex, 2);
  process.argv.push("--runtime-config", scope.runtimeConfigPath);
  process.env.NODE_ENV = "test";
  process.env.QUICKHACK_TEST_DATABASE_URL = databaseUrl;
  process.env.QUICKHACK_TEST_MIGRATOR_DATABASE_URL = databaseUrl;
  process.env.QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL = databaseUrl;
  process.env.QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL = databaseUrl;
  delete process.env.QUICKHACK_RUNTIME_ROLE;
}

export function assertTemporaryDatabaseScope(databaseUrl) {
  if (!activeScopes.has(databaseUrl)) {
    throw new Error(
      "Test accounts may only be created in a temporary PostgreSQL scope."
    );
  }
}
