import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  assertWorkerLeaseActive,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import {
  databaseNow,
  requiredApiDateTime,
  type DatabaseDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  claimShipmentAddressChangeEvent,
  isShipmentAddressChangeExecutionOwnershipLost,
  requireShipmentAddressChangeWorkerLease,
  SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
  ShipmentAddressChangeExecutionOwnershipLostError,
  transitionOwnedShipmentAddressChangeEvent,
} from "@/quickhack_server/shipment/shipment-address-change-event-ownership";
import type { ShipmentAddressChangeWorkerLease } from "@/quickhack_server/shipment/shipment-address-change-event-ownership";
import { addSeconds } from "@/quickhack_shared/core/time";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const FAILED_ALLOCATION_STATUS = "FAILED";
const TRACKED_ORDER_STATUS = "DEPARTURE";
const FAILED_RETRY_SECONDS = 60;
const MAX_EVENT_ATTEMPTS = 3;
const AFTER_PRINT_ALLOCATION_STATUSES = new Set([
  "SHIPMENT_LIST_PRINTED",
]);

type RawChangeEvent = Prisma.coupang_raw_change_eventGetPayload<
  { include: { fields: true } }
>;
type AddressChangeAllocation = Prisma.match_worker_allocationGetPayload<
  Record<string, never>
>;
type AddressChangePackageGroup =
  Prisma.shipment_package_group_membersGetPayload<{
    include: {
      package_group: {
        include: { current_carrier_shipment: true };
      };
    };
  }>;
type AddressChangeOrder = Prisma.coupang_order_rawGetPayload<
  Record<string, never>
>;

function positiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.trunc(parsed), max);
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function shipmentStageAtDetection(
  order: AddressChangeOrder | null,
  allocation: AddressChangeAllocation | null,
  packageMembership: AddressChangePackageGroup | null
) {
  const shipmentStatus =
    packageMembership?.package_group.current_carrier_shipment?.shipment_status;
  if (
    shipmentStatus &&
    !["ALLOCATED", "REGISTERED"].includes(shipmentStatus)
  ) {
    return "AFTER_SHIPMENT";
  }
  if (
    allocation?.shipment_list_printed_at ||
    (allocation?.allocation_status &&
      AFTER_PRINT_ALLOCATION_STATUSES.has(allocation.allocation_status))
  ) {
    return "AFTER_PRINT";
  }

  if (allocation) {
    return "BEFORE_PRINT";
  }

  return "UNMATCHED";
}

async function loadRepresentativeAllocation(
  tx: Prisma.TransactionClient,
  event: RawChangeEvent
) {
  if (!event.external_order_id) {
    return null;
  }

  return tx.match_worker_allocation.findFirst({
    where: {
      external_order_id: event.external_order_id,
      ...(event.external_shipment_id
        ? { external_shipment_id: event.external_shipment_id }
        : {}),
      allocation_status: { not: FAILED_ALLOCATION_STATUS },
    },
    orderBy: [
      { shipment_list_printed_at: "desc" },
      { allocation_id: "desc" },
    ],
  });
}

async function markEventFailed(
  eventId: number,
  workerLease: ShipmentAddressChangeWorkerLease,
  error: unknown
) {
  const now = databaseNow();
  const errorMessage = safeErrorMessage(error);

  await prisma.$transaction(async (tx) => {
    const event = await tx.coupang_raw_change_event.findFirst({
      where: {
        coupang_raw_change_event_id: eventId,
        event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
        process_status: "PROCESSING",
        execution_token: workerLease.leaseToken,
      },
      include: { fields: true },
    });
    if (!event) throw new ShipmentAddressChangeExecutionOwnershipLostError();

    if (
      event.worker_attempt_count >= MAX_EVENT_ATTEMPTS &&
      event.external_order_id &&
      event.external_shipment_id
    ) {
      const [order, allocation] = await Promise.all([
        tx.coupang_order_raw.findUnique({
          where: {
            external_order_id_external_shipment_id: {
              external_order_id: event.external_order_id,
              external_shipment_id: event.external_shipment_id,
            },
          },
        }),
        loadRepresentativeAllocation(tx, event),
      ]);
      const packageMembership = allocation
        ? await tx.shipment_package_group_members.findFirst({
            where: {
              allocation_id: allocation.allocation_id,
              removed_at: null,
              package_group: {
                is: { group_status: { in: ["FROZEN", "READY", "ON_HOLD"] } },
              },
            },
            orderBy: { package_group_member_id: "desc" },
            include: {
              package_group: { include: { current_carrier_shipment: true } },
            },
          })
        : null;
      const stage = shipmentStageAtDetection(order, allocation, packageMembership);
      const work = await tx.shipment_address_change_work.upsert({
        where: { raw_change_event_id: event.coupang_raw_change_event_id },
        create: {
          raw_change_event_id: event.coupang_raw_change_event_id,
          api_call_log_id: event.api_call_log_id,
          external_order_id: event.external_order_id,
          external_shipment_id: event.external_shipment_id,
          allocation_id: allocation?.allocation_id ?? null,
          pg_no: allocation?.pg_no ?? null,
          package_group_id: packageMembership?.package_group_id ?? null,
          carrier_shipment_id_at_detection:
            packageMembership?.package_group.current_carrier_shipment_id ?? null,
          change_status: "FAILED",
          shipment_stage_at_detection: stage,
          allocation_status_at_detection: allocation?.allocation_status ?? null,
          detected_at: event.detected_at,
          failed_at: now,
          memo: errorMessage,
          created_at: now,
          updated_at: now,
        },
        update: {
          change_status: "FAILED",
          failed_at: now,
          memo: errorMessage,
          updated_at: now,
        },
        select: { shipment_address_change_work_id: true },
      });
      await tx.shipment_address_change_work_field.deleteMany({
        where: {
          shipment_address_change_work_id: work.shipment_address_change_work_id,
        },
      });
      if (event.fields.length > 0) {
        await tx.shipment_address_change_work_field.createMany({
          data: event.fields.map((field) => ({
            shipment_address_change_work_id:
              work.shipment_address_change_work_id,
            field_name: field.field_name,
            before_value: field.before_value,
            after_value: field.after_value,
            created_at: now,
          })),
        });
      }
    }

    await transitionOwnedShipmentAddressChangeEvent(tx, {
      eventId,
      workerLease,
      status: "FAILED",
      transitionedAt: now,
      errorMessage,
    });
  });
}

