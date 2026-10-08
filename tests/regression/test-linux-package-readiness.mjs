import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packageReadinessDigest, verifyPackageReadinessDigest } from "../../tools/package-readiness-proof.mjs";
import { parseActiveConsolePid, readConsoleReadinessProof, requestVerifiedConsoleReadiness, waitForVerifiedApplicationReady } from "../../tools/platform/linux/package-lifecycle.mjs";

const secret = "a".repeat(64);
const nonce = "b".repeat(64);
const buildId = "c".repeat(64);
const ready = {
  applicationState: "ACTIVE", runtimeVersion: "1.0.23", runtimeBuildId: buildId,
  database: { state: "ACTIVE" }, tls: { ready: true }, backend: { ok: true },
  backendReadiness: { databaseReady: true }, gateway: { ok: true }, integration: { ready: true },
};

test("package readiness uses a fresh challenge without sending the secret", () => {
  const digest = packageReadinessDigest(secret, nonce);
  assert.equal(verifyPackageReadinessDigest(secret, nonce, digest), true);
  assert.equal(verifyPackageReadinessDigest(secret, "d".repeat(64), digest), false);
  assert.equal(verifyPackageReadinessDigest(secret, nonce, "invalid"), false);
});

test("HTTP readiness accepts a signed response and rejects a forged one", async () => {
  let validProof = true;
  let requestHeaders = null;
  const server = createServer((request, response) => {
    requestHeaders = request.headers;
    response.writeHead(200, {
      "content-type": "application/json",
      "x-quickhack-package-proof": validProof
        ? packageReadinessDigest(secret, request.headers["x-quickhack-package-nonce"])
        : "0".repeat(64),
    });
    response.end(JSON.stringify(ready));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = server.address().port;
    assert.deepEqual(await requestVerifiedConsoleReadiness(secret, { port }), ready);
    assert.equal(requestHeaders["x-quickhack-package-readiness"], undefined);
    assert.match(requestHeaders["x-quickhack-package-nonce"], /^[a-f0-9]{64}$/u);
    validProof = false;
    await assert.rejects(() => requestVerifiedConsoleReadiness(secret, { port }), /identity invalid/);
  } finally {
    server.close();
  }
});

test("console PID and private proof must identify the same active systemd unit", async () => {
  assert.equal(parseActiveConsolePid("ActiveState=active\nMainPID=123\n"), 123);
  assert.equal(parseActiveConsolePid("ActiveState=failed\nMainPID=123\n"), null);
  assert.equal(parseActiveConsolePid("ActiveState=active\nMainPID=0\n"), null);
  const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-readiness-"));
  try {
    mkdirSync(path.join(root, "state", "operator"), { recursive: true });
    const filename = path.join(root, "state", "operator", "server-console-action.json");
    writeFileSync(filename, JSON.stringify({ schemaVersion: 2, pid: 123, packageReadinessSecret: secret }), { mode: 0o600 });
    assert.deepEqual(await readConsoleReadinessProof(root), { pid: 123, secret });
    writeFileSync(filename, JSON.stringify({ schemaVersion: 1, pid: 123, packageReadinessSecret: secret }));
    await assert.rejects(() => readConsoleReadinessProof(root), (error) => error.code === "CONSOLE_READINESS_PROOF_INVALID");
    rmSync(filename);
    symlinkSync(path.join(root, "other-file"), filename);
    await assert.rejects(() => readConsoleReadinessProof(root), (error) => error.code === "ELOOP");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup rejects a spoofed response, stale PID, and restart during readiness", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-readiness-manifest-"));
  try {
    writeFileSync(path.join(root, "quickhack-package.json"), JSON.stringify({ version: ready.runtimeVersion, contentInventorySha256: buildId }));
    const config = { applicationRoot: root };
    const baseline = {
      activeConsolePid: async () => 123,
      consoleReadinessProof: async () => ({ pid: 123, secret }),
      applicationStatus: async () => ready,
    };
    assert.deepEqual(await waitForVerifiedApplicationReady(config, baseline, { attempts: 1 }), ready);
    const withoutSimulators = { ...ready, integration: { ready: false } };
    assert.deepEqual(await waitForVerifiedApplicationReady(config, { ...baseline, applicationStatus: async () => withoutSimulators }, { attempts: 1 }), withoutSimulators);
    await assert.rejects(() => waitForVerifiedApplicationReady(config, { ...baseline, applicationStatus: async () => ({ ...ready, backend: { ok: false } }) }, { attempts: 1 }), (error) => error.code === "APPLICATION_NOT_READY");
    await assert.rejects(() => waitForVerifiedApplicationReady(config, { ...baseline, consoleReadinessProof: async () => ({ pid: 999, secret }) }, { attempts: 1 }), (error) => error.code === "APPLICATION_NOT_READY");
    await assert.rejects(() => waitForVerifiedApplicationReady(config, { ...baseline, applicationStatus: async () => { throw new Error("bad proof"); } }, { attempts: 1 }), (error) => error.code === "APPLICATION_NOT_READY");
    let calls = 0;
    await assert.rejects(() => waitForVerifiedApplicationReady(config, { ...baseline, activeConsolePid: async () => ++calls === 1 ? 123 : 456 }, { attempts: 1 }), (error) => error.code === "APPLICATION_NOT_READY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
