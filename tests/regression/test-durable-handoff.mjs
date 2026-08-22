import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createClientRuntimeOwnerStateStore,
  assertObservedClientRuntimeOwnership,
  launchClientRuntimeWithOwnerState,
} from "../../tools/client-runtime-owner-state.mjs";
import { runClientRuntimeBootstrap } from "../../tools/client-runtime-bootstrap.mjs";
import { createRestoreRequestHandoff } from "../../tools/operator-restore-handoff.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-durable-handoff-"));

let operationSequence = 0;
let tokenSequence = 0;

function restoreHandoff({ currentPid, active = new Set() }) {
  return createRestoreRequestHandoff({
    currentPid,
    processExists: (pid) => active.has(pid),
    createOperationId: () => `00000000-0000-4000-8000-${String(++operationSequence).padStart(12, "0")}`,
    createToken: () => String(++tokenSequence).padStart(48, "0"),
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  });
}

{
  const dataDirectory = path.join(temporary, "restore-start-failure");
  const producer = restoreHandoff({ directory: dataDirectory, currentPid: 101 });
  const first = producer.prepare("backup-a.qhb", { dataDirectory });
  assert.equal(fs.existsSync(first.publishedPath), true);
  assert.equal(producer.cleanupUnclaimed(first), true);
  assert.equal(fs.existsSync(first.publishedPath), false);
  const second = producer.prepare("backup-a.qhb", { dataDirectory });
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(producer.cleanupUnclaimed(second), true);
}

{
  const dataDirectory = path.join(temporary, "restore-claim");
  const active = new Set([202]);
  const producer = restoreHandoff({ directory: dataDirectory, currentPid: 101, active });
  const prepared = producer.prepare("backup-b.qhb", { dataDirectory });
  const consumer = restoreHandoff({ directory: dataDirectory, currentPid: 202, active });
  const claim = consumer.claim({ dataDirectory });
  assert.equal(producer.cleanupUnclaimed(prepared), false, "Producer cleanup must lose to an atomic consumer claim.");
  const contender = restoreHandoff({ directory: dataDirectory, currentPid: 303, active });
  assert.throws(
    () => contender.prepare("backup-c.qhb", { dataDirectory }),
    (error) => error.code === "RESTORE_REQUEST_IN_PROGRESS"
  );
  assert.throws(
    () => consumer.finalize({ ...claim, ownerToken: "f".repeat(48) }),
    (error) => error.code === "RESTORE_REQUEST_OWNER_MISMATCH"
  );
  assert.equal(fs.existsSync(claim.claimedPath), true);
  assert.equal(consumer.finalize(claim), true);
  assert.equal(fs.existsSync(claim.claimedPath), false);
}

{
  const dataDirectory = path.join(temporary, "restore-stale");
  const firstProducer = restoreHandoff({ directory: dataDirectory, currentPid: 404 });
  const first = firstProducer.prepare("backup-d.qhb", { dataDirectory });
  const recoveredProducer = restoreHandoff({ directory: dataDirectory, currentPid: 505 });
  const second = recoveredProducer.prepare("backup-e.qhb", { dataDirectory });
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(JSON.parse(fs.readFileSync(second.publishedPath, "utf8")).backupFile, "backup-e.qhb");
  recoveredProducer.cleanupUnclaimed(second);

  const prepared = firstProducer.prepare("backup-f.qhb", { dataDirectory });
  const deadConsumer = restoreHandoff({ directory: dataDirectory, currentPid: 606 });
  const claim = deadConsumer.claim({ dataDirectory });
  assert.equal(fs.existsSync(claim.claimedPath), true);
  const afterCrash = recoveredProducer.prepare("backup-g.qhb", { dataDirectory });
  assert.equal(fs.existsSync(claim.claimedPath), false, "A dead claim must be recovered before republish.");
  recoveredProducer.cleanupUnclaimed(afterCrash);
  assert.ok(prepared.operationId);
}

