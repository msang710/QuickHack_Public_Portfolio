import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-shipment-address-change-ownership-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const NOW = new Date("2026-08-07T12:00:00+09:00");
let prisma;

function workerLease(workerJobId, leaseToken) {
  const controller = new AbortController();
  return {
    workerJobId,
    leaseToken,
    signal: controller.signal,
    assertLeaseActive: async () => {},
  };
}

async function createTrackedEvent(input) {
  const order = await prisma.coupang_order_raw.create({
    data: {
      external_order_id: `ORDER-${input.key}`,
      external_shipment_id: `SHIPMENT-${input.key}`,
      external_order_status: "DEPARTURE",
      receiver_address_1: "Before address",
      updated_at: NOW,
    },
  });
  return prisma.coupang_raw_change_event.create({
    data: {
      source_table: "coupang_order_raw",
      source_pk: String(order.coupang_order_raw_id),
      external_order_id: order.external_order_id,
      external_shipment_id: order.external_shipment_id,
      event_type: "SHIPMENT_ADDRESS_CHANGED",
      change_hash: `shipment-address-change-${input.key}`,
      process_status: input.processStatus ?? "PENDING",
      worker_attempt_count: input.attemptCount ?? 0,
      execution_token: input.executionToken ?? null,
      detected_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      fields: {
        create: {
          field_name: "receiver_address_1",
          before_value: "Before address",
          after_value: "After address",
          created_at: NOW,
        },
      },
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    claimShipmentAddressChangeEvent,
    isShipmentAddressChangeExecutionOwnershipLost,
    transitionOwnedShipmentAddressChangeEvent,
  } = await import(
    "@/quickhack_server/shipment/shipment-address-change-event-ownership"
  );
  const { trackShipmentAddressChangeWork } = await import(
    "@/quickhack_server/shipment/shipment-address-change-tracking-service"
  );

  const worker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "shipment-address-change-ownership-test",
      worker_name: "Shipment address change ownership test",
      worker_type: "SHIPMENT_CHANGE_TRACKING",
      status: "RUNNING",
      locked_by: "lease-current",
      locked_until: new Date("2099-01-01T00:00:00+09:00"),
      updated_at: NOW,
    },
  });
  const staleLease = workerLease(worker.worker_job_id, "lease-stale");
  const currentLease = workerLease(worker.worker_job_id, "lease-current");

  await assert.rejects(
    () => trackShipmentAddressChangeWork({ limit: 1 }),
    (error) => error?.code === "WORKER_LEASE_REQUIRED"
  );

  const ownedEvent = await createTrackedEvent({
    key: "DIRECT-CAS",
    processStatus: "PROCESSING",
    attemptCount: 1,
    executionToken: staleLease.leaseToken,
  });
  assert.equal(
    await claimShipmentAddressChangeEvent(prisma, {
      eventId: ownedEvent.coupang_raw_change_event_id,
      observedStatus: "PROCESSING",
      observedExecutionToken: staleLease.leaseToken,
      observedAttemptCount: 1,
      workerLease: currentLease,
      claimedAt: NOW,
    }),
    true
  );

  await assert.rejects(
    () =>
      transitionOwnedShipmentAddressChangeEvent(prisma, {
        eventId: ownedEvent.coupang_raw_change_event_id,
        workerLease: staleLease,
        status: "FAILED",
        transitionedAt: NOW,
        errorMessage: "stale worker must not win",
      }),
    isShipmentAddressChangeExecutionOwnershipLost
  );

  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.shipment_address_change_work.create({
          data: {
            raw_change_event_id: ownedEvent.coupang_raw_change_event_id,
            external_order_id: ownedEvent.external_order_id,
            external_shipment_id: ownedEvent.external_shipment_id,
            change_status: "PENDING",
            shipment_stage_at_detection: "UNMATCHED",
            detected_at: NOW,
            created_at: NOW,
            updated_at: NOW,
          },
        });
        await transitionOwnedShipmentAddressChangeEvent(tx, {
          eventId: ownedEvent.coupang_raw_change_event_id,
          workerLease: staleLease,
          status: "DONE",
          transitionedAt: NOW,
        });
      }),
    isShipmentAddressChangeExecutionOwnershipLost
  );
  assert.equal(
    await prisma.shipment_address_change_work.count({
      where: { raw_change_event_id: ownedEvent.coupang_raw_change_event_id },
    }),
    0,
    "A stale terminal CAS did not roll back derived address-change work."
  );

  await transitionOwnedShipmentAddressChangeEvent(prisma, {
    eventId: ownedEvent.coupang_raw_change_event_id,
    workerLease: currentLease,
    status: "DONE",
    transitionedAt: NOW,
  });
  assert.deepEqual(
    await prisma.coupang_raw_change_event.findUnique({
      where: {
        coupang_raw_change_event_id: ownedEvent.coupang_raw_change_event_id,
      },
      select: {
        process_status: true,
        worker_attempt_count: true,
        execution_token: true,
      },
    }),
    {
      process_status: "DONE",
      worker_attempt_count: 2,
      execution_token: null,
    }
  );

  const normalEvent = await createTrackedEvent({ key: "NORMAL" });
  const interruptedEvent = await createTrackedEvent({
    key: "INTERRUPTED",
    processStatus: "PROCESSING",
    attemptCount: 2,
  });
  const retryEvent = await createTrackedEvent({
    key: "FAILED-RETRY",
    processStatus: "FAILED",
    attemptCount: 1,
  });
  const skippedEvent = await prisma.coupang_raw_change_event.create({
    data: {
      source_table: "coupang_order_raw",
      source_pk: "missing-order-identifiers",
      event_type: "SHIPMENT_ADDRESS_CHANGED",
      change_hash: "shipment-address-change-skipped",
      process_status: "PENDING",
      detected_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    },
  });

  const result = await trackShipmentAddressChangeWork({
    limit: 10,
    workerLease: currentLease,
  });
  assert.equal(result.candidateCount, 4);
  assert.equal(result.claimedCount, 4);
  assert.equal(result.reclaimedCount, 1);
  assert.equal(result.retriedCount, 1);
  assert.equal(result.processedCount, 3);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.stageCounts, { UNMATCHED: 3 });

  const completedEvents = await prisma.coupang_raw_change_event.findMany({
    where: {
      coupang_raw_change_event_id: {
        in: [
          normalEvent.coupang_raw_change_event_id,
          interruptedEvent.coupang_raw_change_event_id,
          retryEvent.coupang_raw_change_event_id,
        ],
      },
    },
    orderBy: { coupang_raw_change_event_id: "asc" },
    select: {
      process_status: true,
      worker_attempt_count: true,
      execution_token: true,
      processed_at: true,
      worker_job_id: true,
    },
  });
  assert.deepEqual(
    completedEvents.map((event) => ({
      processStatus: event.process_status,
      attemptCount: event.worker_attempt_count,
      executionToken: event.execution_token,
      processed: Boolean(event.processed_at),
      workerJobId: event.worker_job_id,
    })),
    [
      {
        processStatus: "DONE",
        attemptCount: 1,
        executionToken: null,
        processed: true,
        workerJobId: worker.worker_job_id,
      },
      {
        processStatus: "DONE",
        attemptCount: 3,
        executionToken: null,
        processed: true,
        workerJobId: worker.worker_job_id,
      },
      {
        processStatus: "DONE",
        attemptCount: 2,
        executionToken: null,
        processed: true,
        workerJobId: worker.worker_job_id,
      },
    ]
  );
  assert.equal(
    await prisma.shipment_address_change_work.count({
      where: {
        raw_change_event_id: {
          in: [
            normalEvent.coupang_raw_change_event_id,
            interruptedEvent.coupang_raw_change_event_id,
            retryEvent.coupang_raw_change_event_id,
          ],
        },
      },
    }),
    3
  );

  const skipped = await prisma.coupang_raw_change_event.findUniqueOrThrow({
    where: {
      coupang_raw_change_event_id: skippedEvent.coupang_raw_change_event_id,
    },
  });
  assert.equal(skipped.process_status, "SKIPPED");
  assert.equal(skipped.execution_token, null);
  assert.ok(skipped.processed_at);
  assert.match(skipped.last_error_message ?? "", /external_order_id/);

  const workCountBeforeSecondRun =
    await prisma.shipment_address_change_work.count();
  assert.equal(workCountBeforeSecondRun, 3);

  const secondRun = await trackShipmentAddressChangeWork({
    limit: 10,
    workerLease: currentLease,
  });
  assert.equal(secondRun.candidateCount, 0);
  assert.equal(secondRun.claimedCount, 0);
  assert.equal(secondRun.reclaimedCount, 0);
  assert.equal(
    await prisma.shipment_address_change_work.count(),
    workCountBeforeSecondRun,
    "Terminal events were processed more than once."
  );

  console.log(
    "Shipment address change events reject stale completion and recover interrupted PROCESSING work."
  );
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
