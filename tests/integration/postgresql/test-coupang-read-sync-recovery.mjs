import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-read-sync-recovery-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const NOW = new Date("2026-07-19T12:00:00.000Z");
const NOW_TEXT = new Date("2026-07-19T21:00:00+09:00");
const STALE_TEXT = new Date("2026-07-19T20:30:00+09:00");
const RECENT_TEXT = new Date("2026-07-19T20:55:00+09:00");

let prisma;

async function createPendingLog(input) {
  return prisma.coupang_api_call_log.create({
    data: {
      channel: "COUPANG",
      api_name: input.apiName,
      method: "GET",
      status_filter: "ACCEPT",
      processed_status: "PENDING",
      request_started_at: input.requestStartedAt ?? input.updatedAt,
      worker_job_id: input.workerJobId ?? null,
      created_at: input.updatedAt,
      updated_at: input.updatedAt,
    },
  });
}

async function advanceToReceived(logId, timestamp) {
  await prisma.coupang_api_call_log.update({
    where: { coupang_api_call_log_id: logId },
    data: {
      processed_status: "RECEIVED",
      http_status_code: 200,
      response_hash: `response-${logId}`,
      received_at: timestamp,
      updated_at: timestamp,
    },
  });
}

async function advanceToProcessing(logId, timestamp) {
  await prisma.coupang_api_call_log.update({
    where: { coupang_api_call_log_id: logId },
    data: {
      processed_status: "PROCESSING",
      response_row_count: 2,
      processing_started_at: timestamp,
      updated_at: timestamp,
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    getCoupangReadSyncHealth,
    recoverInterruptedCoupangReadSyncs,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/read-sync-recovery-service"
  );

  const liveWorker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "live-read-sync-worker",
      worker_name: "Live read sync worker",
      worker_type: "COUPANG_SYNC",
      status: "RUNNING",
      started_at: new Date("2026-07-19T20:40:00+09:00"),
      locked_by: "live-owner",
      lease_token: "00000000-0000-4000-8000-000000000101",
      claim_generation: 1,
      locked_until: new Date("2026-07-19T21:10:00+09:00"),
      updated_at: NOW_TEXT,
    },
  });
  const expiredWorker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "expired-read-sync-worker",
      worker_name: "Expired read sync worker",
      worker_type: "COUPANG_SYNC",
      status: "RUNNING",
      started_at: new Date("2026-07-19T20:00:00+09:00"),
      locked_by: "expired-owner",
      lease_token: "00000000-0000-4000-8000-000000000102",
      claim_generation: 1,
      locked_until: new Date("2026-07-19T20:58:00+09:00"),
      updated_at: STALE_TEXT,
    },
  });

  const stalePending = await createPendingLog({
    apiName: "stale.pending",
    updatedAt: STALE_TEXT,
  });
  const staleReceived = await createPendingLog({
    apiName: "stale.received",
    updatedAt: STALE_TEXT,
  });
  await advanceToReceived(
    staleReceived.coupang_api_call_log_id,
    STALE_TEXT
  );
  const staleProcessing = await createPendingLog({
    apiName: "stale.processing",
    updatedAt: STALE_TEXT,
  });
  await advanceToReceived(
    staleProcessing.coupang_api_call_log_id,
    STALE_TEXT
  );
  await advanceToProcessing(
    staleProcessing.coupang_api_call_log_id,
    STALE_TEXT
  );
  const recentPending = await createPendingLog({
    apiName: "recent.pending",
    updatedAt: RECENT_TEXT,
  });
  const liveWorkerCall = await createPendingLog({
    apiName: "live.worker.call",
    updatedAt: STALE_TEXT,
    requestStartedAt: new Date("2026-07-19T20:45:00+09:00"),
    workerJobId: liveWorker.worker_job_id,
  });
  const expiredWorkerCall = await createPendingLog({
    apiName: "expired.worker.call",
    updatedAt: STALE_TEXT,
    requestStartedAt: new Date("2026-07-19T20:10:00+09:00"),
    workerJobId: expiredWorker.worker_job_id,
  });
  const previousRunCall = await createPendingLog({
    apiName: "previous.run.call",
    updatedAt: STALE_TEXT,
    requestStartedAt: new Date("2026-07-19T20:20:00+09:00"),
    workerJobId: liveWorker.worker_job_id,
  });

  const firstRecovery = await recoverInterruptedCoupangReadSyncs({ now: NOW });

  assert(firstRecovery.checkedCount === 6, "Unexpected stale candidate count.");
  assert(firstRecovery.recoveredCount === 5, "Unexpected recovered call count.");
  assert(firstRecovery.activeOwnerCount === 1, "The live worker was not protected.");

  const rows = await prisma.coupang_api_call_log.findMany({
    orderBy: { coupang_api_call_log_id: "asc" },
  });
  const rowById = new Map(
    rows.map((row) => [row.coupang_api_call_log_id, row])
  );

  for (const id of [
    stalePending.coupang_api_call_log_id,
    staleReceived.coupang_api_call_log_id,
    staleProcessing.coupang_api_call_log_id,
    expiredWorkerCall.coupang_api_call_log_id,
    previousRunCall.coupang_api_call_log_id,
  ]) {
    const row = rowById.get(id);
    assert(row?.processed_status === "FAILED", `Log ${id} was not failed.`);
    assert(
      row?.error_code === "PROCESS_INTERRUPTED",
      `Log ${id} has an unexpected error code.`
    );
    assert(
      row?.processed_at?.getTime() === NOW_TEXT.getTime(),
      `Log ${id} has no recovery time.`
    );
  }

  assert(
    rowById.get(recentPending.coupang_api_call_log_id)?.processed_status ===
      "PENDING",
    "A recent call was recovered too early."
  );
  assert(
    rowById.get(liveWorkerCall.coupang_api_call_log_id)?.processed_status ===
      "PENDING",
    "A call owned by a live worker was recovered."
  );

  const secondRecovery = await recoverInterruptedCoupangReadSyncs({ now: NOW });
  assert(secondRecovery.recoveredCount === 0, "Recovery was not idempotent.");

  const recoveryLogs = await prisma.server_job_logs.findMany({
    where: { job_type: "COUPANG_READ_SYNC_RECOVERY" },
  });
  assert(recoveryLogs.length === 1, "Recovery wrote duplicate maintenance logs.");
  assert(
    recoveryLogs[0].summary_warning_count === 5,
    "The maintenance log has an incorrect warning count."
  );

  const health = await getCoupangReadSyncHealth({ now: NOW });
  assert(health.interruptedCount === 5, "Health summary missed interruptions.");
  assert(health.activeCallCount === 2, "Health summary active count is incorrect.");
  assert(health.latestInterrupted, "Health summary has no latest interruption.");

  console.log("Coupang read sync interruption recovery verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
