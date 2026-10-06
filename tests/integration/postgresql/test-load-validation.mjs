import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { NextRequest } from "next/server.js";
import { configureIntegrationTestEnvironment, createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";
import { createFixturePlan } from "../../../tools/load-validation/fixture-plan.mjs";
import { seedServerDatabase } from "../../../tools/load-validation/seed-server.mjs";
import { seedCoupangMock, seedLogenMock } from "../../../tools/load-validation/seed-mock.mjs";
import { appendCoupangOrders } from "../../../tools/load-validation/seed-mock.mjs";
import { provisionLoadAccounts } from "../../../tools/load-validation/accounts.mjs";
import { verifyLoadDatabases } from "../../../tools/load-validation/oracle.mjs";
import { DEFAULT_LOAD_PROFILE } from "../../../tools/load-validation/profile.mjs";
import { openDedicatedPool } from "../../../tools/load-validation/db.mjs";
import { runLoadPhase } from "../../../tools/load-validation/runner.mjs";
import { collectResourceSample } from "../../../tools/load-validation/monitor.mjs";
import { summarizeLoadRun } from "../../../tools/load-validation/report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const profile = { ...structuredClone(DEFAULT_LOAD_PROFILE), runId: "load-integration", days: 2, ordersPerDay: 10,
  skuCount: 8, activePackingOrders: 10, workerCount: 2,
  phases: [{ id: "smoke", durationSeconds: 7, orderMultiplier: 1, scored: true }] };
const { Pool } = pg;
process.env.NODE_ENV = "test";

