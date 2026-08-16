import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { nowKstSqlDateTime, quickHackClock } from "@/quickhack_shared/core/time";
import {
  ensureRegisteredWorkerJobs,
  runDueWorkerJobs,
} from "@/quickhack_server/workers/worker-jobs";
import { recoverInterruptedCoupangReadSyncs } from "@/quickhack_server/sales-channel/coupang/read-sync-recovery-service";
import { recoverStaleInventoryVerificationClaims } from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import { recoverInterruptedSalesChannelWrites } from "@/quickhack_server/sales-channel/write/sales-channel-write-recovery-service";
import { recoverInterruptedCarrierInvoiceIssues } from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-recovery-service";
import {
  assertWorkerRunsAllowed,
  beginWorkerShutdown,
  getWorkerShutdownState,
  waitForActiveWorkersToDrain,
} from "@/quickhack_server/workers/shutdown-runtime";

type WorkerManagerState = {
  started: boolean;
  starting: boolean;
  tickRunning: boolean;
  disabledReason: string;
  pollSeconds: number;
  timer: ReturnType<typeof setInterval> | null;
  initialTickTimer: ReturnType<typeof setTimeout> | null;
  startupPromise: Promise<void> | null;
  immediateTickTimers: Set<ReturnType<typeof setTimeout>>;
  lastTickAt: string;
  lastErrorMessage: string;
  lastReadSyncRecoveryAttemptAtMs: number;
  lastReadSyncRecoveryAt: string;
  lastReadSyncRecoveryError: string;
  lastInventoryVerificationRecoveryAttemptAtMs: number;
  lastInventoryVerificationRecoveryAt: string;
  lastInventoryVerificationRecoveryError: string;
  lastSalesChannelWriteRecoveryAttemptAtMs: number;
  lastSalesChannelWriteRecoveryAt: string;
  lastSalesChannelWriteRecoveryError: string;
  lastCarrierInvoiceIssueRecoveryAttemptAtMs: number;
  lastCarrierInvoiceIssueRecoveryAt: string;
  lastCarrierInvoiceIssueRecoveryError: string;
};

const DEFAULT_POLL_SECONDS = 30;
const READ_SYNC_RECOVERY_INTERVAL_SECONDS = 60;
const INVENTORY_VERIFICATION_RECOVERY_INTERVAL_SECONDS = 60;
const SALES_CHANNEL_WRITE_RECOVERY_INTERVAL_SECONDS = 60;
const CARRIER_INVOICE_ISSUE_RECOVERY_INTERVAL_SECONDS = 60;

const globalForWorkerManager = globalThis as unknown as {
  quickhackWorkerManager?: WorkerManagerState;
};

function initialState(): WorkerManagerState {
  return {
    started: false,
    starting: false,
    tickRunning: false,
    disabledReason: "",
    pollSeconds: DEFAULT_POLL_SECONDS,
    timer: null,
    initialTickTimer: null,
    startupPromise: null,
    immediateTickTimers: new Set(),
    lastTickAt: "",
    lastErrorMessage: "",
    lastReadSyncRecoveryAttemptAtMs: 0,
    lastReadSyncRecoveryAt: "",
    lastReadSyncRecoveryError: "",
    lastInventoryVerificationRecoveryAttemptAtMs: 0,
    lastInventoryVerificationRecoveryAt: "",
    lastInventoryVerificationRecoveryError: "",
    lastSalesChannelWriteRecoveryAttemptAtMs: 0,
    lastSalesChannelWriteRecoveryAt: "",
    lastSalesChannelWriteRecoveryError: "",
    lastCarrierInvoiceIssueRecoveryAttemptAtMs: 0,
    lastCarrierInvoiceIssueRecoveryAt: "",
    lastCarrierInvoiceIssueRecoveryError: "",
  };
}

