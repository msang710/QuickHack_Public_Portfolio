import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RuntimeConfigService,
} from "../../quickhack_shared/core/runtime-config-service.ts";
import { windowsServerRuntimeDirectories } from "../../quickhack_server/platform/windows/runtime-directories.ts";
import { windowsClientRuntimeDirectories } from "../../quickhack_client/platform/windows/runtime-directories.ts";
import {
  readServerRuntimeConfigSync,
  validateServerRuntimeConfig,
  writeServerRuntimeConfigAtomicSync,
} from "../../quickhack_shared/core/server-runtime-config.mjs";

function loaded(config, configPath = "C:\\ProgramData\\QuickHack\\config\\server-runtime.json") {
  return {
    config,
    location: { kind: "operational", sourceRoot: "", configPath },
    persisted: true,
  };
}

function resolveRuntimeDirectories(input) {
  const provider = input.role === "client"
    ? windowsClientRuntimeDirectories
    : windowsServerRuntimeDirectories;
  return provider.resolve({
    ...input,
    homeDirectory: "C:\\Users\\quickhack-test",
  });
}

const developmentDataDirectory = path.join(
  os.tmpdir(),
  "quickhack-development-data"
);
const productionDataDirectory = path.join(
  os.tmpdir(),
  "quickhack-production-data"
);

const developmentConfig = {
  schemaVersion: 3,
  packageFlavor: "DEMONSTRATION",
  environment: "development",
  coupangWriteApiEnabled: true,
  logenWriteApiEnabled: false,
  dataDirectory: developmentDataDirectory,
  backupRetentionCount: 17,
  database: {
    host: "127.0.0.1",
    port: 5432,
    name: "quickhack",
    runtimeUser: "quickhack_runtime",
    migratorUser: "quickhack_migrator",
    coupangMockName: "quickhack_mock_coupang",
    coupangMockUser: "quickhack_mock_coupang",
    logenMockName: "quickhack_mock_logen",
    logenMockUser: "quickhack_mock_logen",
  },
};
const developmentService = new RuntimeConfigService({
  readServerConfig: () => loaded(developmentConfig),
  resolveRuntimeDirectories,
});
const development = developmentService.read({
  NODE_ENV: "production",
  QUICKHACK_ENV: "production",
  QUICKHACK_DATA_DIR: "D:\\attacker",
  DATABASE_URL: "postgresql://attacker:secret@remote.invalid/attacker",
  COUPANG_API_MODE: "live",
  LOGEN_API_MODE: "live",
  QUICKHACK_WRITE_API_ENABLED: "false",
});

assert.equal(development.environment, "development");
assert.equal(development.packageFlavor, "DEMONSTRATION");
assert.equal(development.production, false);
assert.equal(development.role, "server");
assert.equal(development.policies.coupangWriteApiEnabled, true);
assert.equal(development.policies.logenWriteApiEnabled, false);
assert.equal(development.paths.dataDir, developmentConfig.dataDirectory);
assert.equal(development.database.provider, "postgresql");
assert.equal(development.database.postgresql.host, "127.0.0.1");
assert.equal(development.endpoints.coupang.mode, "mock");
assert.equal(development.endpoints.logen.mode, "mock");
assert.equal(developmentService.getBackupRetentionCount(), 17);

const productionConfig = {
  ...developmentConfig,
  packageFlavor: "OPERATIONAL",
  environment: "production",
  coupangWriteApiEnabled: false,
  logenWriteApiEnabled: true,
  dataDirectory: productionDataDirectory,
  database: {
    host: "127.0.0.1",
    port: 5432,
    name: "quickhack",
    runtimeUser: "quickhack_runtime",
    migratorUser: "quickhack_migrator",
  },
};
const productionService = new RuntimeConfigService({
  readServerConfig: () => loaded(productionConfig),
  resolveRuntimeDirectories,
});
const production = productionService.read({
  QUICKHACK_ENV: "development",
  QUICKHACK_WRITE_API_ENABLED: "true",
  QUICKHACK_DATABASE_PROVIDER: "postgresql",
  QUICKHACK_POSTGRESQL_URL: "postgresql://attacker.invalid/quickhack",
});
assert.equal(production.production, true);
assert.equal(production.packageFlavor, "OPERATIONAL");
assert.equal(production.policies.coupangWriteApiEnabled, false);
assert.equal(production.policies.logenWriteApiEnabled, true);
assert.equal(production.database.provider, "postgresql");
assert.equal(production.database.postgresql.name, "quickhack");
assert.equal(production.endpoints.coupang.mode, "live");