{
  const dataDirectory = path.join(temporary, "restore-checksum");
  const producer = restoreHandoff({ directory: dataDirectory, currentPid: 707 });
  const prepared = producer.prepare("backup-h.qhb", { dataDirectory });
  const manifest = JSON.parse(fs.readFileSync(prepared.publishedPath, "utf8"));
  manifest.backupFile = "tampered.qhb";
  fs.writeFileSync(prepared.publishedPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const consumer = restoreHandoff({ directory: dataDirectory, currentPid: 808 });
  assert.throws(
    () => consumer.claim({ dataDirectory }),
    (error) => error.code === "RESTORE_REQUEST_REQUIRES_REVIEW"
  );
  assert.equal(fs.existsSync(prepared.publishedPath), true, "An invalid published request must fail closed.");
}

{
  const dataDirectory = path.join(temporary, "restore-legacy-reader");
  const operatorDirectory = path.join(dataDirectory, "state", "operator");
  fs.mkdirSync(operatorDirectory, { recursive: true });
  const publishedPath = path.join(operatorDirectory, "restore-request.json");
  fs.writeFileSync(
    publishedPath,
    `${JSON.stringify({ schemaVersion: 1, backupFile: "legacy-backup.qhb" })}\n`,
    "utf8"
  );
  const consumer = restoreHandoff({ directory: dataDirectory, currentPid: 809 });
  const claim = consumer.claim({ dataDirectory });
  assert.equal(claim.schemaVersion, 1);
  assert.equal(claim.backupFile, "legacy-backup.qhb");
  assert.equal(consumer.finalize(claim), true);
  fs.writeFileSync(
    publishedPath,
    `${JSON.stringify({ schemaVersion: 1, backupFile: "stale-legacy.qhb" })}\n`,
    "utf8"
  );
  fs.utimesSync(publishedPath, new Date("2026-08-16T00:00:00.000Z"), new Date("2026-08-16T00:00:00.000Z"));
  const producer = restoreHandoff({ directory: dataDirectory, currentPid: 810 });
  const replacement = producer.prepare("replacement.qhb", { dataDirectory });
  assert.equal(JSON.parse(fs.readFileSync(publishedPath, "utf8")).backupFile, "replacement.qhb");
  producer.cleanupUnclaimed(replacement);
}

function stateInput(ownerToken = "a".repeat(48), instanceId = "b".repeat(48)) {
  return {
    ownerToken,
    port: 3001,
    clientUrl: "http://127.0.0.1:3001",
    serverUrl: "https://127.0.0.1:3000",
    caCertificateFile: path.join(temporary, "ca.pem"),
    instanceId,
    entry: path.join(temporary, "server.js"),
    runtimeMode: "standalone",
    artifactKind: "",
    startedAt: "2026-08-17T00:00:00.000Z",
  };
}

{
  const statePath = path.join(temporary, "client-state", "client-3001.json");
  const active = new Set([111, 900]);
  let token = 0;
  const createToken = () => (++token).toString(16).padStart(48, "0");
  const first = createClientRuntimeOwnerStateStore({
    statePath,
    currentPid: 111,
    processExists: (pid) => active.has(pid),
    createToken,
  });
  const commandLock = first.acquireCommandLock();
  const contender = createClientRuntimeOwnerStateStore({
    statePath,
    currentPid: 222,
    processExists: (pid) => active.has(pid),
    createToken,
  });
  assert.throws(
    () => contender.acquireCommandLock(),
    (error) => error.code === "CLIENT_RUNTIME_COMMAND_IN_PROGRESS"
  );
  commandLock.release();

  const prepared = first.publishPrepared(stateInput());
  const claimed = first.publishClaimed(prepared, 900);
  assert.equal(first.read().state.state, "CLAIMED");
  assert.equal(
    assertObservedClientRuntimeOwnership(
      { instanceId: claimed.instanceId },
      first.read(),
      (pid) => active.has(pid)
    ).pid,
    900
  );
  assert.throws(
    () => assertObservedClientRuntimeOwnership(
      { instanceId: "c".repeat(48) },
      first.read(),
      (pid) => active.has(pid)
    ),
    (error) => error.code === "CLIENT_RUNTIME_OWNERSHIP_UNVERIFIED"
  );
  assert.equal(first.removeOwned({ ownerToken: claimed.ownerToken, instanceId: claimed.instanceId, pid: 900 }), true);
  fs.writeFileSync(statePath, "{\"schemaVersion\":2", "utf8");
  active.delete(111);
  active.delete(900);
  assert.equal(first.read().status, "INVALID");
  assert.equal(first.recoverInactive(), true);
  assert.equal(first.read().status, "MISSING");
}

{
  const statePath = path.join(temporary, "client-launch-success", "client-3001.json");
  const active = new Set([901]);
  const stateStore = createClientRuntimeOwnerStateStore({ statePath, currentPid: 333, processExists: (pid) => active.has(pid) });
  let unreferenced = false;
  const result = await launchClientRuntimeWithOwnerState({
    stateStore,
    preparedState: stateInput("d".repeat(48), "e".repeat(48)),
    spawnBootstrap: () => ({ pid: 901, unref() { unreferenced = true; } }),
    terminateOwnedDetachedProcess: () => assert.fail("Successful startup must not terminate its owner."),
    isProcessRunning: (pid) => active.has(pid),
    probeRuntime: async () => ({ role: "client", instanceId: "e".repeat(48) }),
    waitFor: async (predicate) => await predicate(),
    timeoutMs: 100,
  });
  assert.equal(result.state.state, "CLAIMED");
  assert.equal(unreferenced, true);
  active.delete(901);
  stateStore.removeOwned({ ownerToken: result.state.ownerToken, instanceId: result.state.instanceId, pid: 901 });
}

{
  const statePath = path.join(temporary, "client-legacy-adoption", "client-3001.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const legacy = { ...stateInput("a".repeat(48), "c".repeat(48)), pid: 904 };
  delete legacy.ownerToken;
  fs.writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, "utf8");
  const active = new Set([904]);
  const stateStore = createClientRuntimeOwnerStateStore({
    statePath,
    currentPid: 600,
    processExists: (pid) => active.has(pid),
  });
  assert.equal(stateStore.read().status, "LEGACY");
  const adopted = stateStore.adoptLegacy({ instanceId: legacy.instanceId });
  assert.equal(adopted.state, "CLAIMED");
  assert.equal(adopted.pid, 904);
  assert.equal(stateStore.read().status, "VALID");
  active.delete(904);
  stateStore.removeOwned({ ownerToken: adopted.ownerToken, instanceId: adopted.instanceId, pid: 904 });
}

{
  const statePath = path.join(temporary, "client-publish-failure", "client-3001.json");
  let stateRenameCount = 0;
  const faultFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "renameSync") return target[property];
      return (source, destination) => {
        if (path.resolve(destination) === path.resolve(statePath) && ++stateRenameCount === 2) {
          const error = new Error("simulated state rename failure");
          error.code = "EACCES";
          throw error;
        }
        return target.renameSync(source, destination);
      };
    },
  });
  const active = new Set([902]);
  const stateStore = createClientRuntimeOwnerStateStore({
    statePath,
    fileSystem: faultFs,
    currentPid: 444,
    processExists: (pid) => active.has(pid),
  });
  const terminated = [];
  await assert.rejects(
    () => launchClientRuntimeWithOwnerState({
      stateStore,
      preparedState: stateInput("f".repeat(48), "1".repeat(48)),
      spawnBootstrap: () => ({ pid: 902, unref() { assert.fail("Failed startup must not unref."); } }),
      terminateOwnedDetachedProcess(pid) { terminated.push(pid); active.delete(pid); },
      isProcessRunning: (pid) => active.has(pid),
      probeRuntime: async () => ({ reachable: false }),
      waitFor: async (predicate) => await predicate(),
      timeoutMs: 100,
    }),
    (error) => error.code === "EACCES"
  );
  assert.deepEqual(terminated, [902]);
  assert.equal(stateStore.read().status, "MISSING");
}

