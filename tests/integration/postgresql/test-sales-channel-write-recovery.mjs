import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { postgresqlSqlState } from "@/quickhack_server/core/database/postgres-errors";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sales-channel-write-recovery-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const NOW = new Date("2026-08-07T12:00:00.000Z");
const NOW_TEXT = new Date(NOW);
const STALE_TEXT = new Date("2026-08-07T11:30:00.000Z");
const RECENT_TEXT = new Date("2026-08-07T11:55:00.000Z");

let prisma;
let requestSequence = 0;

async function createRequest(input) {
  requestSequence += 1;
  const phaseTimestamp = input.phaseTimestamp ?? input.updatedAt;
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: input.status,
      idempotency_key: `RECOVERY:${requestSequence}`,
      request_digest: "test-fixture",
      method: "PUT",
      endpoint_path: `/v2/providers/openapi/apis/api/v4/vendors/test/ordersheets/test/acknowledgement`,
      source_menu_key: "shipment-management",
      source_entity_type: "COUPANG_ORDER",
      source_entity_id: `RECOVERY-${requestSequence}`,
      worker_job_id: input.workerJobId ?? null,
      requested_at: input.updatedAt,
      sending_at:
        input.status === "SENDING"
          ? phaseTimestamp
          : input.sendingAt ?? (input.status === "VERIFYING" ? STALE_TEXT : null),
      verifying_at: input.status === "VERIFYING" ? phaseTimestamp : null,
      created_at: input.updatedAt,
      updated_at: input.updatedAt,
    },
  });

  if (input.status === "VERIFYING") {
    await prisma.sales_channel_write_request_attempts.create({
      data: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        attempt_no: 1,
        attempt_type: "WRITE",
        attempt_status: "SUCCEEDED",
        trigger_type: "INITIAL",
        method: "PUT",
        endpoint_path: request.endpoint_path,
        started_at: input.sendingAt ?? STALE_TEXT,
        completed_at: input.sendingAt ?? STALE_TEXT,
        request_dispatched: 1,
        response_received: 1,
      },
    });
  }

  const attempt =
    input.createAttempt === false
      ? null
      : await prisma.sales_channel_write_request_attempts.create({
          data: {
            sales_channel_write_request_id:
              request.sales_channel_write_request_id,
            attempt_no: input.status === "VERIFYING" ? 2 : 1,
            attempt_type:
              input.status === "VERIFYING" ? "VERIFY_READ" : "WRITE",
            attempt_status: "SENDING",
            trigger_type:
              input.status === "VERIFYING" ? "IMMEDIATE_VERIFY" : "INITIAL",
            method: input.status === "VERIFYING" ? "GET" : "PUT",
            endpoint_path:
              input.status === "VERIFYING"
                ? "COUPANG_ORDER"
                : request.endpoint_path,
            started_at: phaseTimestamp,
            request_dispatched: input.requestDispatched ? 1 : 0,
          },
        });

  return { request, attempt };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { recoverInterruptedSalesChannelWrites } = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-recovery-service"
  );

  const liveWorker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "live-sales-channel-write-worker",
      worker_name: "Live sales-channel write worker",
      worker_type: "COUPANG_SYNC",
      status: "RUNNING",
      started_at: new Date("2026-08-07T11:20:00.000Z"),
      locked_by: "live-owner",
      lease_token: "00000000-0000-4000-8000-000000000201",
      claim_generation: 1,
      locked_until: new Date("2026-08-07T12:10:00.000Z"),
      updated_at: NOW_TEXT,
    },
  });

  const stalePending = await createRequest({
    status: "PENDING",
    updatedAt: STALE_TEXT,
    requestDispatched: false,
  });
  const legacyPendingWithoutAttempt = await createRequest({
    status: "PENDING",
    updatedAt: STALE_TEXT,
    requestDispatched: false,
    createAttempt: false,
  });
  const staleUndispatched = await createRequest({
    status: "SENDING",
    updatedAt: STALE_TEXT,
    requestDispatched: false,
  });
  const staleDispatched = await createRequest({
    status: "SENDING",
    updatedAt: STALE_TEXT,
    requestDispatched: true,
  });
  const staleVerifying = await createRequest({
    status: "VERIFYING",
    updatedAt: STALE_TEXT,
    requestDispatched: true,
  });
  const recentSending = await createRequest({
    status: "SENDING",
    updatedAt: RECENT_TEXT,
    requestDispatched: true,
  });
  const liveWorkerRequest = await createRequest({
    status: "SENDING",
    updatedAt: STALE_TEXT,
    phaseTimestamp: new Date("2026-08-07T11:25:00.000Z"),
    requestDispatched: true,
    workerJobId: liveWorker.worker_job_id,
  });
  const previousWorkerRunRequest = await createRequest({
    status: "SENDING",
    updatedAt: STALE_TEXT,
    phaseTimestamp: new Date("2026-08-07T11:10:00.000Z"),
    requestDispatched: true,
    workerJobId: liveWorker.worker_job_id,
  });
  const localPending = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: "LOCAL_PENDING",
      failure_stage: "LOCAL_FINALIZATION",
      idempotency_key: "RECOVERY:LOCAL-PENDING",
      request_digest: "test-fixture",
      method: "PUT",
      endpoint_path: "/local-pending",
      source_menu_key: "shipment-management",
      source_entity_type: "COUPANG_ORDER",
      source_entity_id: "RECOVERY-LOCAL-PENDING",
      requested_at: STALE_TEXT,
      sending_at: STALE_TEXT,
      verifying_at: STALE_TEXT,
      updated_at: STALE_TEXT,
      created_at: STALE_TEXT,
    },
  });

  const firstRecovery = await recoverInterruptedSalesChannelWrites({ now: NOW });

  assert.equal(firstRecovery.checkedCount, 7);
  assert.equal(firstRecovery.recoveredCount, 6);
  assert.equal(firstRecovery.notAppliedCount, 3);
  assert.equal(firstRecovery.reviewRequiredCount, 3);
  assert.equal(firstRecovery.activeOwnerCount, 1);
  assert.equal(firstRecovery.changedBeforeRecoveryCount, 0);

  const recoveredRequests = await prisma.sales_channel_write_requests.findMany({
    where: {
      sales_channel_write_request_id: {
        in: [
          stalePending.request.sales_channel_write_request_id,
          legacyPendingWithoutAttempt.request.sales_channel_write_request_id,
          staleUndispatched.request.sales_channel_write_request_id,
          staleDispatched.request.sales_channel_write_request_id,
          staleVerifying.request.sales_channel_write_request_id,
          recentSending.request.sales_channel_write_request_id,
          liveWorkerRequest.request.sales_channel_write_request_id,
          previousWorkerRunRequest.request.sales_channel_write_request_id,
          localPending.sales_channel_write_request_id,
        ],
      },
    },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });
  const requestById = new Map(
    recoveredRequests.map((request) => [
      request.sales_channel_write_request_id,
      request,
    ])
  );

  const pending = requestById.get(
    stalePending.request.sales_channel_write_request_id
  );
  assert.equal(pending?.request_status, "NOT_APPLIED");
  assert.equal(pending?.error_code, "PROCESS_INTERRUPTED_BEFORE_DISPATCH");
  assert.equal(pending?.attempts.at(-1)?.attempt_status, "FAILED");
  assert.equal(pending?.attempts.at(-1)?.request_dispatched, 0);

  const legacyPending = requestById.get(
    legacyPendingWithoutAttempt.request.sales_channel_write_request_id
  );
  assert.equal(legacyPending?.request_status, "NOT_APPLIED");
  assert.equal(
    legacyPending?.error_code,
    "PROCESS_INTERRUPTED_BEFORE_DISPATCH"
  );
  assert.equal(legacyPending?.attempts.length, 0);

  const undispatched = requestById.get(
    staleUndispatched.request.sales_channel_write_request_id
  );
  assert.equal(undispatched?.request_status, "NOT_APPLIED");
  assert.equal(undispatched?.error_code, "PROCESS_INTERRUPTED_BEFORE_DISPATCH");
  assert.equal(undispatched?.review_required_at, null);
  assert.equal(undispatched?.attempts.at(-1)?.attempt_status, "FAILED");
  assert.equal(undispatched?.attempts.at(-1)?.external_applied_unknown, 0);

  const dispatched = requestById.get(
    staleDispatched.request.sales_channel_write_request_id
  );
  assert.equal(dispatched?.request_status, "REVIEW_REQUIRED");
  assert.equal(dispatched?.error_code, "PROCESS_INTERRUPTED_AFTER_DISPATCH");
  assert.equal(dispatched?.review_required_at?.getTime(), NOW_TEXT.getTime());
  assert.equal(dispatched?.attempts.at(-1)?.attempt_status, "AMBIGUOUS");
  assert.equal(dispatched?.attempts.at(-1)?.external_applied_unknown, 1);

  const verifying = requestById.get(
    staleVerifying.request.sales_channel_write_request_id
  );
  assert.equal(verifying?.request_status, "REVIEW_REQUIRED");
  assert.equal(
    verifying?.error_code,
    "PROCESS_INTERRUPTED_DURING_VERIFICATION"
  );
  assert.equal(verifying?.attempts[0]?.attempt_status, "SUCCEEDED");
  assert.equal(verifying?.attempts.at(-1)?.attempt_status, "AMBIGUOUS");
  assert.equal(verifying?.attempts.at(-1)?.external_applied_unknown, 1);

  assert.equal(
    requestById.get(recentSending.request.sales_channel_write_request_id)
      ?.request_status,
    "SENDING"
  );
  assert.equal(
    requestById.get(liveWorkerRequest.request.sales_channel_write_request_id)
      ?.request_status,
    "SENDING"
  );
  assert.equal(
    requestById.get(
      previousWorkerRunRequest.request.sales_channel_write_request_id
    )?.request_status,
    "REVIEW_REQUIRED"
  );
  assert.equal(
    requestById.get(localPending.sales_channel_write_request_id)?.request_status,
    "LOCAL_PENDING"
  );

  const secondRecovery = await recoverInterruptedSalesChannelWrites({ now: NOW });
  assert.equal(secondRecovery.recoveredCount, 0);
  assert.equal(secondRecovery.activeOwnerCount, 1);

  const recoveryLogs = await prisma.server_job_logs.findMany({
    where: { job_type: "SALES_CHANNEL_WRITE_RECOVERY" },
  });
  assert.equal(recoveryLogs.length, 1);
  assert.equal(recoveryLogs[0].summary_processed_count, 7);
  assert.equal(recoveryLogs[0].summary_succeeded_count, 6);
  assert.equal(recoveryLogs[0].summary_warning_count, 3);

  const rollbackCandidate = await createRequest({
    status: "SENDING",
    updatedAt: STALE_TEXT,
    requestDispatched: true,
  });
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_sales_channel_write_recovery_log_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced recovery log failure';
    END;
    $$;
    CREATE TRIGGER fail_sales_channel_write_recovery_log
    BEFORE INSERT ON server_job_logs
    FOR EACH ROW
    WHEN (NEW.job_type = 'SALES_CHANNEL_WRITE_RECOVERY')
    EXECUTE FUNCTION fail_sales_channel_write_recovery_log_fn();
  `);

  await assert.rejects(
    recoverInterruptedSalesChannelWrites({ now: NOW }),
    (error) => postgresqlSqlState(error) === "P0001"
  );
  const rolledBackRequest =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          rollbackCandidate.request.sales_channel_write_request_id,
      },
    });
  const rolledBackAttempt =
    await prisma.sales_channel_write_request_attempts.findUniqueOrThrow({
      where: {
        sales_channel_write_request_attempt_id:
          rollbackCandidate.attempt.sales_channel_write_request_attempt_id,
      },
    });
  assert.equal(rolledBackRequest.request_status, "SENDING");
  assert.equal(rolledBackAttempt.attempt_status, "SENDING");

  await prisma.$executeRawUnsafe(`
    DROP TRIGGER fail_sales_channel_write_recovery_log ON server_job_logs;
    DROP FUNCTION fail_sales_channel_write_recovery_log_fn();
  `);
  const recoveryAfterRollback = await recoverInterruptedSalesChannelWrites({
    now: NOW,
  });
  assert.equal(recoveryAfterRollback.recoveredCount, 1);
  assert.equal(recoveryAfterRollback.reviewRequiredCount, 1);

  console.log(
    "Interrupted sales-channel writes recover atomically without resend, preserve live owners, and remain idempotent."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
