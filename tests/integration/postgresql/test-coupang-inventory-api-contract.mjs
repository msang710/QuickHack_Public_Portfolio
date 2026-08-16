import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issueMockCoupangCredential } from "../../../tools/mock-coupang-credential-client.mjs";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startMockServer() {
  const port = await availablePort();
  const databaseScope = createTemporaryDatabase("mock-inventory-");
  const child = spawn(
    process.execPath,
    [
      path.join(rootDir, "mock_server", "coupang-mock-server.mjs"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--order-interval-ms",
      "0",
      "--return-exchange-interval-ms",
      "0",
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL: databaseScope.databaseUrl,
        COUPANG_MOCK_FAILURE_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Mock server exited before startup. ${stderr}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return { child, databaseScope, baseUrl };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill();
  databaseScope.cleanup();
  throw new Error(`Mock server did not become ready. ${stderr}`);
}

function signedDate() {
  const iso = new Date().toISOString();
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function credentialContext(baseUrl, credential, observedMethods) {
  return {
    freshness: "FORCE_FRESH_WRITE",
    context: {
      channel: "COUPANG",
      providerType: "USB_QHKEY",
      status: "ACTIVE",
      keyAlias: "inventory-contract-test",
      keyFingerprint: "test-fingerprint",
      expiresAt: null,
      readEnabled: true,
      writeEnabled: true,
      lastVerifiedAt: null,
      warningMessage: null,
      errorMessage: null,
      mode: "mock",
      apiHost: baseUrl,
      vendorId: credential.vendorId,
      timeoutMs: 100,
    },
    sign(input) {
      observedMethods.push(input.method);
      const date = signedDate();
      const message = `${date}${input.method}${input.path}${input.query}`;
      const signature = crypto
        .createHmac("sha256", credential.secretKey)
        .update(message)
        .digest("hex");

      return {
        authorization: `CEA algorithm=HmacSHA256, access-key=${credential.accessKey}, signed-date=${date}, signature=${signature}`,
        providerType: "USB_QHKEY",
        keyAlias: "inventory-contract-test",
        keyFingerprint: "test-fingerprint",
        authStatus: "SUCCEEDED",
        warningMessage: null,
      };
    },
  };
}

async function setFailurePolicy(baseUrl, patch) {
  const response = await fetch(`${baseUrl}/admin/failure-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      target: "inventory",
      randomFailureRate: 0,
      serverErrorRate: 0,
      rateLimitRate: 0,
      teapotRate: 0,
      httpFailureRate: 0,
      timeoutRate: 0,
      responseDelayRate: 0,
      malformedJsonRate: 0,
      missingRequiredFieldRate: 0,
      partialDataLossRate: 0,
      writeAppliedResponseFailureRate: 0,
      ...patch,
    }),
  });
  assert.equal(response.status, 200);
}

const managed = await startMockServer();
let database;

try {
  const credential = await issueMockCoupangCredential({ baseUrl: managed.baseUrl });
  const reset = await fetch(`${managed.baseUrl}/admin/reset?orderCount=1`, {
    method: "POST",
  });
  assert.equal(reset.status, 200);
  database = openPostgresqlTestDatabase(managed.databaseScope.databaseUrl);
  const product = await database
    .prepare(
      "SELECT vendor_item_id, current_quantity_snapshot FROM mock_products ORDER BY source_row_index LIMIT 1"
    )
    .get();
  assert(product?.vendor_item_id);

  const observedMethods = [];
  const context = credentialContext(managed.baseUrl, credential, observedMethods);
  const {
    CoupangApiResponseError,
    CoupangInventoryPayloadError,
    getCoupangVendorItemInventory,
    updateCoupangVendorItemQuantity,
  } = await import("@/quickhack_server/sales-channel/coupang/api-client");
  const id = String(product.vendor_item_id);
  const normal = await getCoupangVendorItemInventory(id, context, {
    retryCount: 0,
  });
  assert.equal(normal.payload.vendorItemId, id);
  assert.equal(normal.payload.amountInStock, product.current_quantity_snapshot);
  assert.equal(normal.httpStatusCode, 200);
  assert.match(normal.requestPath, /\/vendor-items\/[^/]+\/inventories$/);

  const update = await updateCoupangVendorItemQuantity(id, 0, context, {
    retryCount: 0,
  });
  assert.equal(update.payload.code, "SUCCESS");
  assert.equal(update.httpStatusCode, 200);
  assert.match(update.requestPath, /\/vendor-items\/[^/]+\/quantities\/0$/);
  assert.equal(
    (await database
      .prepare(
        "SELECT current_quantity_snapshot FROM mock_products WHERE vendor_item_id = ?"
      )
      .get(id)).current_quantity_snapshot,
    0
  );
  await assert.rejects(
    updateCoupangVendorItemQuantity(id, -1, context, { retryCount: 0 }),
    /non-negative safe integer/
  );
  await assert.rejects(
    updateCoupangVendorItemQuantity("not-numeric", 1, context, {
      retryCount: 0,
    }),
    /vendorItemId must be numeric/
  );

  await assert.rejects(
    getCoupangVendorItemInventory("NOT-FOUND", context, { retryCount: 0 }),
    (error) =>
      error instanceof CoupangApiResponseError && error.httpStatusCode === 400
  );

  await setFailurePolicy(managed.baseUrl, { missingRequiredFieldRate: 100 });
  await assert.rejects(
    getCoupangVendorItemInventory(id, context, { retryCount: 0 }),
    (error) =>
      error instanceof CoupangInventoryPayloadError &&
      error.code === "COUPANG_INVENTORY_AMOUNT_INVALID" &&
      error.responseMetadata?.httpStatusCode === 200
  );

  await setFailurePolicy(managed.baseUrl, {
    rateLimitRate: 100,
    retryAfterSeconds: 7,
  });
  await assert.rejects(
    getCoupangVendorItemInventory(id, context, { retryCount: 0 }),
    (error) =>
      error instanceof CoupangApiResponseError &&
      error.httpStatusCode === 429 &&
      error.retryAfterSeconds === 7
  );

  await setFailurePolicy(managed.baseUrl, { serverErrorRate: 100 });
  await assert.rejects(
    getCoupangVendorItemInventory(id, context, { retryCount: 0 }),
    (error) =>
      error instanceof CoupangApiResponseError &&
      error.httpStatusCode === 500 &&
      error.transient
  );

  await setFailurePolicy(managed.baseUrl, { malformedJsonRate: 100 });
  await assert.rejects(
    getCoupangVendorItemInventory(id, context, { retryCount: 0 }),
    /Coupang API JSON parse error/
  );

  await setFailurePolicy(managed.baseUrl, { timeoutRate: 100, timeoutMs: 1000 });
  await assert.rejects(
    getCoupangVendorItemInventory(id, context, { retryCount: 0 }),
    (error) => error instanceof Error && error.name === "TimeoutError"
  );

  await setFailurePolicy(managed.baseUrl, { enabled: false });
  for (const invalidQuantity of [-1]) {
    await database
      .prepare(
        "UPDATE mock_products SET current_quantity_snapshot = ? WHERE vendor_item_id = ?"
      )
      .run(invalidQuantity, id);
    await assert.rejects(
      getCoupangVendorItemInventory(id, context, { retryCount: 0 }),
      (error) =>
        error instanceof CoupangInventoryPayloadError &&
        error.code === "COUPANG_INVENTORY_AMOUNT_INVALID"
    );
  }

  assert(observedMethods.length >= 9);
  assert.equal(observedMethods.filter((method) => method === "PUT").length, 1);
  assert(observedMethods.every((method) => method === "GET" || method === "PUT"));
  console.log("Coupang inventory GET/PUT adapter and mock contract passed.");
} finally {
  await database?.close();
  if (managed.child.exitCode === null) {
    await new Promise((resolve) => {
      managed.child.once("exit", resolve);
      managed.child.kill();
    });
  }
  managed.databaseScope.cleanup();
}
