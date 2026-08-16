import crypto from "node:crypto";

const DEFAULT_WARNING_MS = 180_000;
const STATUS_POLL_MS = 500;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cloneState(operation) {
  if (!operation) {
    return null;
  }

  return {
    operationId: operation.operationId,
    reason: operation.reason,
    phase: operation.phase,
    startedAt: operation.startedAt,
    warningAt: operation.warningAt,
    warningThresholdExceeded:
      operation.warningThresholdExceeded || Date.now() >= operation.warningEpochMs,
    forceAvailable:
      operation.forceAvailable || Date.now() >= operation.warningEpochMs,
    forced: operation.forced,
    forceReason: operation.forceReason,
    graceful: operation.graceful,
    completedAt: operation.completedAt,
    durationMs: operation.completedAt
      ? new Date(operation.completedAt).getTime() -
        new Date(operation.startedAt).getTime()
      : Date.now() - new Date(operation.startedAt).getTime(),
    activeWorkers: operation.activeWorkers.map((worker) => ({ ...worker })),
    managerTickRunning: operation.managerTickRunning,
    prismaDisconnected: operation.prismaDisconnected,
    tracePendingCount: operation.tracePendingCount,
    remainingPids: [...operation.remainingPids],
    errorMessage: operation.errorMessage,
  };
}

