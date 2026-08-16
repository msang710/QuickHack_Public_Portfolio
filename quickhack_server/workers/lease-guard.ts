import type {
  OwnedWorkerLeaseGuard,
  WorkerLeaseGuard,
} from "@/quickhack_server/workers/types";

export function requireOwnedWorkerLease(
  guard?: WorkerLeaseGuard | null
): OwnedWorkerLeaseGuard {
  if (
    !guard ||
    !Number.isSafeInteger(guard.workerJobId) ||
    Number(guard.workerJobId) <= 0
  ) {
    throw Object.assign(
      new Error("Order matching requires an owned worker lease."),
      { code: "WORKER_LEASE_REQUIRED" }
    );
  }

  return guard as OwnedWorkerLeaseGuard;
}

export function throwIfWorkerLeaseAborted(guard?: WorkerLeaseGuard | null) {
  if (!guard?.signal.aborted) {
    return;
  }

  throw guard.signal.reason instanceof Error
    ? guard.signal.reason
    : new Error("Worker lease was aborted.");
}

export async function assertWorkerLeaseActive(
  guard?: WorkerLeaseGuard | null
) {
  if (!guard) {
    return;
  }

  throwIfWorkerLeaseAborted(guard);
  await guard.assertLeaseActive();
  throwIfWorkerLeaseAborted(guard);
}