{
  const statePath = path.join(temporary, "client-disk-full", "client-3001.json");
  const faultFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "writeFileSync") return target[property];
      return () => {
        const error = new Error("simulated disk full");
        error.code = "ENOSPC";
        throw error;
      };
    },
  });
  const stateStore = createClientRuntimeOwnerStateStore({ statePath, fileSystem: faultFs, currentPid: 556 });
  let spawned = false;
  await assert.rejects(
    () => launchClientRuntimeWithOwnerState({
      stateStore,
      preparedState: stateInput("6".repeat(48), "7".repeat(48)),
      spawnBootstrap: () => { spawned = true; },
    }),
    (error) => error.code === "ENOSPC"
  );
  assert.equal(spawned, false);
  assert.equal(stateStore.read().status, "MISSING");
}

{
  const statePath = path.join(temporary, "client-post-publish-crash", "client-3001.json");
  let injected = false;
  const faultFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "renameSync") return target[property];
      return (source, destination) => {
        const result = target.renameSync(source, destination);
        if (!injected && path.resolve(destination) === path.resolve(statePath)) {
          injected = true;
          const error = new Error("simulated crash after atomic publish");
          error.code = "EIO";
          throw error;
        }
        return result;
      };
    },
  });
  const stateStore = createClientRuntimeOwnerStateStore({
    statePath,
    fileSystem: faultFs,
    currentPid: 557,
    processExists: () => false,
  });
  assert.throws(
    () => stateStore.publishPrepared(stateInput("8".repeat(48), "9".repeat(48))),
    (error) => error.code === "EIO"
  );
  assert.equal(stateStore.read().status, "VALID", "An atomic publish remains recoverable after parent crash.");
  assert.equal(stateStore.recoverInactive(), true);
  assert.equal(stateStore.read().status, "MISSING");
}

