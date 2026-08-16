import assert from "node:assert/strict";
import {
  createRuntimeSettingsTransitionCoordinator,
  RuntimeSettingsTransitionError,
} from "../../tools/quickhack-runtime-settings-transition.mjs";

const developmentSettings = Object.freeze({
  schemaVersion: 1,
  environment: "development",
  coupangWriteApiEnabled: true,
  logenWriteApiEnabled: false,
  dataDirectory: "C:\\QuickHack\\database",
  backupRetentionCount: 30,
});
const productionSettings = Object.freeze({
  ...developmentSettings,
  environment: "production",
});

function harness({
  running = true,
  forced = false,
  inspectError = null,
  mockError = null,
  writeError = null,
  startError = null,
  shouldStopMocks,
} = {}) {
  const events = [];
  let savedSettings = developmentSettings;
  let startCount = 0;
  let releaseInspection;
  const inspectionGate = new Promise((resolve) => {
    releaseInspection = resolve;
  });
  let holdInspection = false;

  const coordinator = createRuntimeSettingsTransitionCoordinator({
    createOperationId: () => "transition-1",
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    inspectQuickHack: async () => {
      events.push("inspect");
      if (holdInspection) await inspectionGate;
      if (inspectError) throw inspectError;
      return { running };
    },
    beginQuickHackStop: async () => {
      events.push("begin-stop");
      return { operationId: "shutdown-1" };
    },
    waitForQuickHackStop: async () => {
      events.push("wait-stop");
      return { forced };
    },
    verifyQuickHackStopped: async () => {
      events.push("verify-stop");
      return { stopped: true, remainingPids: [] };
    },
    stopMocksAndVerify: async () => {
      events.push("stop-mocks");
      if (mockError) throw mockError;
      return [
        { provider: "mock", stopped: [11], verifiedClosed: true },
        { provider: "logenMock", stopped: [12], verifiedClosed: true },
      ];
    },
    shouldStopMocks,
    secureSettingsDirectory: async () => events.push("secure-directory"),
    writeSettings: async (settings) => {
      events.push("write-settings");
      if (writeError) throw writeError;
      savedSettings = settings;
      return settings;
    },
    startQuickHack: async () => {
      events.push("start-quickhack");
      startCount += 1;
      if (startError) throw startError;
    },
  });

  return {
    coordinator,
    events,
    get savedSettings() {
      return savedSettings;
    },
    get startCount() {
      return startCount;
    },
    holdInspection() {
      holdInspection = true;
    },
    releaseInspection,
  };
}

async function runTransition(testHarness, currentSettings, nextSettings) {
  const started = testHarness.coordinator.begin({
    currentSettings,
    nextSettings,
    transitionType: "environment",
  });
  return testHarness.coordinator.waitForCompletion(started.operationId);
}

{
  const test = harness();
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.serverWasRunning, true);
  assert.equal(result.restartResult.succeeded, true);
  assert.deepEqual(test.savedSettings, productionSettings);
  assert.deepEqual(test.events, [
    "inspect",
    "begin-stop",
    "wait-stop",
    "verify-stop",
    "stop-mocks",
    "secure-directory",
    "write-settings",
    "start-quickhack",
  ]);
}

{
  const test = harness({ running: false });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.serverWasRunning, false);
  assert.equal(test.startCount, 0);
  assert(test.events.includes("stop-mocks"));
}

{
  const mockError = new RuntimeSettingsTransitionError(
    "MOCK_STOP_FAILED",
    "mock stop failed"
  );
  mockError.providerResults = [
    {
      provider: "mock",
      stopped: [],
      verifiedClosed: false,
      errorCode: "MOCK_STOP_FAILED",
    },
  ];
  const test = harness({ mockError });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "MOCK_STOP_FAILED");
  assert.deepEqual(test.savedSettings, developmentSettings);
  assert.equal(test.startCount, 1);
  assert.equal(result.restartResult.recoveredPreviousSettings, true);
}

{
  const test = harness({ writeError: new Error("disk full") });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "RUNTIME_SETTINGS_WRITE_FAILED");
  assert.deepEqual(test.savedSettings, developmentSettings);
  assert.equal(test.startCount, 1);
}

{
  const test = harness({ startError: new Error("start failed") });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "QUICKHACK_RESTART_FAILED");
  assert.deepEqual(test.savedSettings, productionSettings);
  assert.equal(test.startCount, 1);
}

{
  const test = harness({ forced: true });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "FORCED_STOPPED");
  assert.deepEqual(test.savedSettings, productionSettings);
  assert.equal(test.startCount, 0);
}

{
  const test = harness();
  const result = await runTransition(
    test,
    productionSettings,
    developmentSettings
  );
  assert.equal(result.status, "COMPLETED");
  assert.equal(test.events.includes("stop-mocks"), false);
}

{
  const test = harness({ inspectError: new Error("netstat failed") });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "FAILED");
  assert.equal(test.events.includes("write-settings"), false);
  assert.deepEqual(test.savedSettings, developmentSettings);
}

{
  const test = harness();
  test.holdInspection();
  const first = test.coordinator.begin({
    currentSettings: developmentSettings,
    nextSettings: productionSettings,
    transitionType: "environment",
  });
  assert.throws(
    () =>
      test.coordinator.begin({
        currentSettings: developmentSettings,
        nextSettings: productionSettings,
        transitionType: "environment",
      }),
    (error) =>
      error?.code === "RUNTIME_SETTINGS_TRANSITION_IN_PROGRESS" &&
      error?.statusCode === 409
  );
  test.releaseInspection();
  await test.coordinator.waitForCompletion(first.operationId);
}

{
  const test = harness({ shouldStopMocks: () => false });
  const result = await runTransition(
    test,
    developmentSettings,
    productionSettings
  );
  assert.equal(result.status, "COMPLETED");
  assert.equal(test.events.includes("stop-mocks"), false);
  assert.deepEqual(test.savedSettings, productionSettings);
}

console.log("Server runtime transition checks passed.");