function state() {
  globalForWorkerManager.quickhackWorkerManager ??= initialState();
  const current = globalForWorkerManager.quickhackWorkerManager;

  current.lastReadSyncRecoveryAttemptAtMs ??= 0;
  current.lastReadSyncRecoveryAt ??= "";
  current.lastReadSyncRecoveryError ??= "";
  current.lastInventoryVerificationRecoveryAttemptAtMs ??= 0;
  current.lastInventoryVerificationRecoveryAt ??= "";
  current.lastInventoryVerificationRecoveryError ??= "";
  current.lastSalesChannelWriteRecoveryAttemptAtMs ??= 0;
  current.lastSalesChannelWriteRecoveryAt ??= "";
  current.lastSalesChannelWriteRecoveryError ??= "";
  current.lastCarrierInvoiceIssueRecoveryAttemptAtMs ??= 0;
  current.lastCarrierInvoiceIssueRecoveryAt ??= "";
  current.lastCarrierInvoiceIssueRecoveryError ??= "";
  current.initialTickTimer ??= null;
  current.startupPromise ??= null;
  current.immediateTickTimers ??= new Set();

  return current;
}

async function runWorkerManagerTick() {
  const current = state();

  if (current.tickRunning) {
    return;
  }

  assertWorkerRunsAllowed();
  current.tickRunning = true;

  try {
    assertWorkerRunsAllowed();
    const now = quickHackClock.nowDate();

    if (
      now.getTime() - current.lastReadSyncRecoveryAttemptAtMs >=
      READ_SYNC_RECOVERY_INTERVAL_SECONDS * 1000
    ) {
      current.lastReadSyncRecoveryAttemptAtMs = now.getTime();

      try {
        assertWorkerRunsAllowed();
        await recoverInterruptedCoupangReadSyncs({ now });
        current.lastReadSyncRecoveryAt = nowKstSqlDateTime(now);
        current.lastReadSyncRecoveryError = "";
      } catch (error) {
        current.lastReadSyncRecoveryError =
          error instanceof Error ? error.message : String(error);
      }
    }

    if (
      now.getTime() - current.lastInventoryVerificationRecoveryAttemptAtMs >=
      INVENTORY_VERIFICATION_RECOVERY_INTERVAL_SECONDS * 1000
    ) {
      current.lastInventoryVerificationRecoveryAttemptAtMs = now.getTime();

      try {
        assertWorkerRunsAllowed();
        await recoverStaleInventoryVerificationClaims({ now });
        current.lastInventoryVerificationRecoveryAt = nowKstSqlDateTime(now);
        current.lastInventoryVerificationRecoveryError = "";
      } catch (error) {
        current.lastInventoryVerificationRecoveryError =
          error instanceof Error ? error.message : String(error);
      }
    }

    if (
      now.getTime() - current.lastSalesChannelWriteRecoveryAttemptAtMs >=
      SALES_CHANNEL_WRITE_RECOVERY_INTERVAL_SECONDS * 1000
    ) {
      current.lastSalesChannelWriteRecoveryAttemptAtMs = now.getTime();

      try {
        assertWorkerRunsAllowed();
        await recoverInterruptedSalesChannelWrites({ now });
        current.lastSalesChannelWriteRecoveryAt = nowKstSqlDateTime(now);
        current.lastSalesChannelWriteRecoveryError = "";
      } catch (error) {
        current.lastSalesChannelWriteRecoveryError =
          error instanceof Error ? error.message : String(error);
      }
    }

    if (
      now.getTime() - current.lastCarrierInvoiceIssueRecoveryAttemptAtMs >=
      CARRIER_INVOICE_ISSUE_RECOVERY_INTERVAL_SECONDS * 1000
    ) {
      current.lastCarrierInvoiceIssueRecoveryAttemptAtMs = now.getTime();

      try {
        assertWorkerRunsAllowed();
        await recoverInterruptedCarrierInvoiceIssues({ now });
        current.lastCarrierInvoiceIssueRecoveryAt = nowKstSqlDateTime(now);
        current.lastCarrierInvoiceIssueRecoveryError = "";
      } catch (error) {
        current.lastCarrierInvoiceIssueRecoveryError =
          error instanceof Error ? error.message : String(error);
      }
    }

    assertWorkerRunsAllowed();
    await runDueWorkerJobs(null);
    current.lastTickAt = nowKstSqlDateTime(quickHackClock.nowDate());
    current.lastErrorMessage = "";
  } catch (error) {
    current.lastErrorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    current.tickRunning = false;
  }
}