{
  const statePath = path.join(temporary, "client-readiness-timeout", "client-3001.json");
  const active = new Set([903]);
  const stateStore = createClientRuntimeOwnerStateStore({ statePath, currentPid: 555, processExists: (pid) => active.has(pid) });
  const terminated = [];
  let waitCount = 0;
  await assert.rejects(
    () => launchClientRuntimeWithOwnerState({
      stateStore,
      preparedState: stateInput("2".repeat(48), "3".repeat(48)),
      spawnBootstrap: () => ({ pid: 903, unref() { assert.fail("Timed-out startup must not unref."); } }),
      terminateOwnedDetachedProcess(pid, options = {}) {
        terminated.push({ pid, force: options.force === true });
        if (options.force) active.delete(pid);
      },
      isProcessRunning: (pid) => active.has(pid),
      probeRuntime: async () => ({ role: "", instanceId: "" }),
      waitFor: async (predicate) => ++waitCount === 1 ? null : await predicate(),
      timeoutMs: 1,
    }),
    (error) => error.code === "CLIENT_RUNTIME_READINESS_TIMEOUT"
  );
  assert.deepEqual(terminated, [
    { pid: 903, force: false },
    { pid: 903, force: true },
  ]);
  assert.equal(stateStore.read().status, "MISSING");
}

{
  const statePath = path.join(temporary, "bootstrap-barrier", "client-3001.json");
  const stateStore = createClientRuntimeOwnerStateStore({ statePath, currentPid: process.pid });
  const prepared = stateStore.publishPrepared(stateInput("4".repeat(48), "5".repeat(48)));
  const args = [
    "--state-path", statePath,
    "--owner-token", prepared.ownerToken,
    "--instance-id", prepared.instanceId,
    "--cwd", temporary,
    "--", path.join(temporary, "server.js"),
  ];
  let spawned = false;
  await assert.rejects(
    () => runClientRuntimeBootstrap(args, {
      claimTimeoutMs: 5,
      processExecution: {
        childEnvironment: () => ({}),
        spawnOwnedChild() { spawned = true; },
      },
    }),
    (error) => error.code === "CLIENT_RUNTIME_OWNER_CLAIM_TIMEOUT"
  );
  assert.equal(spawned, false, "The bootstrap must not start the runtime before durable claim publish.");
  stateStore.publishClaimed(prepared, process.pid);
  const child = new EventEmitter();
  child.kill = () => true;
  let childEnvironmentInput = null;
  let spawnedEnvironment = null;
  const runtimeEnvironment = {
    QUICKHACK_RUNTIME_ROLE: "client",
    QUICKHACK_ARTIFACT_KIND: "DEMONSTRATION_CLIENT",
    QUICKHACK_PACKAGE_MANIFEST: "C:\\QuickHack\\quickhack-package.json",
    NODE_EXTRA_CA_CERTS: "C:\\QuickHack\\security\\root-ca.pem",
    NODE_OPTIONS: "--require=C:\\hostile.js",
  };
  const run = runClientRuntimeBootstrap(args, {
    claimTimeoutMs: 50,
    environment: runtimeEnvironment,
    processExecution: {
      childEnvironment(input) {
        childEnvironmentInput = input;
        return input.overrides;
      },
      spawnOwnedChild(_executable, _argumentsList, options) {
        spawned = true;
        spawnedEnvironment = options.env;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    },
  });
  assert.equal(await run, 0);
  assert.equal(spawned, true);
  assert.equal(childEnvironmentInput.source, runtimeEnvironment);
  assert.equal(spawnedEnvironment.QUICKHACK_RUNTIME_ROLE, "client");
  assert.equal(spawnedEnvironment.QUICKHACK_ARTIFACT_KIND, "DEMONSTRATION_CLIENT");
  assert.equal(
    spawnedEnvironment.QUICKHACK_PACKAGE_MANIFEST,
    "C:\\QuickHack\\quickhack-package.json"
  );
  assert.equal(
    spawnedEnvironment.NODE_EXTRA_CA_CERTS,
    "C:\\QuickHack\\security\\root-ca.pem"
  );
  assert.equal("NODE_OPTIONS" in spawnedEnvironment, false);
  stateStore.removeOwned({ ownerToken: prepared.ownerToken, instanceId: prepared.instanceId, pid: process.pid });
}

fs.rmSync(temporary, { recursive: true, force: true });
console.log("Restore and client runtime durable publish, claim, owner cleanup, and crash recovery verified.");
