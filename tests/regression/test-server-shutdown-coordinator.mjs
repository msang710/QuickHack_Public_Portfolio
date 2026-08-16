import { createQuickHackShutdownCoordinator } from "../../tools/quickhack-shutdown-coordinator.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function backendSnapshot(activeWorkers = []) {
  return {
    ok: true,
    shutdown: {
      phase: activeWorkers.length ? "DRAINING" : "FINALIZED",
      prismaDisconnected: activeWorkers.length === 0,
      manager: {
        tickRunning: false,
        activeWorkers,
      },
      trace: { pendingCount: 0 },
    },
  };
}

function fixture(options = {}) {
  const finalize = options.finalize ?? deferred();
  const calls = {
    gateway: 0,
    quiesce: 0,
    status: 0,
    finalize: 0,
    terminate: 0,
    force: 0,
  };
  const coordinator = createQuickHackShutdownCoordinator({
    warningMs: options.warningMs ?? 30,
    beginGatewayDrain: async () => {
      calls.gateway += 1;
    },
    quiesceBackend: async () => {
      calls.quiesce += 1;
      return backendSnapshot(options.activeWorkers ?? []);
    },
    getBackendStatus: async () => {
      calls.status += 1;
      return backendSnapshot(options.activeWorkers ?? []);
    },
    finalizeBackend: async () => {
      calls.finalize += 1;
      return finalize.promise;
    },
    terminateBackend: async () => {
      calls.terminate += 1;
    },
    forceTerminate: async () => {
      calls.force += 1;
      return { remainingPids: [] };
    },
    verifyStopped: async () => ({
      stopped: true,
      remainingPids: [],
    }),
  });

  return { coordinator, calls, finalize };
}

{
  const test = fixture({ warningMs: 1_000 });
  const started = test.coordinator.begin("manual-stop");
  test.finalize.resolve(backendSnapshot());
  const completed = await test.coordinator.waitForCompletion(
    started.operationId
  );

  assert(completed.graceful === true, "Graceful shutdown was not recorded.");
  assert(completed.forced === false, "Graceful shutdown was marked forced.");
  assert(test.calls.gateway === 1, "Gateway drain did not run exactly once.");
  assert(test.calls.quiesce === 1, "Backend quiesce did not run exactly once.");
  assert(test.calls.finalize === 1, "Backend finalize did not run exactly once.");
  assert(test.calls.terminate === 1, "Backend terminate did not run exactly once.");
}

{
  const test = fixture({ warningMs: 20 });
  const started = test.coordinator.begin("manual-stop");
  const duplicate = test.coordinator.begin("runtime-restart");

  assert(
    duplicate.operationId === started.operationId,
    "Concurrent stop requests did not join the active operation."
  );
  await delay(40);
  const warningState = test.coordinator.getState();
  assert(
    warningState.warningThresholdExceeded,
    "The soft warning threshold was not exposed."
  );
  assert(warningState.forceAvailable, "Force action was not enabled after warning.");
  assert(test.calls.force === 0, "The warning threshold forced the process automatically.");

  test.finalize.resolve(backendSnapshot());
  const completed = await test.coordinator.waitForCompletion(
    started.operationId
  );
  assert(
    completed.graceful === true,
    "Shutdown did not remain graceful after exceeding the warning threshold."
  );
}

{
  const test = fixture({ warningMs: 50 });
  const started = test.coordinator.begin("manual-stop");
  let earlyForceError = null;

  try {
    await test.coordinator.force("console-action");
  } catch (error) {
    earlyForceError = error;
  }
  assert(earlyForceError, "Console force was allowed before the warning threshold.");

  const forced = await test.coordinator.force("second-signal", {
    bypassWarning: true,
  });
  const completed = await test.coordinator.waitForCompletion(
    started.operationId
  );
  assert(forced.forced === true, "Second signal did not force shutdown.");
  assert(
    completed.forceReason === "second-signal",
    "Forced shutdown reason was not preserved."
  );
  assert(test.calls.force === 1, "Process-tree force did not run exactly once.");
  assert(test.calls.terminate === 0, "Graceful terminate ran after forced shutdown.");
}

{
  const test = fixture({ warningMs: 20 });
  const started = test.coordinator.begin("runtime-restart");
  await delay(40);
  const forced = await test.coordinator.force("console-action");
  const completed = await test.coordinator.waitForCompletion(
    started.operationId
  );

  assert(forced.forced === true, "Console force did not complete after warning.");
  assert(
    completed.forceReason === "console-action",
    "Console force reason was not preserved."
  );
  assert(completed.graceful === false, "Forced shutdown was marked graceful.");
}

console.log(
  "QuickHack shutdown idempotency, soft warning, graceful wait, and explicit force verified."
);
