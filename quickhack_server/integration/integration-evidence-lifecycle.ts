import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import type { IntegrationJsonValue } from "@/quickhack_shared/integration/contracts";
import {
  defineLifecyclePolicy,
  lifecycleAgeMs,
  resolveLifecycleBatchSize,
} from "@/quickhack_shared/lifecycle/lifecycle-policy.mjs";

export const COUPANG_ORDERSHEET_EVIDENCE_TYPE = "COUPANG_ORDERSHEET_PAGE";
export const COUPANG_ORDERSHEET_STORAGE_POLICY_VERSION = 1;
export const COUPANG_ORDERSHEET_SCRUB_POLICY = defineLifecyclePolicy({
  retentionMs: 0,
  maxBatchSize: 100,
});

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function minimizeCoupangOrdersheetEvidenceForStorage(input: {
  outcome: string;
  normalizedResult: IntegrationJsonValue;
}): IntegrationJsonValue {
  const value = jsonRecord(input.normalizedResult);
  if (input.outcome !== "SUCCEEDED") {
    return {
      storagePolicyVersion: COUPANG_ORDERSHEET_STORAGE_POLICY_VERSION,
      evidenceType: COUPANG_ORDERSHEET_EVIDENCE_TYPE,
      outcome: "FAILED_LOCAL",
      validationCode: String(value.validationCode ?? "VALIDATION_FAILED").slice(
        0,
        128
      ),
    };
  }
  return {
    storagePolicyVersion: COUPANG_ORDERSHEET_STORAGE_POLICY_VERSION,
    evidenceType: COUPANG_ORDERSHEET_EVIDENCE_TYPE,
    outcome: "SUCCEEDED",
    rowCount: Array.isArray(value.orders) ? value.orders.length : 0,
    hasNextPage: Boolean(value.nextToken),
  };
}

function isCurrentOrdersheetSummary(value: unknown) {
  const result = jsonRecord(value);
  return (
    result.storagePolicyVersion ===
      COUPANG_ORDERSHEET_STORAGE_POLICY_VERSION &&
    result.evidenceType === COUPANG_ORDERSHEET_EVIDENCE_TYPE
  );
}

type CandidateRow = {
  integration_evidence_id: string;
  outcome: string;
  normalized_result: Prisma.JsonValue | null;
  created_at: Date;
};

type BacklogRow = {
  backlog_count: bigint;
  oldest_created_at: Date | null;
};

const eligibleSql = Prisma.sql`
  e.evidence_type = ${COUPANG_ORDERSHEET_EVIDENCE_TYPE}
  AND (
    e.raw_payload_text IS NOT NULL
    OR e.normalized_result IS NULL
    OR e.normalized_result->>'storagePolicyVersion' IS DISTINCT FROM ${String(
      COUPANG_ORDERSHEET_STORAGE_POLICY_VERSION
    )}
  )
  AND NOT EXISTS (
    SELECT 1
    FROM integration_projection_jobs AS job
    WHERE job.integration_evidence_id = e.integration_evidence_id
      AND job.projection_status <> 'SUCCEEDED'
  )
`;

async function readBacklog(now: Date) {
  const [row] = await prisma.$queryRaw<BacklogRow[]>(Prisma.sql`
    SELECT
      COUNT(*)::bigint AS backlog_count,
      MIN(e.created_at) AS oldest_created_at
    FROM integration_evidences AS e
    WHERE ${eligibleSql}
  `);
  return {
    backlogCount: Number(row?.backlog_count ?? 0n),
    oldestEligibleAgeMs: row?.oldest_created_at
      ? lifecycleAgeMs(now, row.oldest_created_at)
      : null,
  };
}

export async function scrubCoupangOrdersheetIntegrationEvidence(options: {
  now?: Date;
  dryRun?: boolean;
  maxBatchSize?: number;
} = {}) {
  const now = options.now ?? new Date();
  const maxBatchSize = resolveLifecycleBatchSize(
    COUPANG_ORDERSHEET_SCRUB_POLICY,
    options.maxBatchSize
  );
  const candidates = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT
      e.integration_evidence_id,
      e.outcome,
      e.normalized_result,
      e.created_at
    FROM integration_evidences AS e
    WHERE ${eligibleSql}
    ORDER BY e.created_at ASC, e.integration_evidence_id ASC
    LIMIT ${maxBatchSize}
  `);

  let changedCount = 0;
  let skippedCount = 0;
  if (!options.dryRun) {
    await prisma.$transaction(async (tx) => {
      for (const candidate of candidates) {
        const current = await tx.integration_evidences.findUnique({
          where: {
            integration_evidence_id: candidate.integration_evidence_id,
          },
          include: {
            projection_jobs: {
              where: { projection_status: { not: "SUCCEEDED" } },
              select: { integration_projection_job_id: true },
              take: 1,
            },
          },
        });
        if (
          !current ||
          current.evidence_type !== COUPANG_ORDERSHEET_EVIDENCE_TYPE ||
          current.projection_jobs.length > 0 ||
          (current.raw_payload_text === null &&
            isCurrentOrdersheetSummary(current.normalized_result))
        ) {
          skippedCount += 1;
          continue;
        }
        await tx.integration_evidences.update({
          where: {
            integration_evidence_id: current.integration_evidence_id,
          },
          data: {
            raw_payload_text: null,
            normalized_result: minimizeCoupangOrdersheetEvidenceForStorage({
              outcome: current.outcome,
              normalizedResult:
                (current.normalized_result as IntegrationJsonValue | null) ??
                null,
            }) as Prisma.InputJsonValue,
          },
        });
        changedCount += 1;
      }
    });
  }

  const backlog = await readBacklog(now);
  return {
    dryRun: Boolean(options.dryRun),
    maxBatchSize,
    attemptedCount: candidates.length,
    changedCount: options.dryRun ? 0 : changedCount,
    skippedCount: options.dryRun ? 0 : skippedCount,
    ...backlog,
  };
}
