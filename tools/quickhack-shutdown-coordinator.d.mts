export type QuickHackShutdownReason =
  | "manual-stop"
  | "runtime-restart"
  | "console-signal"
  | "restore-preflight";

export type QuickHackShutdownState = {
  operationId: string;
  reason: QuickHackShutdownReason;
  phase: string;
  startedAt: string;
  warningAt: string | null;
  warningThresholdExceeded: boolean;
  forceAvailable: boolean;
  forced: boolean;
  forceReason: string | null;
  graceful: boolean | null;
  completedAt: string | null;
  durationMs: number;
  activeWorkers: Array<{
    workerKey: string;
    workerJobId: number | null;
    startedAt: string;
  }>;
  managerTickRunning: boolean;
  prismaDisconnected: boolean;
  tracePendingCount: number | null;
  remainingPids: number[];
  errorMessage: string | null;
};

export function createQuickHackShutdownCoordinator(dependencies: {
  warningMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  beginGatewayDrain: (operationId: string) => Promise<unknown>;
  quiesceBackend: (input: {
    operationId: string;
    reason: QuickHackShutdownReason;
    warningEpochMs: number;
  }) => Promise<unknown>;
  getBackendStatus: (operationId: string) => Promise<unknown>;
  finalizeBackend: (operationId: string) => Promise<unknown>;
  terminateBackend: (operationId: string) => Promise<unknown>;
  forceTerminate: () => Promise<{ remainingPids?: number[] } | void>;
  verifyStopped: () => Promise<{
    stopped: boolean;
    remainingPids: number[];
  }>;
  onStateChange?: (state: QuickHackShutdownState | null) => void;
}): {
  begin: (reason: QuickHackShutdownReason) => QuickHackShutdownState;
  force: (
    reason: "console-action" | "second-signal",
    options?: { bypassWarning?: boolean }
  ) => Promise<QuickHackShutdownState>;
  getState: () => QuickHackShutdownState | null;
  isActive: () => boolean;
  waitForCompletion: (
    operationId: string
  ) => Promise<QuickHackShutdownState>;
};
