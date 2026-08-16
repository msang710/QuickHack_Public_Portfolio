import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { recordValidatedIntegrationInboxEvidence } from "@/quickhack_server/integration/inbox-service";
import {
  claimIntegrationProjectionJob,
  claimIntegrationProjectionJobById,
  runClaimedIntegrationProjection,
} from "@/quickhack_server/integration/projection-service";
import {
  appendCarrierTrackingEvents,
  observeCarrierReconciliationRevision,
  openCarrierReconciliationWork,
  resolveCarrierReconciliationWork,
  throttleCarrierTrackingAndOpenReadReview,
} from "@/quickhack_server/shipment/carrier-integration/persistence-service";
import { getLogenTrackingBatch } from "@/quickhack_server/shipment/carrier-integration/logen/workflow-service";
import {
  resolveLogenTrackingOccurredAt,
  validateLogenTrackingBatch,
  type NormalizedLogenTrackingBatch,
  type NormalizedLogenTrackingItem,
} from "@/quickhack_server/shipment/carrier-integration/logen/tracking-schema";
import { projectPackageGroupDeliveryStatus } from "@/quickhack_server/shipment/delivery-status-projection-service";
import { assertWorkerLeaseActive } from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import { addSeconds, quickHackClock } from "@/quickhack_shared/core/time";
import {
  CARRIER_SHIPMENT_STATUS,
  classifyLogenTrackingStatus,
} from "@/quickhack_shared/shipment/carrier-tracking-status";

const DEFAULT_TRACKING_BATCH_SIZE = 30;
const DEFAULT_TRACKING_REFRESH_SECONDS = 5 * 60;
const TRACKING_PROJECTION_HANDLER = "LOGEN_TRACKING_BATCH_V1";
const TRACKING_PROJECTION_LOCK_SECONDS = 5 * 60;

type TrackingProjectionContext = {
  apiCallLogId: number;
  workerJobId: number | null;
  responseHash: string;
  candidates: Array<{
    carrierShipmentId: number;
    packageGroupId: number;
    trackingNumber: string;
  }>;
};

type TrackingProjectionSummary = {
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  reviewRequiredCount: number;
  transitionedCount: number;
  completedCount: number;
};

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER
) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function projectionContext(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Logen tracking projection context is missing.");
  }
  const candidateValues = value.candidates;
  if (!Array.isArray(candidateValues)) {
    throw new Error("Logen tracking projection candidates are missing.");
  }
  return value as unknown as TrackingProjectionContext;
}

function normalizedBatch(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Logen tracking normalized evidence is missing.");
  }
  const items = value.items;
  if (!Array.isArray(items)) {
    throw new Error("Logen tracking normalized items are missing.");
  }
  return value as unknown as NormalizedLogenTrackingBatch;
}

function evidenceKey(shipmentId: number, item: NormalizedLogenTrackingItem) {
  const latest = item.events.at(-1);
  return [
    shipmentId,
    latest?.scanDate ?? "unknown-date",
    latest?.scanTime ?? "unknown-time",
    latest?.statusName ?? "unknown-status",
  ].join(":");
}

type ReviewKey = {
  carrierCode: string;
  operationType: string;
  lookupKeyType: string;
  lookupKeyValue: string;
};

function trackingReviewKey(operationType: string, trackingNumber: string): ReviewKey {
  return {
    carrierCode: "LOGEN",
    operationType,
    lookupKeyType: "TRACKING_NUMBER",
    lookupKeyValue: trackingNumber,
  };
}

async function observeReview(
  tx: Prisma.TransactionClient,
  operationType: string,
  trackingNumber: string
) {
  return observeCarrierReconciliationRevision({
    ...trackingReviewKey(operationType, trackingNumber),
    client: tx,
  });
}

async function resolveObservedReview(
  tx: Prisma.TransactionClient,
  operationType: string,
  trackingNumber: string,
  expectedRevision: number | null
) {
  return resolveCarrierReconciliationWork({
    ...trackingReviewKey(operationType, trackingNumber),
    expectedRevision,
    client: tx,
  });
}

