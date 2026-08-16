import type { Prisma } from "@/generated/prisma/client";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import type { DateTimeInput } from "@/quickhack_shared/core/time";

export const SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE =
  "SHIPMENT_ADDRESS_CHANGED" as const;

export type ShipmentAddressChangeWorkerLease = WorkerLeaseGuard & {
  workerJobId: number;
  leaseToken: string;
};

type RawChangeEventClient = Pick<
  Prisma.TransactionClient,
  "coupang_raw_change_event"
>;

type ClaimableEventStatus = "PENDING" | "PROCESSING" | "FAILED";
type TerminalEventStatus = "DONE" | "FAILED" | "SKIPPED";

export class ShipmentAddressChangeExecutionOwnershipLostError extends Error {
  readonly code = "SHIPMENT_ADDRESS_CHANGE_EXECUTION_OWNERSHIP_LOST";

  constructor() {
    super("Shipment address change event execution ownership changed.");
    this.name = "ShipmentAddressChangeExecutionOwnershipLostError";
  }
}

export function isShipmentAddressChangeExecutionOwnershipLost(
  error: unknown
) {
  return error instanceof ShipmentAddressChangeExecutionOwnershipLostError;
}

export function requireShipmentAddressChangeWorkerLease(
  guard?: WorkerLeaseGuard | null
): ShipmentAddressChangeWorkerLease {
  if (
    !guard ||
    !Number.isSafeInteger(guard.workerJobId) ||
    Number(guard.workerJobId) <= 0 ||
    !String(guard.leaseToken ?? "").trim()
  ) {
    throw Object.assign(
      new Error(
        "Shipment address change tracking requires an owned worker lease."
      ),
      { code: "WORKER_LEASE_REQUIRED" }
    );
  }

  return guard as ShipmentAddressChangeWorkerLease;
}

export async function claimShipmentAddressChangeEvent(
  client: RawChangeEventClient,
  input: {
    eventId: number;
    observedStatus: ClaimableEventStatus;
    observedExecutionToken: string | null;
    observedAttemptCount: number;
    workerLease: ShipmentAddressChangeWorkerLease;
    claimedAt: DateTimeInput;
  }
) {
  const claimed = await client.coupang_raw_change_event.updateMany({
    where: {
      coupang_raw_change_event_id: input.eventId,
      event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
      process_status: input.observedStatus,
      execution_token: input.observedExecutionToken,
      worker_attempt_count: input.observedAttemptCount,
    },
    data: {
      process_status: "PROCESSING",
      execution_token: input.workerLease.leaseToken,
      worker_attempt_count: { increment: 1 },
      worker_job_id: input.workerLease.workerJobId,
      processed_at: null,
      last_error_message: null,
      updated_at: databaseDateTime(input.claimedAt),
    },
  });

  return claimed.count === 1;
}

export async function transitionOwnedShipmentAddressChangeEvent(
  client: RawChangeEventClient,
  input: {
    eventId: number;
    workerLease: ShipmentAddressChangeWorkerLease;
    status: TerminalEventStatus;
    transitionedAt: DateTimeInput;
    errorMessage?: string | null;
  }
) {
  const updated = await client.coupang_raw_change_event.updateMany({
    where: {
      coupang_raw_change_event_id: input.eventId,
      event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
      process_status: "PROCESSING",
      execution_token: input.workerLease.leaseToken,
    },
    data: {
      process_status: input.status,
      execution_token: null,
      processed_at: databaseDateTime(input.transitionedAt),
      worker_job_id: input.workerLease.workerJobId,
      last_error_message: input.errorMessage ?? null,
      updated_at: databaseDateTime(input.transitionedAt),
    },
  });

  if (updated.count !== 1) {
    throw new ShipmentAddressChangeExecutionOwnershipLostError();
  }
}
