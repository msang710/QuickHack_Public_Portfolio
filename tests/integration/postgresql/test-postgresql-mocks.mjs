import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  SYNTHETIC_CATALOG_VERSION,
  SYNTHETIC_PRODUCT_COUNT,
  SYNTHETIC_SELLER_PRODUCT_COUNT,
  SYNTHETIC_VENDOR_ITEM_COUNT,
} from "../../../mock_server/coupang-synthetic-catalog.mjs";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";

const { Pool } = pg;
const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDirectory, "..", "..", "..");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function captureOutput(child) {
  const chunks = [];
  const append = (chunk) => {
    chunks.push(String(chunk));
    if (chunks.length > 50) chunks.shift();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => chunks.join("").slice(-8_000).trim();
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Mock exited with ${child.exitCode}.${output() ? `\n${output()}` : ""}`
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Mock health timed out: ${url}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const mainScope = createTemporaryDatabase("quickhack-main-isolation-");
const coupangScope = createTemporaryDatabase("quickhack-coupang-mock-");
const logenScope = createTemporaryDatabase("quickhack-logen-mock-");
const coupangPort = await unusedPort();
const logenPort = await unusedPort();
const commonEnv = { ...process.env, NODE_ENV: "test" };
const coupang = spawn(process.execPath, [
  path.join(projectRoot, "mock_server", "coupang-mock-server.mjs"),
  "--host", "127.0.0.1", "--port", String(coupangPort),
  "--order-interval-ms", "0", "--return-exchange-interval-ms", "0",
], {
  cwd: projectRoot,
  env: { ...commonEnv, QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL: coupangScope.databaseUrl },
  stdio: ["ignore", "pipe", "pipe"],
});
const logen = spawn(process.execPath, [
  path.join(projectRoot, "mock_server", "logen", "server.mjs"),
  "--host", "127.0.0.1", "--port", String(logenPort),
], {
  cwd: projectRoot,
  env: {
    ...commonEnv,
    QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL: logenScope.databaseUrl,
    LOGEN_MOCK_TRACKING_INTERVAL_MS: "0",
    LOGEN_MOCK_RETURN_INTERVAL_MS: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const coupangOutput = captureOutput(coupang);
const logenOutput = captureOutput(logen);

try {
  const [coupangHealth, logenHealth] = await Promise.all([
    waitForHealth(`http://127.0.0.1:${coupangPort}/health`, coupang, coupangOutput),
    waitForHealth(`http://127.0.0.1:${logenPort}/health`, logen, logenOutput),
  ]);
  assert.equal(coupangHealth.database, "postgresql");
  assert.equal(logenHealth.databaseProvider, "postgresql");

  const coupangPool = new Pool({ connectionString: coupangScope.databaseUrl, max: 1 });
  try {
    const catalog = await coupangPool.query(`
      SELECT
        COUNT(*)::int AS item_count,
        COUNT(DISTINCT seller_product_id)::int AS seller_product_count,
        COUNT(DISTINCT product_id)::int AS product_count,
        MIN(current_quantity_snapshot)::int AS min_quantity,
        MAX(current_quantity_snapshot)::int AS max_quantity,
        MIN(average_price_snapshot)::int AS min_price,
        MAX(average_price_snapshot)::int AS max_price
      FROM mock_products
    `);
    assert.deepEqual(catalog.rows[0], {
      item_count: SYNTHETIC_VENDOR_ITEM_COUNT,
      seller_product_count: SYNTHETIC_SELLER_PRODUCT_COUNT,
      product_count: SYNTHETIC_PRODUCT_COUNT,
      min_quantity: 0,
      max_quantity: 0,
      min_price: 0,
      max_price: 0,
    });
    const metadata = await coupangPool.query(`
      SELECT value FROM mock_metadata WHERE key = 'product_catalog_version'
    `);
    assert.equal(metadata.rows[0]?.value, SYNTHETIC_CATALOG_VERSION);
  } finally {
    await coupangPool.end();
  }

  const credentialResponse = await fetch(
    `http://127.0.0.1:${coupangPort}/admin/openapi-credentials/issue`,
    { method: "POST" }
  );
  assert.equal(credentialResponse.status, 201);
  const resetResponse = await fetch(`http://127.0.0.1:${logenPort}/admin/reset`, {
    method: "POST",
  });
  assert.equal(resetResponse.status, 200);

  const mainPool = new Pool({ connectionString: mainScope.databaseUrl, max: 1 });
  try {
    const leaked = await mainPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'mock_%'
    `);
    assert.equal(leaked.rowCount, 0);
  } finally {
    await mainPool.end();
  }
  console.log("Coupang and Logen PostgreSQL mock round-trip and schema isolation verified.");
} finally {
  await Promise.all([stop(coupang), stop(logen)]);
  mainScope.cleanup();
  coupangScope.cleanup();
  logenScope.cleanup();
}
