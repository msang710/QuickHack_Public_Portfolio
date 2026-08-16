type ActiveWorkerSnapshot = {
  workerKey: string;
  workerJobId: number;
  startedAt: string;
};

type ActiveWorker = ActiveWorkerSnapshot & {
  token: symbol;
};

type WorkerShutdownState = {
  requested: boolean;
  requestedAt: string | null;
  reason: string | null;
  controller: AbortController;
  activeWorkers: Map<symbol, ActiveWorker>;
  idleWaiters: Set<() => void>;
};

const globalForWorkerShutdown = globalThis as typeof globalThis & {
  quickHackWorkerShutdownState?: WorkerShutdownState;
};

function createState(): WorkerShutdownState {
  return {
    requested: false,
    requestedAt: null,
    reason: null,
    controller: new AbortController(),
    activeWorkers: new Map(),
    idleWaiters: new Set(),
  };
}

function state() {
  globalForWorkerShutdown.quickHackWorkerShutdownState ??= createState();
  return globalForWorkerShutdown.quickHackWorkerShutdownState;
}

function signalReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Worker execution was aborted.");
}

function notifyIdle(current: WorkerShutdownState) {
  if (current.activeWorkers.size > 0) {
    return;
  }

  for (const resolve of current.idleWaiters) {
    resolve();
  }
  current.idleWaiters.clear();
}

export class WorkerShutdownRequestedError extends Error {
  readonly code = "WORKER_SHUTDOWN_REQUESTED";

  constructor(reason?: string | null) {
    super(
      reason
        ? `Worker stopped for server shutdown (${reason}).`
        : "Worker stopped for server shutdown."
    );
    this.name = "WorkerShutdownRequestedError";
  }
}

export function isWorkerShutdownRequestedError(
  error: unknown
): error is WorkerShutdownRequestedError {
  return (
    error instanceof WorkerShutdownRequestedError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "WORKER_SHUTDOWN_REQUESTED")
  );
}

export function assertWorkerRunsAllowed() {
  const current = state();

  if (current.requested) {
    throw new WorkerShutdownRequestedError(current.reason);
  }
}

export function beginWorkerShutdown(reason: string) {
  const current = state();

  if (!current.requested) {
    current.requested = true;
    current.requestedAt = new Date().toISOString();
    current.reason = String(reason || "server-shutdown");
    current.controller.abort(
      new WorkerShutdownRequestedError(current.reason)
    );
  }

  return getWorkerShutdownState();
}

export function registerActiveWorker(input: {
  workerKey: string;
  workerJobId: number;
  leaseSignal: AbortSignal;
}) {
  const current = state();
  const token = Symbol(input.workerKey);
  const activeWorker: ActiveWorker = {
    token,
    workerKey: input.workerKey,
    workerJobId: input.workerJobId,
    startedAt: new Date().toISOString(),
  };

  current.activeWorkers.set(token, activeWorker);

  const signal = AbortSignal.any([
    input.leaseSignal,
    current.controller.signal,
  ]);

  return {
    signal,
    throwIfAborted() {
      if (signal.aborted) {
        throw signalReason(signal);
      }
    },
    unregister() {
      current.activeWorkers.delete(token);
      notifyIdle(current);
    },
  };
}

export async function waitForActiveWorkersToDrain() {
  const current = state();

  if (current.activeWorkers.size === 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    current.idleWaiters.add(resolve);
    notifyIdle(current);
  });
}

export function getWorkerShutdownState() {
  const current = state();

  return {
    requested: current.requested,
    requestedAt: current.requestedAt,
    reason: current.reason,
    activeWorkers: [...current.activeWorkers.values()].map(
      ({ workerKey, workerJobId, startedAt }): ActiveWorkerSnapshot => ({
        workerKey,
        workerJobId,
        startedAt,
      })
    ),
  };
}
