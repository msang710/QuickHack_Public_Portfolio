import assert from "node:assert/strict";
import test from "node:test";
import { mainServerState } from "../../tools/server-console-core.mjs";

const healthy = {
  database: { state: "ACTIVE" },
  backend: { ok: true },
  gateway: { ok: true },
  backendReadiness: { databaseReady: true },
  tlsReady: true,
  coreProcessRunning: true,
};

test("main server is active based on its own dependencies", () => {
  assert.equal(mainServerState({ ...healthy, integration: { ready: false } }), "ACTIVE");
  assert.equal(mainServerState({ ...healthy, gateway: { ok: false } }), "DEGRADED");
  assert.equal(mainServerState({ ...healthy, backendReadiness: { databaseReady: false } }), "DEGRADED");
  assert.equal(mainServerState({ ...healthy, backend: { ok: false }, gateway: { ok: false }, coreProcessRunning: false }), "INACTIVE");
});