export function startWorkerManager() {
  const current = state();

  assertWorkerRunsAllowed();

  if (current.started || current.starting) {
    return getWorkerManagerState();
  }

  if (isClientRuntime()) {
    current.disabledReason = "client runtime";
    return getWorkerManagerState();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    current.disabledReason = "edge runtime";
    return getWorkerManagerState();
  }

  current.starting = true;
  current.pollSeconds = DEFAULT_POLL_SECONDS;

  current.startupPromise = (async () => {
    try {
      await ensureRegisteredWorkerJobs();
      assertWorkerRunsAllowed();
      current.timer = setInterval(
        () => void runWorkerManagerTick().catch(() => undefined),
        current.pollSeconds * 1000
      );
      current.timer.unref?.();
      current.started = true;
      current.disabledReason = "";
      current.initialTickTimer = setTimeout(
        () => {
          current.initialTickTimer = null;
          void runWorkerManagerTick().catch(() => undefined);
        },
        1_000
      );
      current.initialTickTimer.unref?.();
    } catch (error) {
      current.disabledReason =
        error instanceof Error ? error.message : String(error);
    } finally {
      current.starting = false;
      current.startupPromise = null;
    }
  })();

  return getWorkerManagerState();
}

export async function startWorkerManagerAndWaitForReady() {
  startWorkerManager();
  const startupPromise = state().startupPromise;

  if (startupPromise) {
    await startupPromise;
  }

  return getWorkerManagerState();
}

export function getWorkerManagerState() {
  const current = state();
  const shutdown = getWorkerShutdownState();

  return {
    started: current.started,
    starting: current.starting,
    tickRunning: current.tickRunning,
    disabledReason: current.disabledReason,
    pollSeconds: current.pollSeconds,
    lastTickAt: current.lastTickAt,
    lastErrorMessage: current.lastErrorMessage,
    lastReadSyncRecoveryAt: current.lastReadSyncRecoveryAt,
    lastReadSyncRecoveryError: current.lastReadSyncRecoveryError,
    lastInventoryVerificationRecoveryAt:
      current.lastInventoryVerificationRecoveryAt,
    lastInventoryVerificationRecoveryError:
      current.lastInventoryVerificationRecoveryError,
    lastSalesChannelWriteRecoveryAt: current.lastSalesChannelWriteRecoveryAt,
    lastSalesChannelWriteRecoveryError:
      current.lastSalesChannelWriteRecoveryError,
    lastCarrierInvoiceIssueRecoveryAt:
      current.lastCarrierInvoiceIssueRecoveryAt,
    lastCarrierInvoiceIssueRecoveryError:
      current.lastCarrierInvoiceIssueRecoveryError,
    shuttingDown: shutdown.requested,
    shutdownRequestedAt: shutdown.requestedAt,
    activeWorkers: shutdown.activeWorkers,
  };
}

export function wakeWorkerManager() {
  assertWorkerRunsAllowed();
  const current = state();
  if (!current.started && !current.starting) {
    startWorkerManager();
  }
  const immediateTick = setTimeout(
    () => {
      current.immediateTickTimers.delete(immediateTick);
      void runWorkerManagerTick().catch(() => undefined);
    },
    0
  );
  current.immediateTickTimers.add(immediateTick);
  immediateTick.unref?.();
}

export function beginWorkerManagerShutdown(reason: string) {
  const current = state();
  const shutdown = beginWorkerShutdown(reason);

  if (current.timer) {
    clearInterval(current.timer);
    current.timer = null;
  }
  if (current.initialTickTimer) {
    clearTimeout(current.initialTickTimer);
    current.initialTickTimer = null;
  }
  for (const timer of current.immediateTickTimers) {
    clearTimeout(timer);
  }
  current.immediateTickTimers.clear();
  current.started = false;

  return {
    ...shutdown,
    managerStarting: current.starting,
    managerTickRunning: current.tickRunning,
  };
}

export async function waitForWorkerManagerToDrain() {
  const current = state();

  while (current.starting || current.tickRunning) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await waitForActiveWorkersToDrain();
  return getWorkerManagerState();
}
