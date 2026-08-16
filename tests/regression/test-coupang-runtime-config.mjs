import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCoupangWriteAllowed,
  getCoupangRuntimeConfig,
} from "../../quickhack_server/sales-channel/coupang/config.ts";
import {
  activateTestServerRuntimeConfig,
  writeTestServerRuntimeConfig,
} from "../support/runtime-config-file.mjs";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDirectory, "..", "..");
const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "quickhack-coupang-runtime-")
);
const runtimeConfigPath = writeTestServerRuntimeConfig(temporaryDirectory);
activateTestServerRuntimeConfig(runtimeConfigPath);
const { getLogenRuntimeConfig } = await import(
  "../../quickhack_server/shipment/carrier-integration/logen/config.ts"
);
const operationalDatabase = Object.freeze({
  host: "127.0.0.1",
  port: 5432,
  name: "quickhack_test",
  runtimeUser: "quickhack_test_runtime",
  migratorUser: "quickhack_test_migrator",
});

try {
  process.env.COUPANG_API_MODE = "live";
  process.env.QUICKHACK_WRITE_API_ENABLED = "false";
  let config = getCoupangRuntimeConfig();
  assert.equal(config.mode, "mock");
  assert.equal(config.writeApiEnabled, true);
  assert.equal(config.httpTimeoutMs, 90_000);
  assert.doesNotThrow(() => assertCoupangWriteAllowed("Mock write"));

  writeTestServerRuntimeConfig(temporaryDirectory, {
    environment: "production",
  });
  config = getCoupangRuntimeConfig();
  assert.equal(config.mode, "mock");

  writeTestServerRuntimeConfig(temporaryDirectory, {
    packageFlavor: "OPERATIONAL",
    environment: "production",
    coupangWriteApiEnabled: false,
    database: operationalDatabase,
  });
  config = getCoupangRuntimeConfig();
  assert.equal(config.mode, "live");
  assert.equal(config.writeApiEnabled, false);
  assert.equal(getLogenRuntimeConfig().writeApiEnabled, true);
  assert.throws(
    () => assertCoupangWriteAllowed("Live write"),
    /Coupang/
  );

  process.env.COUPANG_WRITE_ORDER_ALLOWLIST = "ORDER-1, ORDER-2";
  process.env.COUPANG_WRITE_VENDOR_ITEM_ALLOWLIST =
    "900000000001,900000000002";
  process.env.COUPANG_HTTP_TIMEOUT_MS = "1";
  process.env.LOGEN_HTTP_TIMEOUT_MS = "1";
  process.env.LOGEN_HTTP_RETRY_COUNT = "99";
  writeTestServerRuntimeConfig(temporaryDirectory, {
    packageFlavor: "OPERATIONAL",
    environment: "production",
    coupangWriteApiEnabled: true,
    logenWriteApiEnabled: false,
    database: operationalDatabase,
  });
  config = getCoupangRuntimeConfig();
  assert.equal(config.writeApiEnabled, true);
  assert.equal(getLogenRuntimeConfig().writeApiEnabled, false);
  assert.equal(config.httpTimeoutMs, 90_000);
  assert.equal(getLogenRuntimeConfig().timeoutMs, 30_000);
  assert.equal(getLogenRuntimeConfig().readRetryCount, 2);
  assert.doesNotThrow(() => assertCoupangWriteAllowed("Live order write"));
  assert.doesNotThrow(() => assertCoupangWriteAllowed("Live inventory write"));

  const serverConsoleSource = readFileSync(
    path.join(projectRoot, "tools", "server-console-core.mjs"),
    "utf8"
  );
  assert.match(serverConsoleSource, /function childEnvironment/);
  assert.doesNotMatch(serverConsoleSource, /COUPANG_API_MODE\s*:/);
  assert.doesNotMatch(serverConsoleSource, /COUPANG_MOCK_SERVER_URL\s*:/);
  assert.doesNotMatch(serverConsoleSource, /QUICKHACK_ENV\s*:/);
  assert.doesNotMatch(serverConsoleSource, /QUICKHACK_WRITE_API_ENABLED\s*:/);

  console.log("Coupang runtime write configuration checks passed.");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