async function markEventSkipped(
  tx: Prisma.TransactionClient,
  input: {
    eventId: number;
    workerLease: ShipmentAddressChangeWorkerLease;
    now: DatabaseDateTime;
    reason: string;
  }
) {
  await transitionOwnedShipmentAddressChangeEvent(tx, {
    eventId: input.eventId,
    workerLease: input.workerLease,
    status: "SKIPPED",
    transitionedAt: input.now,
    errorMessage: input.reason,
  });
}

async function processOneShipmentAddressChangeEvent(input: {
  eventId: number;
  workerLease: ShipmentAddressChangeWorkerLease;
}) {
  const now = databaseNow();

  return runMeasuredTransaction(
    prisma,
    "shipment.address-change.process",
    async (tx) => {
    const event = await tx.coupang_raw_change_event.findFirst({
      where: {
        coupang_raw_change_event_id: input.eventId,
        event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
        process_status: "PROCESSING",
        execution_token: input.workerLease.leaseToken,
      },
      include: {
        fields: true,
      },
    });

    if (!event) {
      throw new ShipmentAddressChangeExecutionOwnershipLostError();
    }

    if (!event.external_order_id || !event.external_shipment_id) {
      await markEventSkipped(tx, {
        eventId: event.coupang_raw_change_event_id,
        workerLease: input.workerLease,
        now,
        reason: "external_order_id or external_shipment_id is missing.",
      });

      return {
        status: "SKIPPED" as const,
        reason: "ORDER_OR_SHIPMENT_ID_MISSING",
      };
    }

    const [order, allocation] = await Promise.all([
      tx.coupang_order_raw.findUnique({
        where: {
          external_order_id_external_shipment_id: {
            external_order_id: event.external_order_id,
            external_shipment_id: event.external_shipment_id,
          },
        },
      }),
      loadRepresentativeAllocation(tx, event),
    ]);
    const packageMembership = allocation
      ? await tx.shipment_package_group_members.findFirst({
          where: {
            allocation_id: allocation.allocation_id,
            removed_at: null,
            package_group: {
              is: {
                group_status: {
                  in: ["FROZEN", "READY", "ON_HOLD"],
                },
              },
            },
          },
          orderBy: { package_group_member_id: "desc" },
          include: {
            package_group: {
              include: { current_carrier_shipment: true },
            },
          },
        })
      : null;

    if (order?.external_order_status !== TRACKED_ORDER_STATUS) {
      await markEventSkipped(tx, {
        eventId: event.coupang_raw_change_event_id,
        workerLease: input.workerLease,
        now,
        reason: `Order status is not ${TRACKED_ORDER_STATUS}.`,
      });

      return {
        status: "SKIPPED" as const,
        reason: "ORDER_STATUS_NOT_TRACKED",
      };
    }

    const stage = shipmentStageAtDetection(
      order,
      allocation,
      packageMembership
    );

    const work = await tx.shipment_address_change_work.upsert({
      where: {
        raw_change_event_id: event.coupang_raw_change_event_id,
      },
      create: {
        raw_change_event_id: event.coupang_raw_change_event_id,
        api_call_log_id: event.api_call_log_id,
        external_order_id: event.external_order_id,
        external_shipment_id: event.external_shipment_id,
        allocation_id: allocation?.allocation_id ?? null,
        pg_no: allocation?.pg_no ?? null,
        package_group_id:
          packageMembership?.package_group_id ?? null,
        carrier_shipment_id_at_detection:
          packageMembership?.package_group.current_carrier_shipment_id ??
          null,
        change_status: "PENDING",
        shipment_stage_at_detection: stage,
        allocation_status_at_detection: allocation?.allocation_status ?? null,
        detected_at: event.detected_at,
        created_at: now,
        updated_at: now,
      },
      update: {
        api_call_log_id: event.api_call_log_id,
        external_order_id: event.external_order_id,
        external_shipment_id: event.external_shipment_id,
        allocation_id: allocation?.allocation_id ?? null,
        pg_no: allocation?.pg_no ?? null,
        package_group_id:
          packageMembership?.package_group_id ?? null,
        carrier_shipment_id_at_detection:
          packageMembership?.package_group.current_carrier_shipment_id ??
          null,
        shipment_stage_at_detection: stage,
        allocation_status_at_detection: allocation?.allocation_status ?? null,
        updated_at: now,
      },
      select: {
        shipment_address_change_work_id: true,
      },
    });

    await tx.shipment_address_change_work_field.deleteMany({
      where: {
        shipment_address_change_work_id:
          work.shipment_address_change_work_id,
      },
    });

    for (const field of event.fields) {
      await tx.shipment_address_change_work_field.create({
        data: {
          shipment_address_change_work_id:
            work.shipment_address_change_work_id,
          field_name: field.field_name,
          before_value: field.before_value,
          after_value: field.after_value,
          created_at: now,
        },
      });
    }

    await transitionOwnedShipmentAddressChangeEvent(tx, {
      eventId: event.coupang_raw_change_event_id,
      workerLease: input.workerLease,
      status: "DONE",
      transitionedAt: now,
    });

    return {
      status: "DONE" as const,
      shipmentStageAtDetection: stage,
      allocationId: allocation?.allocation_id ?? null,
      pgNo: allocation?.pg_no ?? null,
    };
  });
}

