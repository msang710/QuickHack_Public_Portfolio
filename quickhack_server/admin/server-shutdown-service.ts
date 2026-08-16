import { prisma } from "@/quickhack_server/core/prisma";
import {
  flushOperationTraceQueueForShutdown,
  getOperationTraceQueueState,
} from "@/quickhack_server/observability/trace-log-queue";
import {
  beginWorkerManagerShutdown,
  getWorkerManagerState,
  waitForWorkerManagerToDrain,
} from "@/quickhack_server/workers/manager";

export const SERVER_SHUTDOWN_REASONS = [
  "manual-stop",
  "runtime-restart",
  "console-signal",
  "restore-preflight",
] as const;

export type ServerShutdownReason =
  (typeof SERVER_SHUTDOWN_REASONS)[number];

type ShutdownPhase =
  | "QUIESCING"
  | "DRAINING"
  | "FINALIZING"
  | "FINALIZED"
  | "TERMINATING"
  | "FAILED";

type ShutdownOperation = {
  operationId: string;
  reason: ServerShutdownReason;
  warningEpochMs: number;
  startedAt: string;
  phase: ShutdownPhase;
  finalizedAt: string | null;
  terminateScheduledAt: string | null;
  prismaDisconnected: boolean;
  trace: ReturnType<typeof getOperationTraceQueueState> | null;
  errorMessage: string | null;
  finalizePromise: Promise<ServerShutdownSnapshot> | null;
};

export type ServerShutdownSnapshot = {
  operationId: string;
  reason: ServerShutdownReason;
  warningEpochMs: number;
  warningThresholdExceeded: boolean;
  startedAt: string;
  phase: ShutdownPhase;
  finalizedAt: string | null;
  terminateScheduledAt: string | null;
  prismaDisconnected: boolean;
  manager: ReturnType<typeof getWorkerManagerState>;
  trace: ReturnType<typeof getOperationTraceQueueState> | null;
  errorMessage: string | null;
};

const globalForShutdown = globalThis as typeof globalThis & {
  quickHackServerShutdownOperation?: ShutdownOperation | null;
};

export class ServerShutdownConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "ServerShutdownConflictError";
  }
}

function currentOperation() {
  return globalForShutdown.quickHackServerShutdownOperation ?? null;
}

function setCurrentOperation(operation: ShutdownOperation) {
  globalForShutdown.quickHackServerShutdownOperation = operation;
}

function snapshot(operation: ShutdownOperation): ServerShutdownSnapshot {
  return {
    operationId: operation.operationId,
    reason: operation.reason,
    warningEpochMs: operation.warningEpochMs,
    warningThresholdExceeded: Date.now() >= operation.warningEpochMs,
    startedAt: operation.startedAt,
    phase: operation.phase,
    finalizedAt: operation.finalizedAt,
    terminateScheduledAt: operation.terminateScheduledAt,
    prismaDisconnected: operation.prismaDisconnected,
    manager: getWorkerManagerState(),
    trace: operation.trace,
    errorMessage: operation.errorMessage,
  };
}

function requireOperation(operationId: string) {
  const operation = currentOperation();

  if (!operation) {
    throw new ServerShutdownConflictError(
      "Server shutdown has not been started."
    );
  }
  if (operation.operationId !== operationId) {
    throw new ServerShutdownConflictError(
      `Another server shutdown is already running (${operation.operationId}).`
    );
  }

  return operation;
}

export function beginServerShutdown(input: {
  operationId: string;
  reason: ServerShutdownReason;
  warningEpochMs: number;
}) {
  const existing = currentOperation();

  if (existing) {
    if (existing.operationId !== input.operationId) {
      throw new ServerShutdownConflictError(
        `Another server shutdown is already running (${existing.operationId}).`
      );
    }
    return snapshot(existing);
  }

  const operation: ShutdownOperation = {
    operationId: input.operationId,
    reason: input.reason,
    warningEpochMs: input.warningEpochMs,
    startedAt: new Date().toISOString(),
    phase: "QUIESCING",
    finalizedAt: null,
    terminateScheduledAt: null,
    prismaDisconnected: false,
    trace: null,
    errorMessage: null,
    finalizePromise: null,
  };
  setCurrentOperation(operation);
  beginWorkerManagerShutdown(input.reason);
  operation.phase = "DRAINING";

  return snapshot(operation);
}

export function getServerShutdownStatus(operationId: string) {
  return snapshot(requireOperation(operationId));
}

export function finalizeServerShutdown(operationId: string) {
  const operation = requireOperation(operationId);

  if (operation.finalizePromise) {
    return operation.finalizePromise;
  }
  if (operation.phase === "FINALIZED" || operation.phase === "TERMINATING") {
    return Promise.resolve(snapshot(operation));
  }
  if (operation.phase === "FAILED") {
    return Promise.reject(
      new Error(operation.errorMessage || "Server shutdown finalization failed.")
    );
  }

  operation.finalizePromise = (async () => {
    try {
      operation.phase = "DRAINING";
      await waitForWorkerManagerToDrain();
      operation.phase = "FINALIZING";
      operation.trace = await flushOperationTraceQueueForShutdown();
      await prisma.$disconnect();
      operation.prismaDisconnected = true;
      operation.finalizedAt = new Date().toISOString();
      operation.phase = "FINALIZED";
      return snapshot(operation);
    } catch (error) {
      operation.errorMessage =
        error instanceof Error ? error.message : String(error);
      operation.phase = "FAILED";
      throw error;
    }
  })();

  return operation.finalizePromise;
}

export function scheduleServerTermination(operationId: string) {
  const operation = requireOperation(operationId);

  if (operation.phase !== "FINALIZED" && operation.phase !== "TERMINATING") {
    throw new ServerShutdownConflictError(
      "Server termination is only allowed after worker drain and Prisma disconnect."
    );
  }

  if (!operation.terminateScheduledAt) {
    operation.terminateScheduledAt = new Date().toISOString();
    operation.phase = "TERMINATING";
    const timer = setTimeout(() => process.exit(0), 150);
    timer.unref?.();
  }

  return snapshot(operation);
}
