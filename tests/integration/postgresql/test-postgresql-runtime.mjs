import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_RUNTIME_CONFIG_SCHEMA_VERSION,
  defaultSourceServerRuntimeConfig,
  validateServerRuntimeConfig,
} from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { RuntimeConfigService } from "../../../quickhack_shared/core/runtime-config-service.ts";
import { windowsServerRuntimeDirectories } from "../../../quickhack_server/platform/windows/runtime-directories.ts";
import { resolvePostgresqlConnectionStringSync } from "../../../quickhack_server/core/database/postgresql-credential.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = defaultSourceServerRuntimeConfig(projectRoot);
assert.equal(config.schemaVersion, SERVER_RUNTIME_CONFIG_SCHEMA_VERSION);
assert.equal(config.database.host, "127.0.0.1");
assert.throws(() => validateServerRuntimeConfig({ ...config, schemaVersion: 1 }));
assert.throws(() =>
  validateServerRuntimeConfig({ ...config, databaseProvider: "postgresql" })
);

const service = new RuntimeConfigService({
  readServerConfig: () => ({
    config,
    location: { kind: "source", sourceRoot: projectRoot, configPath: "test" },
    persisted: true,
  }),
  resolveRuntimeDirectories: (input) =>
    windowsServerRuntimeDirectories.resolve({
      ...input,
      homeDirectory: "C:\\Users\\quickhack-test",
    }),
});
const runtime = service.read({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://attacker:attacker@remote.invalid/attacker",
  QUICKHACK_DATABASE_PROVIDER: "attacker",
});
assert.equal(runtime.database.provider, "postgresql");
assert.equal(runtime.database.postgresql.host, "127.0.0.1");

const testUrl = "postgresql://test:test@127.0.0.1:5432/test";
assert.equal(
  resolvePostgresqlConnectionStringSync({
    role: "runtime",
    env: { NODE_ENV: "test", QUICKHACK_TEST_DATABASE_URL: testUrl },
  }),
  testUrl
);
assert.throws(() =>
  resolvePostgresqlConnectionStringSync({
    role: "runtime",
    env: { NODE_ENV: "production", QUICKHACK_TEST_DATABASE_URL: testUrl },
  })
);
console.log("PostgreSQL runtime configuration and test-only connection boundary verified.");
