import { Prisma } from "@/generated/prisma/client";
import {
  completeDomainOperationKey,
  digestDomainOperation,
  reserveDomainOperationKey,
  runRetriableMeasuredTransaction,
} from "@/quickhack_server/core/database/aggregate-command";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  assertOwnedWorkMutation,
  claimWork,
  WorkClaimOwnershipLostError,
} from "@/quickhack_server/core/database/work-claim";
import { prisma } from "@/quickhack_server/core/prisma";

type TransactionOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T>;
};

type ProjectionJobRow =
  Prisma.integration_projection_jobsGetPayload<Record<string, never>>;
type EvidenceRow = Prisma.integration_evidencesGetPayload<Record<string, never>>;

export type IntegrationProjectionClaim = {
  job: ProjectionJobRow;
  leaseToken: string;
  claimGeneration: number;
  lockedUntil: Date;
};

function safeErrorCode(error: unknown) {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : error instanceof Error
        ? error.name
        : "";
  const normalized = candidate.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(normalized)
    ? normalized
    : "INTEGRATION_PROJECTION_FAILED";
}

export async function claimIntegrationProjectionJob(input: {
  owner?: TransactionOwner;
  handlerKeys?: readonly string[];
  lockSeconds: number;
}) {
  const handlerKeys = (input.handlerKeys ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const handlerFilter = handlerKeys.length > 0
    ? Prisma.sql`AND job.handler_key IN (${Prisma.join(handlerKeys)})`
    : Prisma.empty;
  const claimed = await claimWork({
    owner: input.owner ?? prisma,
    name: "integration_projection",
    lockSeconds: input.lockSeconds,
    claim: async (tx, seed) => {
      const rows = await tx.$queryRaw<
        Array<{
          integration_projection_job_id: string;
          claim_generation: number;
        }>
      >`
        WITH candidate AS (
          SELECT job.integration_projection_job_id
          FROM integration_projection_jobs AS job
          WHERE (
              job.projection_status IN ('PENDING', 'FAILED')
              OR (
                job.projection_status = 'PROCESSING'
                AND job.locked_until IS NOT NULL
                AND job.locked_until <= ${databaseNow()}
              )
            )
            ${handlerFilter}
          ORDER BY job.created_at ASC, job.integration_projection_job_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE integration_projection_jobs AS job
        SET projection_status = 'PROCESSING',
            attempt_count = job.attempt_count + 1,
            lease_token = ${seed.leaseToken}::uuid,
            claim_generation = job.claim_generation + 1,
            locked_until = ${seed.lockedUntil},
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ${databaseNow()}
        FROM candidate
        WHERE job.integration_projection_job_id = candidate.integration_projection_job_id
        RETURNING job.integration_projection_job_id, job.claim_generation
      `;
      if (rows.length === 0) return [];
      const job = await tx.integration_projection_jobs.findUniqueOrThrow({
        where: {
          integration_projection_job_id:
            rows[0].integration_projection_job_id,
        },
      });
      return [{ job, claimGeneration: rows[0].claim_generation }];
    },
    generationOf: (row) => row.claimGeneration,
  });
  if (!claimed) return null;
  return {
    job: claimed.row.job,
    leaseToken: claimed.leaseToken,
    claimGeneration: claimed.claimGeneration,
    lockedUntil: claimed.lockedUntil,
  } satisfies IntegrationProjectionClaim;
}

export async function claimIntegrationProjectionJobById(input: {
  owner?: TransactionOwner;
  jobId: string;
  lockSeconds: number;
}) {
  const claimed = await claimWork({
    owner: input.owner ?? prisma,
    name: "integration_projection_by_id",
    lockSeconds: input.lockSeconds,
    claim: async (tx, seed) => {
      const rows = await tx.$queryRaw<
        Array<{ integration_projection_job_id: string; claim_generation: number }>
      >`
        UPDATE integration_projection_jobs
        SET projection_status = 'PROCESSING',
            attempt_count = attempt_count + 1,
            lease_token = ${seed.leaseToken}::uuid,
            claim_generation = claim_generation + 1,
            locked_until = ${seed.lockedUntil},
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ${databaseNow()}
        WHERE integration_projection_job_id = ${input.jobId}::uuid
          AND (
            projection_status IN ('PENDING', 'FAILED')
            OR (
              projection_status = 'PROCESSING'
              AND locked_until IS NOT NULL
              AND locked_until <= ${databaseNow()}
            )
          )
        RETURNING integration_projection_job_id, claim_generation
      `;
      if (rows.length === 0) return [];
      const job = await tx.integration_projection_jobs.findUniqueOrThrow({
        where: { integration_projection_job_id: rows[0].integration_projection_job_id },
      });
      return [{ job, claimGeneration: rows[0].claim_generation }];
    },
    generationOf: (row) => row.claimGeneration,
  });
  if (!claimed) return null;
  return {
    job: claimed.row.job,
    leaseToken: claimed.leaseToken,
    claimGeneration: claimed.claimGeneration,
    lockedUntil: claimed.lockedUntil,
  } satisfies IntegrationProjectionClaim;
}

async function lockOwnedProjectionJob(
  tx: Prisma.TransactionClient,
  claim: IntegrationProjectionClaim
) {
  const rows = await tx.$queryRaw<
    Array<{ integration_projection_job_id: string }>
  >`
    SELECT integration_projection_job_id
    FROM integration_projection_jobs
    WHERE integration_projection_job_id = ${claim.job.integration_projection_job_id}::uuid
      AND projection_status = 'PROCESSING'
      AND lease_token = ${claim.leaseToken}::uuid
      AND claim_generation = ${claim.claimGeneration}
    FOR UPDATE
  `;
  assertOwnedWorkMutation(
    rows.length,
    claim.job.integration_projection_job_id,
    "integration projection ownership changed"
  );
  return tx.integration_projection_jobs.findUniqueOrThrow({
    where: {
      integration_projection_job_id: claim.job.integration_projection_job_id,
    },
  });
}

async function markProjectionFailure(
  owner: TransactionOwner,
  claim: IntegrationProjectionClaim,
  error: unknown
) {
  return runRetriableMeasuredTransaction(
    owner,
    "integration_projection.fail",
    async (tx) => {
      await lockOwnedProjectionJob(tx, claim);
      const result = await tx.integration_projection_jobs.updateMany({
        where: {
          integration_projection_job_id:
            claim.job.integration_projection_job_id,
          projection_status: "PROCESSING",
          lease_token: claim.leaseToken,
          claim_generation: claim.claimGeneration,
        },
        data: {
          projection_status: "FAILED",
          lease_token: null,
          locked_until: null,
          last_error_code: safeErrorCode(error),
          last_error_message: null,
          updated_at: databaseNow(),
        },
      });
      assertOwnedWorkMutation(
        result.count,
        claim.job.integration_projection_job_id,
        "projection failure finalization lost ownership"
      );
    }
  );
}

export async function runClaimedIntegrationProjection<TResult = void>(input: {
  owner?: TransactionOwner;
  claim: IntegrationProjectionClaim;
  handler: (
    tx: Prisma.TransactionClient,
    evidence: EvidenceRow,
    operationKey: string,
    job: ProjectionJobRow
  ) => Promise<TResult>;
}) {
  const owner = input.owner ?? prisma;
  try {
    return await runRetriableMeasuredTransaction(
      owner,
      "integration_projection.apply",
      async (tx) => {
        const job = await lockOwnedProjectionJob(tx, input.claim);
        const evidence = await tx.integration_evidences.findUniqueOrThrow({
          where: { integration_evidence_id: job.integration_evidence_id },
        });
        const operationKey =
          `${evidence.integration_evidence_id}:${job.handler_key}`;
        const reservation = await reserveDomainOperationKey(tx, {
          scope: "INTEGRATION_PROJECTION",
          operationKey,
          aggregateType: "INTEGRATION_PROJECTION",
          aggregateId: job.integration_projection_job_id,
          requestDigest: digestDomainOperation({
            evidenceId: evidence.integration_evidence_id,
            handlerKey: job.handler_key,
          }),
        });
        let projectionResult: TResult | undefined;
        if (reservation.owned) {
          projectionResult = await input.handler(tx, evidence, operationKey, job);
          await completeDomainOperationKey(
            tx,
            reservation.row.operation_id,
            digestDomainOperation({ status: "SUCCEEDED" })
          );
        }
        const result = await tx.integration_projection_jobs.updateMany({
          where: {
            integration_projection_job_id:
              job.integration_projection_job_id,
            projection_status: "PROCESSING",
            lease_token: input.claim.leaseToken,
            claim_generation: input.claim.claimGeneration,
          },
          data: {
            projection_status: "SUCCEEDED",
            lease_token: null,
            locked_until: null,
            last_error_code: null,
            last_error_message: null,
            completed_at: databaseNow(),
            updated_at: databaseNow(),
          },
        });
        assertOwnedWorkMutation(
          result.count,
          job.integration_projection_job_id,
          "projection success finalization lost ownership"
        );
        return {
          jobId: job.integration_projection_job_id,
          operationKey,
          result: projectionResult,
        };
      }
    );
  } catch (error) {
    if (error instanceof WorkClaimOwnershipLostError) throw error;
    await markProjectionFailure(owner, input.claim, error);
    throw error;
  }
}

export function isIntegrationProjectionOwnershipLost(error: unknown) {
  return error instanceof WorkClaimOwnershipLostError;
}