function initializeMock(script, key, url) {
  const result = spawnSync(process.execPath, [path.join(root, script), "--init-db"], {
    cwd: root, env: { ...process.env, [key]: url }, encoding: "utf8", timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`${script} initialization failed: ${result.stderr || result.stdout}`);
}

const scopes = [];
const directory = mkdtempSync(path.join(os.tmpdir(), "quickhack-load-integration-"));
let prisma;
try {
  const server = createTemporaryDatabase("load-server-"); scopes.push(server);
  const coupang = createTemporaryDatabase("load-coupang-"); scopes.push(coupang);
  const logen = createTemporaryDatabase("load-logen-"); scopes.push(logen);
  initializeMock("mock_server/coupang-mock-server.mjs", "QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL", coupang.databaseUrl);
  initializeMock("mock_server/logen/server.mjs", "QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL", logen.databaseUrl);
  const pool = new Pool({ connectionString: server.databaseUrl, max: 1 });
  try { await pool.query("INSERT INTO server_instance_state (singleton_key, instance_epoch) VALUES ('QUICKHACK', 1) ON CONFLICT DO NOTHING"); }
  finally { await pool.end(); }
  const serverSeed = await seedServerDatabase(profile, server.databaseUrl);
  const coupangSeed = await seedCoupangMock(profile, coupang.databaseUrl);
  const logenSeed = await seedLogenMock(profile, logen.databaseUrl);
  assert.equal(serverSeed.order_count, 30);
  assert.equal(coupangSeed.orderCount, 30);
  assert.equal(logenSeed.shipmentCount, 20);
  const secrets = path.join(directory, "secrets.json");
  const accounts = await provisionLoadAccounts(profile, server.databaseUrl, secrets);
  assert.equal(accounts.accountCount, 2);
  assert.equal(statSync(secrets).mode & 0o777, 0o600);
  const credentials = JSON.parse(readFileSync(secrets, "utf8")).credentials;
  assert.equal(credentials.length, 2);
  configureIntegrationTestEnvironment(server.databaseUrl);
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const [{ GET: listDevices }, { GET: listOrders }, { POST: pack }] = await Promise.all([
    import("@/quickhack_server/api/inventory/device-list"),
    import("@/quickhack_server/api/sales-channel/coupang/orders"),
    import("@/quickhack_server/api/mobile/packing-check"),
  ]);
  const headers = { cookie: `quickhack_session=${credentials[0].sessionToken}`,
    "content-type": "application/json", "x-quickhack-validation-run-id": profile.runId,
    "x-quickhack-validation-scenario-id": "integration" };
  const inventoryResponse = await listDevices(new NextRequest("http://localhost/api/inventory/devices?limit=5", { headers }));
  assert.equal(inventoryResponse.status, 200);
  assert.ok(inventoryResponse.headers.get("x-quickhack-trace-id"));
  const ordersResponse = await listOrders(new NextRequest("http://localhost/api/coupang/orders?limit=5", { headers }));
  assert.equal(ordersResponse.status, 200);
  assert.ok(ordersResponse.headers.get("x-quickhack-trace-id"));
  const order = createFixturePlan(profile).order(profile.days * profile.ordersPerDay);
  const body = JSON.stringify({ scannedValues: [order.orderId, order.pgNo(0)],
    appInstanceId: credentials[0].appInstanceId, deviceToken: credentials[0].deviceToken });
  const request = () => new NextRequest("http://localhost/api/mobile/packing-check", { method: "POST", headers, body });
  const packed = await pack(request());
  if (packed.status !== 200) {
    const [{ getAuthSessionFromRequest, toAuthUser }, { checkPackingIntegrity }] = await Promise.all([
      import("@/quickhack_server/auth/auth-service"), import("@/quickhack_server/mobile/packing-check-service"),
    ]);
    const session = await getAuthSessionFromRequest(request());
    const user = toAuthUser(session.users);
    try { await checkPackingIntegrity(JSON.parse(body), user, { actor: user, sessionId: session.session_id, scope: "SELF" }); }
    catch (error) { throw new Error(`Packing API returned ${packed.status}: ${await packed.text()}`, { cause: error }); }
    throw new Error(`Packing API returned ${packed.status}: ${await packed.text()}`);
  }
  assert.equal((await packed.json()).data.code, "MATCH");
  assert.ok(packed.headers.get("x-quickhack-trace-id"));
  const duplicate = await pack(request());
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).data.code, "PACKING_STATUS_REQUIRED");
  const oracle = await verifyLoadDatabases(profile, {
    serverUrl: server.databaseUrl, coupangUrl: coupang.databaseUrl, logenUrl: logen.databaseUrl,
  });
  assert.equal(oracle.verdict, "PASS", JSON.stringify(oracle.findings));
  assert.equal(oracle.findings.packedActiveCount, 1);
  const serverPool = await openDedicatedPool(server.databaseUrl, "smoke-server");
  const mockPool = await openDedicatedPool(coupang.databaseUrl, "smoke-mock");
  const httpServer = http.createServer(async (incoming, outgoing) => {
    try {
      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) requestHeaders.append(key, item);
        else if (value !== undefined) requestHeaders.set(key, value);
      }
      const bytes = [];
      for await (const chunk of incoming) bytes.push(chunk);
      const request = new NextRequest(`http://127.0.0.1:${httpServer.address().port}${incoming.url}`, {
        method: incoming.method, headers: requestHeaders,
        body: bytes.length ? Buffer.concat(bytes) : undefined,
      });
      const response = incoming.url.startsWith("/api/mobile/packing-check") ? await pack(request)
        : incoming.url.startsWith("/api/inventory/devices") ? await listDevices(request)
          : await listOrders(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500); outgoing.end(String(error));
    }
  });
  try {
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const events = [await collectResourceSample(serverPool.pool)];
    const runResult = await runLoadPhase({
      profile, phaseId: "smoke", baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
      credentials, serverPool: serverPool.pool, mockPool: mockPool.pool,
      write: async (event) => { events.push(event); },
    });
    const afterRun = await verifyLoadDatabases(profile, {
      serverUrl: server.databaseUrl, coupangUrl: coupang.databaseUrl, logenUrl: logen.databaseUrl,
    });
    const report = summarizeLoadRun(profile, "smoke", events, afterRun, runResult);
    assert.equal(report.verdict, "PASS", JSON.stringify(report));
    await appendCoupangOrders(mockPool.pool, profile, runResult.nextArrival, 1);
    const liveId = createFixturePlan(profile).order(runResult.nextArrival).orderId;
    const live = await mockPool.pool.query("SELECT status, ordered_at, raw_json FROM mock_orders WHERE order_id=$1", [liveId]);
    assert.equal(live.rows[0]?.status, "ACCEPT");
    assert.ok(Math.abs(Date.now() - Date.parse(String(live.rows[0]?.ordered_at))) < 60_000);
    assert.equal(JSON.parse(live.rows[0].raw_json).status, "ACCEPT");
    const pending = await verifyLoadDatabases(profile, {
      serverUrl: server.databaseUrl, coupangUrl: coupang.databaseUrl, logenUrl: logen.databaseUrl,
    });
    assert.equal(pending.verdict, "INCONCLUSIVE");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await Promise.all([serverPool.pool.end(), mockPool.pool.end()]);
  }
  console.log(JSON.stringify({ test: "load-validation-postgresql", verdict: oracle.verdict, findings: oracle.findings }));
} finally {
  if (prisma) {
    const { flushOperationTraceQueueForShutdown } = await import("@/quickhack_server/observability/trace-log-queue");
    await flushOperationTraceQueueForShutdown();
    await prisma.$disconnect();
  }
  for (const scope of scopes.reverse()) scope.cleanup();
  rmSync(directory, { recursive: true, force: true });
}
