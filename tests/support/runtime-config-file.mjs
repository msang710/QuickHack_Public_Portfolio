import { writeFileSync } from "node:fs";
import path from "node:path";

export function writeTestServerRuntimeConfig(dataDirectory, overrides = {}) {
  const configPath = path.join(dataDirectory, "server-runtime.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        packageFlavor: "DEMONSTRATION",
        environment: "development",
        coupangWriteApiEnabled: true,
        logenWriteApiEnabled: true,
        dataDirectory,
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
        ...overrides,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return configPath;
}

export function runtimeConfigArguments(configPath) {
  return ["--runtime-config", configPath];
}

export function activateTestServerRuntimeConfig(configPath) {
  const existingIndex = process.argv.indexOf("--runtime-config");
  if (existingIndex >= 0) process.argv.splice(existingIndex, 2);
  process.argv.push(...runtimeConfigArguments(configPath));
  process.env.NODE_ENV = "test";
  delete process.env.QUICKHACK_RUNTIME_ROLE;
}