export async function trackShipmentAddressChangeWork(input: {
  limit?: unknown;
  workerLease?: WorkerLeaseGuard;
} = {}) {
  const workerLease = requireShipmentAddressChangeWorkerLease(
    input.workerLease
  );
  await assertWorkerLeaseActive(workerLease);
  const limit = positiveInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const startedAt = databaseNow();
  const failedRetryCutoff = addSeconds(startedAt, -FAILED_RETRY_SECONDS);
  const candidateEvents = await prisma.coupang_raw_change_event.findMany({
    where: {
      event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
      OR: [
        { process_status: "PENDING" },
        {
          process_status: "FAILED",
          worker_attempt_count: { lt: MAX_EVENT_ATTEMPTS },
          updated_at: { lte: failedRetryCutoff },
        },
        {
          process_status: "PROCESSING",
          OR: [
            { execution_token: null },
            { execution_token: { not: workerLease.leaseToken } },
          ],
        },
      ],
    },
    orderBy: [
      { detected_at: "asc" },
      { coupang_raw_change_event_id: "asc" },
    ],
    take: limit,
    select: {
      coupang_raw_change_event_id: true,
      process_status: true,
      worker_attempt_count: true,
      execution_token: true,
    },
  });
  let claimedCount = 0;
  let reclaimedCount = 0;
  let retriedCount = 0;
  let processedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const stageCounts: Record<string, number> = {};

  for (const [index, event] of candidateEvents.entries()) {
    if (index % 10 === 0) {
      await assertWorkerLeaseActive(workerLease);
    } else {
      throwIfWorkerLeaseAborted(workerLease);
    }

    if (
      event.process_status !== "PENDING" &&
      event.process_status !== "PROCESSING" &&
      event.process_status !== "FAILED"
    ) {
      skippedCount += 1;
      continue;
    }
    const claimedAt = databaseNow();
    const claimed = await claimShipmentAddressChangeEvent(prisma, {
      eventId: event.coupang_raw_change_event_id,
      observedStatus: event.process_status,
      observedExecutionToken: event.execution_token,
      observedAttemptCount: event.worker_attempt_count,
      workerLease,
      claimedAt,
    });

    if (!claimed) {
      skippedCount += 1;
      continue;
    }

    claimedCount += 1;
    if (event.process_status === "PROCESSING") {
      reclaimedCount += 1;
    } else if (event.process_status === "FAILED") {
      retriedCount += 1;
    }

    try {
      await assertWorkerLeaseActive(workerLease);
      const result = await processOneShipmentAddressChangeEvent({
        eventId: event.coupang_raw_change_event_id,
        workerLease,
      });

      if (result.status === "DONE") {
        processedCount += 1;
        stageCounts[result.shipmentStageAtDetection] =
          (stageCounts[result.shipmentStageAtDetection] ?? 0) + 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      throwIfWorkerLeaseAborted(workerLease);
      if (isShipmentAddressChangeExecutionOwnershipLost(error)) {
        throw error;
      }
      await assertWorkerLeaseActive(workerLease);
      await markEventFailed(
        event.coupang_raw_change_event_id,
        workerLease,
        error
      );
      failedCount += 1;
    }
  }

  await assertWorkerLeaseActive(workerLease);
  return {
    startedAt: requiredApiDateTime(startedAt),
    finishedAt: requiredApiDateTime(databaseNow()),
    candidateCount: candidateEvents.length,
    claimedCount,
    reclaimedCount,
    retriedCount,
    processedCount,
    skippedCount,
    failedCount,
    stageCounts,
  };
}