export function createQuickHackShutdownCoordinator(dependencies) {
  const warningMs = Math.max(
    1,
    Number(dependencies.warningMs) || DEFAULT_WARNING_MS
  );
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let operation = null;

  function publish() {
    dependencies.onStateChange?.(cloneState(operation));
  }

  function updateBackendState(payload) {
    const shutdown = payload?.shutdown ?? payload;
    const manager = shutdown?.manager;

    if (!shutdown) {
      return;
    }

    operation.activeWorkers = Array.isArray(manager?.activeWorkers)
      ? manager.activeWorkers.map((worker) => ({
          workerKey: String(worker.workerKey || ""),
          workerJobId: Number(worker.workerJobId) || null,
          startedAt: String(worker.startedAt || ""),
        }))
      : operation.activeWorkers;
    operation.managerTickRunning = Boolean(manager?.tickRunning);
    operation.prismaDisconnected = Boolean(shutdown.prismaDisconnected);
    operation.tracePendingCount =
      typeof shutdown.trace?.pendingCount === "number"
        ? shutdown.trace.pendingCount
        : operation.tracePendingCount;
    publish();
  }

  function markWarning() {
    if (!operation || operation.completedAt) {
      return;
    }

    operation.warningThresholdExceeded = true;
    operation.forceAvailable = true;
    operation.warningAt = new Date().toISOString();
    if (
      operation.phase !== "FORCING" &&
      operation.phase !== "FORCED" &&
      operation.phase !== "FAILED"
    ) {
      operation.phase = "WAITING_FOR_SAFE_STOP";
    }
    publish();
  }

  function complete(input) {
    if (!operation || operation.completedAt) {
      return;
    }

    if (operation.warningTimer) {
      clearTimeout(operation.warningTimer);
      operation.warningTimer = null;
    }
    operation.graceful = input.graceful;
    operation.forced = input.forced;
    operation.forceReason = input.forceReason ?? null;
    operation.remainingPids = input.remainingPids ?? [];
    operation.completedAt = new Date().toISOString();
    operation.phase = input.forced ? "FORCED" : "STOPPED";
    operation.errorMessage = input.errorMessage ?? null;
    publish();
    operation.completion.resolve(cloneState(operation));
  }

  async function monitorFinalization(finalizePromise) {
    let settled = false;
    const trackedFinalize = Promise.resolve(finalizePromise).finally(() => {
      settled = true;
    });

    while (!settled && operation && !operation.forced) {
      await sleep(STATUS_POLL_MS);

      if (settled || operation.forced) {
        break;
      }

      try {
        updateBackendState(
          await dependencies.getBackendStatus(operation.operationId)
        );
      } catch {
        // The finalize request remains the source of truth. A transient status
        // poll failure must not turn a safe drain into a forced stop.
      }
    }

    return trackedFinalize;
  }

  async function runGracefulShutdown(current) {
    try {
      current.phase = "QUIESCING";
      publish();
      const gatewayDrain = Promise.resolve()
        .then(() => dependencies.beginGatewayDrain(current.operationId))
        .then(
          () => null,
          (error) => error
        );
      const quiesce = await dependencies.quiesceBackend({
        operationId: current.operationId,
        reason: current.reason,
        warningEpochMs: current.warningEpochMs,
      });
      updateBackendState(quiesce);
      current.phase = "DRAINING";
      publish();

      const gatewayDrainError = await gatewayDrain;
      if (gatewayDrainError) {
        throw gatewayDrainError;
      }
      if (current.forced) {
        return;
      }

      current.phase = "FINALIZING";
      publish();
      const finalized = await monitorFinalization(
        dependencies.finalizeBackend(current.operationId)
      );
      updateBackendState(finalized);
      if (current.forced) {
        return;
      }

      current.phase = "TERMINATING";
      publish();
      await dependencies.terminateBackend(current.operationId);
      const verification = await dependencies.verifyStopped();
      if (!verification.stopped) {
        throw new Error(
          `QuickHack ports are still open (PID ${verification.remainingPids.join(
            ", "
          )}).`
        );
      }

      complete({
        graceful: true,
        forced: false,
        remainingPids: [],
      });
    } catch (error) {
      if (!operation || current !== operation || current.forced) {
        return;
      }

      current.errorMessage = errorMessage(error);
      current.phase =
        Date.now() >= current.warningEpochMs
          ? "WAITING_FOR_SAFE_STOP"
          : "GRACEFUL_STOP_BLOCKED";
      publish();
    }
  }

  function begin(reason) {
    if (operation && !operation.completedAt) {
      return cloneState(operation);
    }

    const startedAt = new Date();
    const completion = deferred();
    operation = {
      operationId: crypto.randomUUID(),
      reason,
      phase: "STARTING",
      startedAt: startedAt.toISOString(),
      warningEpochMs: startedAt.getTime() + warningMs,
      warningAt: null,
      warningThresholdExceeded: false,
      forceAvailable: false,
      forced: false,
      forceReason: null,
      graceful: null,
      completedAt: null,
      activeWorkers: [],
      managerTickRunning: false,
      prismaDisconnected: false,
      tracePendingCount: null,
      remainingPids: [],
      errorMessage: null,
      warningTimer: null,
      completion,
    };
    operation.warningTimer = setTimeout(markWarning, warningMs);
    operation.warningTimer.unref?.();
    publish();
    void runGracefulShutdown(operation);

    return cloneState(operation);
  }

  async function force(reason, options = {}) {
    if (!operation || operation.completedAt) {
      throw new Error("진행 중인 QuickHack 종료 작업이 없습니다.");
    }
    if (
      reason === "console-action" &&
      !options.bypassWarning &&
      Date.now() < operation.warningEpochMs
    ) {
      const error = new Error(
        "강제 종료는 안전 종료 대기 시간이 지난 뒤에만 사용할 수 있습니다."
      );
      error.statusCode = 409;
      throw error;
    }

    operation.forced = true;
    operation.forceReason = reason;
    operation.phase = "FORCING";
    operation.errorMessage = null;
    publish();

    const forceResult = await dependencies.forceTerminate();
    const verification = await dependencies.verifyStopped();
    const remainingPids = [
      ...new Set([
        ...(forceResult?.remainingPids ?? []),
        ...(verification.remainingPids ?? []),
      ]),
    ];

    if (!verification.stopped) {
      operation.phase = "FAILED";
      operation.remainingPids = remainingPids;
      operation.errorMessage = `강제 종료 뒤에도 PID ${remainingPids.join(
        ", "
      )}이 QuickHack 포트를 점유하고 있습니다.`;
      operation.forced = false;
      publish();
      throw new Error(operation.errorMessage);
    }

    complete({
      graceful: false,
      forced: true,
      forceReason: reason,
      remainingPids: [],
    });
    return cloneState(operation);
  }

  function waitForCompletion(operationId) {
    if (!operation || operation.operationId !== operationId) {
      return Promise.reject(new Error("QuickHack shutdown operation not found."));
    }
    return operation.completion.promise;
  }

  return {
    begin,
    force,
    getState: () => cloneState(operation),
    isActive: () => Boolean(operation && !operation.completedAt),
    waitForCompletion,
  };
}
