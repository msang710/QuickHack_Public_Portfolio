import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-carrier-invoice-issue-recovery-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const NOW = new Date("2026-08-07T12:00:00.000Z");
const STALE_AT = new Date("2026-08-07T11:30:00.000Z");
const RECENT_AT = new Date("2026-08-07T11:55:00.000Z");

let prisma;
let sequence = 0;

async function createIssue(input) {
  sequence += 1;
  const printBatch =
    await prisma.sales_channel_shipment_list_print_batches.create({
      data: {
        channel: "COUPANG",
        tab_key: `recovery-${sequence}`,
        tab_label: `Recovery ${sequence}`,
        print_date: new Date("2026-08-07T00:00:00.000Z"),
        batch_no: sequence,
        batch_label: `Recovery batch ${sequence}`,
        item_count: 1,
        package_group_count: 1,
        batch_status: "CONFIRMED",
        confirmed_at: input.startedAt,
        created_at: input.startedAt,
        updated_at: input.startedAt,
      },
    });
  const packageGroup = await prisma.shipment_package_groups.create({
    data: {
      grouping_key: `RECOVERY:${sequence}`,
      receiver_name_snapshot: "Recovery receiver",
      receiver_address_snapshot: "Recovery address",
      group_status: "FROZEN",
      frozen_at: input.startedAt,
      created_at: input.startedAt,
      updated_at: input.startedAt,
    },
  });

  return prisma.carrier_invoice_issue_batches.create({
    data: {
      shipment_list_print_batch_id:
        printBatch.shipment_list_print_batch_id,
      request_key: `LOGEN:RECOVERY:${sequence}`,
      batch_status: "ALLOCATING",
      requested_package_group_count: 1,
      attempt_count: 1,
      allocation_request_dispatched: input.requestDispatched ? 1 : 0,
      started_at: input.startedAt,
      created_at: input.startedAt,
      updated_at: input.startedAt,
      items: {
        create: {
          package_group_id: packageGroup.package_group_id,
          issue_sequence: 1,
          revision_no: 1,
          item_status: "PENDING",
          created_at: input.startedAt,
          updated_at: input.startedAt,
        },
      },
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { recoverInterruptedCarrierInvoiceIssues } = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-recovery-service"
  );

  const staleUndispatched = await createIssue({
    startedAt: STALE_AT,
    requestDispatched: false,
  });
  const staleDispatched = await createIssue({
    startedAt: STALE_AT,
    requestDispatched: true,
  });
  const recentDispatched = await createIssue({
    startedAt: RECENT_AT,
    requestDispatched: true,
  });

  const first = await recoverInterruptedCarrierInvoiceIssues({ now: NOW });
  assert.equal(first.checkedCount, 2);
  assert.equal(first.recoveredCount, 2);
  assert.equal(first.retryableCount, 1);
  assert.equal(first.reviewRequiredCount, 1);
  assert.equal(first.changedBeforeRecoveryCount, 0);

  const stored = await prisma.carrier_invoice_issue_batches.findMany({
    where: {
      carrier_invoice_issue_batch_id: {
        in: [
          staleUndispatched.carrier_invoice_issue_batch_id,
          staleDispatched.carrier_invoice_issue_batch_id,
          recentDispatched.carrier_invoice_issue_batch_id,
        ],
      },
    },
    include: { items: true },
  });
  const byId = new Map(
    stored.map((batch) => [batch.carrier_invoice_issue_batch_id, batch])
  );
  const retryable = byId.get(
    staleUndispatched.carrier_invoice_issue_batch_id
  );
  const review = byId.get(staleDispatched.carrier_invoice_issue_batch_id);
  const recent = byId.get(recentDispatched.carrier_invoice_issue_batch_id);

  assert.equal(retryable?.batch_status, "FAILED");
  assert.equal(
    retryable?.error_code,
    "PROCESS_INTERRUPTED_BEFORE_ALLOCATION_DISPATCH"
  );
  assert.equal(retryable?.review_required_at, null);
  assert.equal(retryable?.items[0]?.item_status, "FAILED");
  assert.equal(retryable?.items[0]?.result_code, "REQUEST_NOT_DISPATCHED");

  assert.equal(review?.batch_status, "REVIEW_REQUIRED");
  assert.equal(
    review?.error_code,
    "PROCESS_INTERRUPTED_AFTER_ALLOCATION_DISPATCH"
  );
  assert.equal(review?.review_required_at?.getTime(), NOW.getTime());
  assert.equal(review?.items[0]?.item_status, "MISSING_RESPONSE");
  assert.equal(review?.items[0]?.result_code, "OUTCOME_UNCERTAIN");

  assert.equal(recent?.batch_status, "ALLOCATING");
  assert.equal(recent?.items[0]?.item_status, "PENDING");

  const second = await recoverInterruptedCarrierInvoiceIssues({ now: NOW });
  assert.equal(second.checkedCount, 0);
  assert.equal(second.recoveredCount, 0);

  const logs = await prisma.server_job_logs.findMany({
    where: { job_type: "CARRIER_INVOICE_ISSUE_RECOVERY" },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].summary_processed_count, 2);
  assert.equal(logs[0].summary_succeeded_count, 2);
  assert.equal(logs[0].summary_warning_count, 1);

  console.log(
    "Interrupted carrier invoice issues recover without resending dispatched allocations."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