assert.throws(
  () =>
    validateServerRuntimeConfig({
      ...productionConfig,
      database: {
        ...productionConfig.database,
        coupangMockName: "quickhack_mock_coupang",
      },
    }),
  (error) => error?.code === "SERVER_RUNTIME_CONFIG_INVALID"
);
assert.equal(
  validateServerRuntimeConfig({
    ...developmentConfig,
    environment: "production",
    packageFlavor: "DEMONSTRATION",
  }).packageFlavor,
  "DEMONSTRATION"
);

const client = productionService.read({
  QUICKHACK_RUNTIME_ROLE: "client",
  QUICKHACK_ARTIFACT_KIND: "DEMONSTRATION_CLIENT",
  QUICKHACK_SERVER_URL: "https://192.168.0.7:3443/",
  QUICKHACK_APP_ROOT: "C:\\QuickHackClient",
});
assert.equal(client.role, "client");
assert.equal(client.endpoints.remoteServerUrl, "https://192.168.0.7:3443");
assert.equal(client.policies.coupangWriteApiEnabled, false);
assert.equal(client.policies.logenWriteApiEnabled, false);
assert.equal(
  client.paths.stateDir,
  "C:\\Users\\quickhack-test\\AppData\\Local\\QuickHack\\demonstration-client"
);
assert.throws(
  () =>
    productionService.read({
      QUICKHACK_RUNTIME_ROLE: "client",
      QUICKHACK_ARTIFACT_KIND: "DEMONSTRATION_SERVER",
      QUICKHACK_APP_ROOT: "C:\\QuickHackClient",
    }),
  /must identify a client artifact/
);

assert.throws(
  () => validateServerRuntimeConfig({ ...developmentConfig, otpKey: "secret" }),
  (error) => error?.code === "SERVER_RUNTIME_CONFIG_INVALID"
);
assert.throws(
  () =>
    validateServerRuntimeConfig({
      ...developmentConfig,
      coupangApiMode: "mock",
      logenApiMode: "mock",
      writeApiEnabled: true,
    }),
  (error) => error?.code === "SERVER_RUNTIME_CONFIG_INVALID"
);

const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "quickhack-runtime-config-")
);
try {
  const configPath = path.join(temporaryDirectory, "server-runtime.json");
  writeServerRuntimeConfigAtomicSync(configPath, developmentConfig);
  const readBack = readServerRuntimeConfigSync({
    configPath,
    kind: "operational",
  });
  assert.deepEqual(readBack.config, developmentConfig);
  assert.equal(readBack.persisted, true);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverConsoleSource = readFileSync(
  path.join(projectRoot, "tools", "server-console-core.mjs"),
  "utf8"
);
assert.match(serverConsoleSource, /sourceServerRuntimeConfigPath\(root\)/);
assert.match(serverConsoleSource, /\/api\/runtime\/toggle-environment/);
assert.match(serverConsoleSource, /\/api\/runtime\/toggle-coupang-write-api/);
assert.match(serverConsoleSource, /\/api\/runtime\/toggle-logen-write-api/);
assert.match(serverConsoleSource, /id="runtime-environment-toggle"/);
assert.match(serverConsoleSource, /id="coupang-write-api-toggle"/);
assert.match(serverConsoleSource, /id="logen-write-api-toggle"/);
assert.doesNotMatch(serverConsoleSource, /env\.QUICKHACK_ENV\s*=/);
assert.doesNotMatch(serverConsoleSource, /env\.DATABASE_URL\s*=/);
assert.doesNotMatch(serverConsoleSource, /env\.QUICKHACK_QHKEY_ROOT\s*=/);

console.log("Runtime config service checks passed.");
