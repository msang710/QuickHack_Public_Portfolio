import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

assert.equal(
  existsSync(path.join(root, ".env.example")),
  false,
  "The removed user-configurable .env.example contract was restored."
);

const forbiddenByFile = new Map([
  [
    "quickhack_server/sales-channel/coupang/config.ts",
    [
      "COUPANG_SYNC_ENABLED",
      "COUPANG_SYNC_INTERVAL_SECONDS",
      "COUPANG_SYNC_LOOKBACK_MINUTES",
      "COUPANG_HTTP_TIMEOUT_MS",
      "COUPANG_WRITE_ORDER_ALLOWLIST",
      "COUPANG_WRITE_VENDOR_ITEM_ALLOWLIST",
      "requiresWriteAllowlist",
    ],
  ],
  ["quickhack_server/sales-channel/coupang/api-client.ts", ["COUPANG_HTTP_RETRY_COUNT"]],
  [
    "quickhack_server/sales-channel/coupang/write-verification-service.ts",
    [
      "COUPANG_WRITE_VERIFY_OBSERVATION_ATTEMPTS",
      "COUPANG_WRITE_VERIFY_OBSERVATION_DELAY_MS",
      "COUPANG_WRITE_VERIFY_CONCURRENCY",
    ],
  ],
  [
    "quickhack_server/shipment/carrier-integration/logen/config.ts",
    ["LOGEN_HTTP_TIMEOUT_MS", "LOGEN_HTTP_RETRY_COUNT"],
  ],
  [
    "quickhack_server/shipment/carrier-integration/logen/tracking-sync-service.ts",
    ["LOGEN_TRACKING_BATCH_SIZE", "LOGEN_TRACKING_REFRESH_SECONDS"],
  ],
  [
    "quickhack_server/workers/manager.ts",
    ["QUICKHACK_WORKER_MANAGER_ENABLED", "QUICKHACK_WORKER_POLL_SECONDS"],
  ],
  [
    "quickhack_server/observability/operation-trace.ts",
    ["QUICKHACK_PERFORMANCE_TRACE_SAMPLE_RATE"],
  ],
  [
    "quickhack_shared/core/runtime-config-service.ts",
    ["QUICKHACK_ADB_PATH"],
  ],
  [
    "quickhack_client/adb/adb.ts",
    ["QUICKHACK_ADB_PATH", "found || \"adb\"", "fs.existsSync"],
  ],
  [
    "tools/client-runtime-launcher.mjs",
    [
      "process.env.QUICKHACK_CLIENT_PORT",
      "process.env.QUICKHACK_SERVER_URL",
      "process.env.QUICKHACK_CA_CERT_FILE",
      "process.env.QUICKHACK_CLIENT_SERVER_ENTRY",
      "client-url.txt",
    ],
  ],
  [
    "tools/server-console.mjs",
    [
      "process.env.QUICKHACK_HTTPS_HOST",
      "process.env.QUICKHACK_HTTPS_PORT",
      "process.env.QUICKHACK_SHUTDOWN_GRACE_MS",
      "process.env.COUPANG_MOCK_DB_PATH",
      "process.env.LOGEN_MOCK_DB_PATH",
    ],
  ],
  [
    "packaging/windows-launcher/QuickHackLauncher.cs",
    [
      "QUICKHACK_CLIENT_PORT",
      "QUICKHACK_SERVER_HOST",
      "COUPANG_MOCK_DB_PATH",
      "COUPANG_MOCK_PRODUCT_CSV_PATH",
    ],
  ],
  [
    "mock_server/coupang-mock-server.mjs",
    [
      "COUPANG_MOCK_SERVER_HOST",
      "COUPANG_MOCK_SERVER_PORT",
      "COUPANG_MOCK_DB_PATH",
      "COUPANG_MOCK_PRODUCT_CSV_PATH",
    ],
  ],
  [
    "mock_server/logen/config.mjs",
    ["LOGEN_MOCK_SERVER_HOST", "LOGEN_MOCK_SERVER_PORT", "LOGEN_MOCK_DB_PATH"],
  ],
]);

for (const [relativePath, forbiddenValues] of forbiddenByFile) {
  const source = read(relativePath);
  for (const forbidden of forbiddenValues) {
    assert.equal(
      source.includes(forbidden),
      false,
      `${relativePath} restored removed runtime input ${forbidden}.`
    );
  }
}

const packageSource = read("packaging/create-staging-package.mjs");
const packageManifest = read("packaging/demo-build.manifest.json");
assert.doesNotMatch(packageSource, /\.env\.example/);
assert.doesNotMatch(packageManifest, /\.env\.example/);
assert.match(packageSource, /client-runtime-config\.mjs/);
assert.match(packageManifest, /client-runtime-config\.mjs/);

console.log("Runtime environment input removal contract verified.");
