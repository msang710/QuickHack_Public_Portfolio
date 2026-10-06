import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSourceServerRuntimeConfig, writeServerRuntimeConfigAtomicSync } from "../../quickhack_shared/core/server-runtime-config.mjs";
import { recoverServerRuntimeSettings, updateServerRuntimeSettings } from "../../tools/server-console-runtime-settings.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-settings-transaction-"));
const configPath = path.join(directory, "server-runtime.json");
const markerPath = path.join(directory, ".server-runtime.json.pending");
const previous = defaultSourceServerRuntimeConfig(directory);
const next = { ...previous, environment: "production" };
const originalBytes = `${JSON.stringify(previous)}\n`;
const reset = () => {
  fs.writeFileSync(configPath, originalBytes, { mode: 0o600 });
  fs.rmSync(markerPath, { force: true });
};
const readEnvironment = () => JSON.parse(fs.readFileSync(configPath, "utf8")).environment;

try {
  reset();
  let stopCount = 0;
  let startCount = 0;
  const success = await updateServerRuntimeSettings({
    configPath, next, wasRunning: true,
    stop: async () => { stopCount += 1; },
    start: async () => { startCount += 1; },
    canRestore: () => true,
  });
  assert.equal(success.restarted, true);
  assert.equal(readEnvironment(), "production");
  assert.equal(stopCount, 1);
  assert.equal(startCount, 1);
  assert.equal(fs.existsSync(markerPath), false);

  reset();
  startCount = 0;
  await assert.rejects(() => updateServerRuntimeSettings({
    configPath, next, wasRunning: true,
    stop: async () => {},
    start: async () => { if (++startCount === 1) throw Object.assign(new Error("new runtime failed"), { code: "NEW_RUNTIME_FAILED" }); },
    canRestore: () => true,
  }), (error) => error.code === "RUNTIME_SETTINGS_ROLLED_BACK" && error.originalCode === "NEW_RUNTIME_FAILED");
  assert.equal(startCount, 2);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalBytes);
  assert.equal(fs.existsSync(markerPath), false);

  reset();
  await assert.rejects(() => updateServerRuntimeSettings({
    configPath, next, wasRunning: true,
    stop: async () => {},
    start: async () => { throw Object.assign(new Error("start failed"), { code: "START_FAILED" }); },
    canRestore: () => true,
  }), (error) => error.code === "RUNTIME_SETTINGS_ROLLBACK_FAILED" &&
      error.originalCode === "START_FAILED" && error.rollbackCode === "START_FAILED");
  assert.equal(fs.readFileSync(configPath, "utf8"), originalBytes);
  assert.equal(fs.existsSync(markerPath), true);
  assert.deepEqual(recoverServerRuntimeSettings(configPath), { recovered: true });
  assert.equal(fs.existsSync(markerPath), false);

  reset();
  await assert.rejects(() => updateServerRuntimeSettings({
    configPath, next, wasRunning: true,
    stop: async () => {},
    start: async () => { throw Object.assign(new Error("stuck process"), { code: "START_CLEANUP_BLOCKED" }); },
    canRestore: () => false,
  }), (error) => error.code === "RUNTIME_SETTINGS_RECOVERY_REQUIRED" && error.originalCode === "START_CLEANUP_BLOCKED");
  assert.equal(readEnvironment(), "production");
  assert.equal(fs.existsSync(markerPath), true);
  assert.deepEqual(recoverServerRuntimeSettings(configPath), { recovered: true });
  assert.equal(fs.readFileSync(configPath, "utf8"), originalBytes);

  reset();
  const settingsModule = new URL("../../tools/server-console-runtime-settings.mjs", import.meta.url).href;
  const crashScript = `import { updateServerRuntimeSettings } from ${JSON.stringify(settingsModule)};
    await updateServerRuntimeSettings({
      configPath: ${JSON.stringify(configPath)}, next: ${JSON.stringify(next)}, wasRunning: true,
      stop: async () => {}, start: async () => process.exit(37), canRestore: () => true,
    });`;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript], { encoding: "utf8" });
  assert.equal(crashed.status, 37, crashed.stderr);
  assert.equal(readEnvironment(), "production");
  assert.equal(fs.existsSync(markerPath), true);
  fs.writeFileSync(configPath, `${JSON.stringify({ ...next, backupRetentionCount: 31 })}\n`);
  assert.throws(() => recoverServerRuntimeSettings(configPath), (error) => error.code === "RUNTIME_SETTINGS_RECOVERY_CONFLICT");
  assert.equal(fs.existsSync(markerPath), true);
  writeServerRuntimeConfigAtomicSync(configPath, next);
  assert.deepEqual(recoverServerRuntimeSettings(configPath), { recovered: true });
  assert.equal(fs.readFileSync(configPath, "utf8"), originalBytes);

  reset();
  await assert.rejects(() => updateServerRuntimeSettings({
    configPath, next, wasRunning: true,
    stop: async () => { throw Object.assign(new Error("safe stop blocked"), { code: "SAFE_STOP_BLOCKED" }); },
    start: async () => { throw new Error("must not start"); },
    canRestore: () => false,
  }), (error) => error.code === "SAFE_STOP_BLOCKED");
  assert.equal(fs.readFileSync(configPath, "utf8"), originalBytes);
  assert.equal(fs.existsSync(markerPath), false);

  reset();
  await updateServerRuntimeSettings({
    configPath, next, wasRunning: false,
    stop: async () => { throw new Error("must not stop"); },
    start: async () => { throw new Error("must not start"); },
    canRestore: () => true,
  });
  assert.equal(readEnvironment(), "production");
  assert.equal(fs.existsSync(markerPath), false);

  fs.rmSync(configPath);
  const missingPreviousCrash = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript], { encoding: "utf8" });
  assert.equal(missingPreviousCrash.status, 37, missingPreviousCrash.stderr);
  assert.equal(readEnvironment(), "production");
  assert.deepEqual(recoverServerRuntimeSettings(configPath), { recovered: true });
  assert.equal(fs.existsSync(configPath), false);

  reset();
  writeServerRuntimeConfigAtomicSync(configPath, previous);
  assert.deepEqual(recoverServerRuntimeSettings(configPath), { recovered: false });
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("Runtime settings commit, rollback, blocked recovery, and restart recovery verified.");