async function openTrackingReview(
  operationType: string,
  trackingNumber: string,
  input: {
    reason: string;
    apiCallLogId?: number | null;
    error?: unknown;
    client?: Prisma.TransactionClient;
  }
) {
  return openCarrierReconciliationWork({
    ...trackingReviewKey(operationType, trackingNumber),
    apiCallLogId: input.apiCallLogId ?? null,
    reason: input.reason,
    lastErrorMessage:
      input.error == null
        ? null
        : input.error instanceof Error
          ? input.error.message
          : String(input.error),
    client: input.client,
  });
}

async function projectLogenTrackingEvidence(
  tx: Prisma.TransactionClient,
  evidence: Prisma.integration_evidencesGetPayload<Record<string, never>>,
  job: Prisma.integration_projection_jobsGetPayload<Record<string, never>>
): Promise<TrackingProjectionSummary> {
  const context = projectionContext(job.projection_context);
  const batch = normalizedBatch(evidence.normalized_result);
  const itemsByTrackingNumber = new Map(
    batch.items.map((item) => [item.trackingNumber, item])
  );
  const summary: TrackingProjectionSummary = {
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    reviewRequiredCount: 0,
    transitionedCount: 0,
    completedCount: 0,
  };

  for (const candidate of [...context.candidates].sort(
    (left, right) =>
      left.packageGroupId - right.packageGroupId ||
      left.carrierShipmentId - right.carrierShipmentId
  )) {
    summary.processedCount += 1;
    const item = itemsByTrackingNumber.get(candidate.trackingNumber);
    if (!item?.succeeded) {
      summary.failedCount += 1;
      summary.reviewRequiredCount += 1;
      await throttleCarrierTrackingAndOpenReadReview({
        carrierShipmentId: candidate.carrierShipmentId,
        trackingNumber: candidate.trackingNumber,
        client: tx,
        apiCallLogId: context.apiCallLogId,
        error: item?.resultMessage ?? "LOGEN_TRACKING_ITEM_MISSING",
        reason:
          item?.resultMessage ??
          "로젠 화물추적 응답에 요청한 송장 결과가 없습니다.",
      });
      continue;
    }

    const readRevision = await observeReview(
      tx,
      "TRACKING_SYNC_READ",
      candidate.trackingNumber
    );
    const classificationRevision = await observeReview(
      tx,
      "TRACKING_STATUS_CLASSIFICATION",
      candidate.trackingNumber
    );
    const projectionRevision = await observeReview(
      tx,
      "TRACKING_STATUS_PROJECTION",
      candidate.trackingNumber
    );
    const timeCoverageRevision = await observeReview(
      tx,
      "TRACKING_EVENT_TIME_COVERAGE",
      candidate.trackingNumber
    );
    const latest = item.events.at(-1);
    const carrierStatus = latest
      ? classifyLogenTrackingStatus(latest.statusName)
      : CARRIER_SHIPMENT_STATUS.registered;
    const occurred = resolveLogenTrackingOccurredAt({
      scanDate: latest?.scanDate,
      scanTime: latest?.scanTime,
      receivedAt: evidence.received_at,
    });

    if (!carrierStatus) {
      await appendCarrierTrackingEvents({
        client: tx,
        carrierShipmentId: candidate.carrierShipmentId,
        events: item.events,
        responseHash: context.responseHash,
        trackedAt: evidence.received_at,
      });
      await resolveObservedReview(
        tx,
        "TRACKING_SYNC_READ",
        candidate.trackingNumber,
        readRevision
      );
      await openTrackingReview(
        "TRACKING_STATUS_CLASSIFICATION",
        candidate.trackingNumber,
        {
          client: tx,
          apiCallLogId: context.apiCallLogId,
          reason: `알 수 없는 로젠 배송상태입니다: ${latest?.statusName ?? "-"}`,
        }
      );
      summary.succeededCount += 1;
      summary.reviewRequiredCount += 1;
      continue;
    }

    const stateTransition = await appendCarrierTrackingEvents({
      client: tx,
      carrierShipmentId: candidate.carrierShipmentId,
      events: item.events,
      responseHash: context.responseHash,
      shipmentStatus: carrierStatus,
      observedAt: occurred.occurredAt,
      trackedAt: evidence.received_at,
    });
    await resolveObservedReview(
      tx,
      "TRACKING_SYNC_READ",
      candidate.trackingNumber,
      readRevision
    );
    await resolveObservedReview(
      tx,
      "TRACKING_STATUS_CLASSIFICATION",
      candidate.trackingNumber,
      classificationRevision
    );

    if (latest && occurred.invalidReason) {
      await openTrackingReview(
        "TRACKING_EVENT_TIME_COVERAGE",
        candidate.trackingNumber,
        {
          client: tx,
          apiCallLogId: context.apiCallLogId,
          reason: `로젠 스캔 시각을 수신 시각으로 대체했습니다: ${occurred.invalidReason}`,
        }
      );
      summary.reviewRequiredCount += 1;
    } else {
      await resolveObservedReview(
        tx,
        "TRACKING_EVENT_TIME_COVERAGE",
        candidate.trackingNumber,
        timeCoverageRevision
      );
    }

    if (
      carrierStatus !== CARRIER_SHIPMENT_STATUS.registered &&
      carrierStatus !== CARRIER_SHIPMENT_STATUS.allocated &&
      stateTransition?.outcome !== "STALE_IGNORED"
    ) {
      const projected = await projectPackageGroupDeliveryStatus(tx, {
        packageGroupId: candidate.packageGroupId,
        carrierShipmentId: candidate.carrierShipmentId,
        carrierStatus,
        evidenceSource: "LOGEN",
        evidenceKey: evidenceKey(candidate.carrierShipmentId, item),
        rawStatusName: latest?.statusName ?? null,
        occurredAt: occurred.occurredAt,
        workerJobId: context.workerJobId,
      });
      summary.transitionedCount += projected.transitionedCount;
      if (projected.completed) summary.completedCount += 1;
      await resolveObservedReview(
        tx,
        "TRACKING_STATUS_PROJECTION",
        candidate.trackingNumber,
        projectionRevision
      );
    }
    summary.succeededCount += 1;
  }
  return summary;
}

