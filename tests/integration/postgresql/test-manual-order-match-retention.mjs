import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-manual-order-match-retention-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { runManualOrderMatchRetention } = await import(
    "@/quickhack_server/sales-channel/coupang/manual-order-match-retention-service"
  );
  const { requiredApiDateTime } = await import(
    "@/quickhack_server/core/database/time-boundary"
  );
  const referenceDate = new Date("2026-08-31T00:00:00.000Z");
  const user = await prisma.users.create({
    data: {
      username: "manual-retention-manager",
      password_hash: "integration-test-only",
      role: "MANAGER",
      created_at: referenceDate,
      updated_at: referenceDate,
    },
  });
  const work = await prisma.order_matching_work_queue.create({
    data: {
      external_order_id: "RETENTION-ORDER",
      external_shipment_id: "RETENTION-SHIPMENT",
      external_vendor_item_id: "RETENTION-VENDOR",
      ordered_quantity: 1,
      matchable_quantity: 1,
      ordered_at: referenceDate,
      created_at: referenceDate,
      updated_at: referenceDate,
    },
  });

  async function createReceipt(receiptId, input) {
    return prisma.manual_order_match_selection_receipts.create({
      data: {
        receipt_id: receiptId,
        work_item_id: work.work_item_id,
        operation: "ASSIGN",
        pg_no: input.pgNo,
        candidate_fingerprint_hash: receiptId,
        issued_to_user_id: user.user_id,
        work_revision: 0,
        issued_at: new Date("2026-08-01T00:00:00.000Z"),
        expires_at: input.expiresAt,
        consumed_at: input.consumedAt ?? null,
      },
    });
  }

  await createReceipt("00000000-0000-4000-8000-000000000001", {
    pgNo: "RETENTION0001",
    expiresAt: new Date("2026-08-23T23:59:59.999Z"),
  });
  await createReceipt("00000000-0000-4000-8000-000000000002", {
    pgNo: "RETENTION0002",
    expiresAt: new Date("2026-08-24T00:00:00.000Z"),
  });
  await createReceipt("00000000-0000-4000-8000-000000000003", {
    pgNo: "RETENTION0003",
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    consumedAt: new Date("2026-08-23T23:59:59.999Z"),
  });
  await createReceipt("00000000-0000-4000-8000-000000000004", {
    pgNo: "RETENTION0004",
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  });

  async function createIntent(leaseId, input) {
    return prisma.manual_order_match_intent_leases.create({
      data: {
        lease_id: leaseId,
        external_order_id: "RETENTION-ORDER",
        external_shipment_id: "RETENTION-SHIPMENT",
        pg_nos: [input.pgNo],
        command_key: leaseId,
        owner_user_id: user.user_id,
        lease_status: input.status,
        acquired_at: new Date("2026-07-01T00:00:00.000Z"),
        expires_at: input.expiresAt,
        released_at: input.releasedAt ?? null,
      },
    });
  }

  await createIntent("10000000-0000-4000-8000-000000000001", {
    pgNo: "RETENTION1001",
    status: "RELEASED",
    expiresAt: new Date("2026-07-01T00:00:30.000Z"),
    releasedAt: new Date("2026-07-31T23:59:59.999Z"),
  });
  await createIntent("10000000-0000-4000-8000-000000000002", {
    pgNo: "RETENTION1002",
    status: "RELEASED",
    expiresAt: new Date("2026-07-01T00:00:30.000Z"),
    releasedAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  await createIntent("10000000-0000-4000-8000-000000000003", {
    pgNo: "RETENTION1003",
    status: "ACTIVE",
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  await createIntent("10000000-0000-4000-8000-000000000004", {
    pgNo: "RETENTION1004",
    status: "ACTIVE",
    expiresAt: new Date("2026-08-30T00:00:00.000Z"),
  });

  await prisma.employee_activity_logs.create({
    data: {
      user_id: user.user_id,
      action_type: "CHANNEL_ORDER_MANUAL_REPLACE",
      target_type: "SALES_CHANNEL_ORDER_ITEM",
      target_id: String(work.work_item_id),
      result: "SUCCESS",
      created_at: new Date("2020-01-01T00:00:00.000Z"),
      changes: {
        create: {
          field_name: "pgNo",
          before_value: "OLD",
          after_value: "NEW",
        },
      },
    },
  });
  const auditBefore = {
    logs: await prisma.employee_activity_logs.count(),
    changes: await prisma.employee_activity_log_changes.count(),
  };

  let leaseChecks = 0;
  const result = await runManualOrderMatchRetention({
    referenceDate,
    batchSize: 1,
    maxBatches: 10,
    context: {
      async assertLeaseActive() {
        leaseChecks += 1;
      },
      async updateProgress() {},
    },
  });
  assert.equal(result.deletedByCategory.RECEIPT, 2);
  assert.equal(result.deletedByCategory.INTENT_LEASE, 1);
  assert.equal(result.expiredIntentCount, 1);
  assert.equal(result.backlog, false);
  assert.ok(leaseChecks > 0);

  assert.deepEqual(
    (await prisma.manual_order_match_selection_receipts.findMany({
      orderBy: { receipt_id: "asc" },
      select: { receipt_id: true },
    })).map((row) => row.receipt_id),
    [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
    ]
  );
  assert.deepEqual(
    (await prisma.manual_order_match_intent_leases.findMany({
      orderBy: { lease_id: "asc" },
      select: { lease_id: true },
    })).map((row) => row.lease_id),
    [
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
    ]
  );
  const normalizedExpired =
    await prisma.manual_order_match_intent_leases.findUniqueOrThrow({
      where: { lease_id: "10000000-0000-4000-8000-000000000004" },
    });
  assert.equal(normalizedExpired.lease_status, "EXPIRED");
  assert.equal(normalizedExpired.released_at?.getTime(), referenceDate.getTime());
  assert.deepEqual(
    {
      logs: await prisma.employee_activity_logs.count(),
      changes: await prisma.employee_activity_log_changes.count(),
    },
    auditBefore,
    "Manual retention must not delete the business audit history."
  );

  const idempotent = await runManualOrderMatchRetention({
    referenceDate,
    context: {
      async assertLeaseActive() {},
      async updateProgress() {},
    },
  });
  assert.equal(idempotent.deletedCount, 0);
  assert.equal(idempotent.expiredIntentCount, 0);

  const { ensureRegisteredWorkerJobs } = await import(
    "@/quickhack_server/workers/worker-jobs"
  );
  const { MANUAL_ORDER_MATCH_WORKER_KEY } = await import(
    "@/quickhack_server/workers/worker-keys"
  );
  await ensureRegisteredWorkerJobs();
  const registered = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: MANUAL_ORDER_MATCH_WORKER_KEY.retention },
  });
  assert.equal(registered.schedule_enabled, 1);
  assert.match(requiredApiDateTime(registered.next_run_at), / 04:20:00$/);

  console.log(
    "Manual order match receipt and intent retention boundaries, audit preservation, idempotency, and worker registration verified."
  );
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
