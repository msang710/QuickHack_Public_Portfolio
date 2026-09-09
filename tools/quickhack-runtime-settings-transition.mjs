import crypto from "node:crypto";

const ACTIVE_STAGES = new Set([
  "INSPECTING",
  "WAITING_FOR_SAFE_STOP",
  "STOPPING_MOCKS",
  "SAVING",
  "RESTARTING",
]);

export class RuntimeSettingsTransitionError extends Error {
  constructor(code, message, { statusCode = 500, details } = {}) {
    super(message);
    this.name = "RuntimeSettingsTransitionError";
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

function transitionError(error, code, message) {
  if (error instanceof RuntimeSettingsTransitionError) return error;
  return new RuntimeSettingsTransitionError(code, message, {
    details: error instanceof Error ? error.message : String(error),
  });
}

function publicError(error) {
  return {
    code: error?.code || "RUNTIME_SETTINGS_TRANSITION_FAILED",
  };
}

export function createRuntimeSettingsTransitionCoordinator({
  inspectQuickHack,
  beginQuickHackStop,
  waitForQuickHackStop,
  verifyQuickHackStopped,
  stopMocksAndVerify,
  shouldStopMocks = (currentSettings, nextSettings) =>
    currentSettings.environment === "development" &&
    nextSettings.environment === "production",
  secureSettingsDirectory,
  writeSettings,
  startQuickHack,
  onStateChange = () => undefined,
  now = () => new Date(),
  createOperationId = () => crypto.randomUUID(),
}) {
  let state = null;
  let completion = null;

  function publish(patch) {
    state = {
      ...state,
      ...patch,
    };
    onStateChange({ ...state });
    return { ...state };
  }

  function isActive() {
    return Boolean(state && ACTIVE_STAGES.has(state.status));
  }

  async function execute({ currentSettings, nextSettings }) {
    let settingsSaved = false;
    let quickHackStopped = false;

    try {
      const inspection = await inspectQuickHack();
      const serverWasRunning = inspection.running === true;
      publish({ serverWasRunning });

      if (serverWasRunning) {
        publish({ status: "WAITING_FOR_SAFE_STOP" });
        const shutdown = await beginQuickHackStop();
        const shutdownResult = await waitForQuickHackStop(shutdown.operationId);
        const verification = await verifyQuickHackStopped();

        if (!verification.stopped) {
          throw new RuntimeSettingsTransitionError(
            "PORT_INSPECTION_FAILED",
            "PORT_INSPECTION_FAILED"
          );
        }

        quickHackStopped = true;
        publish({ forced: shutdownResult.forced === true });
      }

      if (shouldStopMocks(currentSettings, nextSettings)) {
        publish({ status: "STOPPING_MOCKS" });
        const providerResults = await stopMocksAndVerify();
        publish({ providerResults });
      }

      publish({ status: "SAVING" });
      await secureSettingsDirectory();
      await writeSettings(nextSettings);
      settingsSaved = true;

      if (serverWasRunning && state.forced !== true) {
        publish({ status: "RESTARTING" });
        try {
          await startQuickHack();
        } catch (error) {
          throw transitionError(
            error,
            "QUICKHACK_RESTART_FAILED",
            "QUICKHACK_RESTART_FAILED"
          );
        }
        publish({ restartResult: { attempted: true, succeeded: true } });
      }

      return publish({
        status: state.forced ? "FORCED_STOPPED" : "COMPLETED",
        completedAt: now().toISOString(),
      });
    } catch (cause) {
      let error = cause;

      if (Array.isArray(cause?.providerResults)) {
        publish({ providerResults: cause.providerResults });
      }

      if (!settingsSaved && state.status === "SAVING") {
        error = transitionError(
          cause,
          "RUNTIME_SETTINGS_WRITE_FAILED",
          "RUNTIME_SETTINGS_WRITE_FAILED"
        );
      }

      if (
        !settingsSaved &&
        state.serverWasRunning === true &&
        quickHackStopped &&
        state.forced !== true
      ) {
        try {
          await startQuickHack();
          publish({
            restartResult: {
              attempted: true,
              succeeded: true,
              recoveredPreviousSettings: true,
            },
          });
        } catch (restartError) {
          publish({
            restartResult: {
              attempted: true,
              succeeded: false,
              recoveredPreviousSettings: true,
            },
          });
          error = new RuntimeSettingsTransitionError(
            error?.code || "RUNTIME_SETTINGS_TRANSITION_FAILED",
            error?.code || "RUNTIME_SETTINGS_TRANSITION_FAILED",
            { details: restartError instanceof Error ? restartError.message : String(restartError) }
          );
        }
      }

      publish({
        status: "FAILED",
        completedAt: now().toISOString(),
        error: publicError(error),
      });
      return { ...state };
    }
  }

  function begin({ currentSettings, nextSettings, transitionType }) {
    if (isActive()) {
      throw new RuntimeSettingsTransitionError(
        "RUNTIME_SETTINGS_TRANSITION_IN_PROGRESS",
        "RUNTIME_SETTINGS_TRANSITION_IN_PROGRESS",
        { statusCode: 409 }
      );
    }

    state = {
      operationId: createOperationId(),
      transitionType,
      targetEnvironment: nextSettings.environment,
      status: "INSPECTING",
      startedAt: now().toISOString(),
      completedAt: null,
      forced: false,
      serverWasRunning: null,
      providerResults: [],
      restartResult: { attempted: false, succeeded: false },
      error: null,
    };
    onStateChange({ ...state });
    completion = execute({ currentSettings, nextSettings });
    return { ...state };
  }

  async function waitForCompletion(operationId) {
    if (!state || state.operationId !== operationId || !completion) {
      throw new RuntimeSettingsTransitionError(
        "RUNTIME_SETTINGS_TRANSITION_NOT_FOUND",
        "RUNTIME_SETTINGS_TRANSITION_NOT_FOUND",
        { statusCode: 404 }
      );
    }
    return completion;
  }

  return {
    begin,
    getState: () => (state ? { ...state } : null),
    isActive,
    waitForCompletion,
  };
}