async function runLogenTrackingProjectionJob(jobId: string) {
  const claim = await claimIntegrationProjectionJobById({
    jobId,
    lockSeconds: TRACKING_PROJECTION_LOCK_SECONDS,
  });
  if (!claim) {
    const observed = await prisma.integration_projection_jobs.findUnique({
      where: { integration_projection_job_id: jobId },
      select: { projection_status: true },
    });
    if (observed?.projection_status === "SUCCEEDED") return null;
    throw new Error("Logen tracking projection job is owned by another worker.");
  }
  return runClaimedIntegrationProjection<TrackingProjectionSummary>({
    claim,
    handler: (tx, evidence, _operationKey, job) =>
      projectLogenTrackingEvidence(tx, evidence, job),
  });
}

export async function drainLogenTrackingProjectionJobs(limit = 100) {
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const claim = await claimIntegrationProjectionJob({
      handlerKeys: [TRACKING_PROJECTION_HANDLER],
      lockSeconds: TRACKING_PROJECTION_LOCK_SECONDS,
    });
    if (!claim) break;
    await runClaimedIntegrationProjection({
      claim,
      handler: (tx, evidence, _operationKey, job) =>
        projectLogenTrackingEvidence(tx, evidence, job),
    });
  }
  return { processed };
}

export async function processLogenShipmentTracking(input: {
  limit?: number;
  workerJobId?: number | null;
  workerLease?: WorkerLeaseGuard;
} = {}) {
  const limit = positiveInteger(input.limit, 300, 1_000);
  const refreshCutoff = addSeconds(
    quickHackClock.nowDate(),
    -DEFAULT_TRACKING_REFRESH_SECONDS
  );
  await assertWorkerLeaseActive(input.workerLease);
  await drainLogenTrackingProjectionJobs(limit);
  await assertWorkerLeaseActive(input.workerLease);

  const candidates = await prisma.carrier_shipments.findMany({
    where: {
      carrier_code: "LOGEN",
      invoice_status: "REGISTERED",
      carrier_registered_at: { not: null },
      package_group_id: { not: null },
      shipment_status: { not: CARRIER_SHIPMENT_STATUS.delivered },
      OR: [
        { last_tracked_at: null },
        { last_tracked_at: { lte: refreshCutoff } },
      ],
      current_for_package_groups: {
        some: { group_status: { in: ["READY", "ON_HOLD"] } },
      },
    },
    orderBy: [
      { last_tracked_at: "asc" },
      { carrier_shipment_id: "asc" },
    ],
    take: limit,
    select: {
      carrier_shipment_id: true,
      package_group_id: true,
      tracking_number: true,
    },
  });
  const summary = {
    candidateCount: candidates.length,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    reviewRequiredCount: 0,
    transitionedCount: 0,
    completedCount: 0,
  };

  for (const candidateBatch of chunks(candidates, DEFAULT_TRACKING_BATCH_SIZE)) {
    await assertWorkerLeaseActive(input.workerLease);
    let call: Awaited<ReturnType<typeof getLogenTrackingBatch>>;
    try {
      call = await getLogenTrackingBatch(
        candidateBatch.map((candidate) => candidate.tracking_number),
        {
          workerJobId: input.workerJobId,
          signal: input.workerLease?.signal,
        }
      );
    } catch (error) {
      await assertWorkerLeaseActive(input.workerLease);
      throw error;
    }
    await assertWorkerLeaseActive(input.workerLease);
    const receivedAt = databaseNow();
    const rawPayloadText =
      call.result.rawPayloadText ?? JSON.stringify(call.result.payload);
    const inbox = await recordValidatedIntegrationInboxEvidence({
      provider: "LOGEN",
      endpoint: call.result.requestPath,
      evidenceType: "LOGEN_TRACKING_BATCH",
      rawPayloadText,
      occurredAt: receivedAt,
      validate: validateLogenTrackingBatch,
      projectionHandlerKeys: [TRACKING_PROJECTION_HANDLER],
      projectionContext: {
        apiCallLogId: call.apiCallLogId,
        workerJobId: input.workerJobId ?? null,
        responseHash: call.result.responseHash,
        candidates: candidateBatch.map((candidate) => ({
          carrierShipmentId: candidate.carrier_shipment_id,
          packageGroupId: candidate.package_group_id as number,
          trackingNumber: candidate.tracking_number,
        })),
      },
    });
    const job = inbox.projectionJobs[0];
    if (!job) throw new Error("Logen tracking projection job was not created.");
    try {
      const projected = await runLogenTrackingProjectionJob(
        job.integration_projection_job_id
      );
      if (projected?.result) {
        summary.processedCount += projected.result.processedCount;
        summary.succeededCount += projected.result.succeededCount;
        summary.failedCount += projected.result.failedCount;
        summary.reviewRequiredCount += projected.result.reviewRequiredCount;
        summary.transitionedCount += projected.result.transitionedCount;
        summary.completedCount += projected.result.completedCount;
      }
    } catch (error) {
      for (const candidate of candidateBatch) {
        await openTrackingReview(
          "TRACKING_STATUS_PROJECTION",
          candidate.tracking_number,
          {
            apiCallLogId: call.apiCallLogId,
            error,
            reason: "로젠 배송상태 증거를 업무 원장에 반영하지 못했습니다.",
          }
        );
      }
      throw error;
    }
  }
  return summary;
}
