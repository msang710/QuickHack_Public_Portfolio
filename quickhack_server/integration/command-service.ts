import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import {
  digestDomainOperation,
  runRetriableMeasuredTransaction,
} from "@/quickhack_server/core/database/aggregate-command";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  assertOwnedWorkMutation,
  claimWork,
  WorkClaimOwnershipLostError,
} from "@/quickhack_server/core/database/work-claim";
import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  digestRawIntegrationPayload,
  IntegrationSchemaValidationError,
} from "@/quickhack_server/integration/schema-validation";
import type {
  IntegrationClassifiedDispatchError,
  IntegrationClassifiedResponse,
  IntegrationDispatchOutcome,
  IntegrationJsonObject,
  IntegrationJsonValue,
  IntegrationTransportResponse,
} from "@/quickhack_shared/integration/contracts";

type TransactionOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T>;
};

type IntegrationCommandRow =
  Prisma.integration_commandsGetPayload<Record<string, never>>;
type IntegrationAttemptRow =
  Prisma.integration_command_attemptsGetPayload<Record<string, never>>;

export type IntegrationCommandClaim = {
  command: IntegrationCommandRow;
  attempt: IntegrationAttemptRow;
  leaseToken: string;
  claimGeneration: number;
  lockedUntil: Date;
};

export class IntegrationCommandConflictError extends Error {
  readonly code = "INTEGRATION_COMMAND_CONFLICT";
  readonly operationKey: string;

  constructor(operationKey: string) {
    super("Integration operation key was reused with a different command.");
    this.name = "IntegrationCommandConflictError";
    this.operationKey = operationKey;
  }
}

export class IntegrationCommandStateError extends Error {
  readonly code = "INTEGRATION_COMMAND_STATE_INVALID";

  constructor(detail: string) {
    super(`Integration command state is invalid: ${detail}.`);
    this.name = "IntegrationCommandStateError";
  }
}

function requiredText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function safeErrorCode(error: unknown, fallback: string) {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : error instanceof Error
        ? error.name
        : "";
  const normalized = candidate.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(normalized)
    ? normalized
    : fallback;
}

function jsonData(value: IntegrationJsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

function commandRequestDigest(input: {
  provider: string;
  operationType: string;
  targetSnapshot: IntegrationJsonObject;
  requestPayload?: IntegrationJsonValue | null;
}) {
  return digestDomainOperation({
    provider: input.provider,
    operationType: input.operationType,
    targetSnapshot: input.targetSnapshot,
    requestPayload: input.requestPayload ?? null,
  });
}

export async function registerIntegrationCommand(
  tx: Prisma.TransactionClient,
  input: {
    provider: string;
    operationType: string;
    operationKey: string;
    targetSnapshot: IntegrationJsonObject;
    requestPayload?: IntegrationJsonValue | null;
  }
) {
  const provider = requiredText(input.provider, "provider");
  const operationType = requiredText(input.operationType, "operationType");
  const operationKey = requiredText(input.operationKey, "operationKey");
  const requestDigest = commandRequestDigest({
    provider,
    operationType,
    targetSnapshot: input.targetSnapshot,
    requestPayload: input.requestPayload,
  });
  const targetSnapshotText = JSON.stringify(input.targetSnapshot);
  const requestPayloadText =
    input.requestPayload === undefined || input.requestPayload === null
      ? null
      : JSON.stringify(input.requestPayload);
  const integrationCommandId = randomUUID();
  const now = databaseNow();
  const inserted = await tx.$queryRaw<Array<{ integration_command_id: string }>>`
    INSERT INTO integration_commands (
      integration_command_id,
      provider,
      operation_type,
      operation_key,
      target_snapshot,
      request_payload,
      request_digest,
      command_status,
      created_at,
      updated_at
    ) VALUES (
      ${integrationCommandId}::uuid,
      ${provider},
      ${operationType},
      ${operationKey},
      ${targetSnapshotText}::jsonb,
      ${requestPayloadText}::jsonb,
      ${requestDigest},
      'PENDING',
      ${now},
      ${now}
    )
    ON CONFLICT (operation_key) DO NOTHING
    RETURNING integration_command_id
  `;

  const row = inserted.length === 1
    ? await tx.integration_commands.findUniqueOrThrow({
        where: { integration_command_id: inserted[0].integration_command_id },
      })
    : await tx.integration_commands.findUniqueOrThrow({
        where: { operation_key: operationKey },
      });

  if (
    row.provider !== provider ||
    row.operation_type !== operationType ||
    row.request_digest !== requestDigest
  ) {
    throw new IntegrationCommandConflictError(operationKey);
  }

  return {
    row,
    created: inserted.length === 1,
  } as const;
}

export async function claimIntegrationCommand(input: {
  owner?: TransactionOwner;
  provider?: string;
  operationTypes?: readonly string[];
  lockSeconds: number;
}) {
  const provider = input.provider?.trim() || null;
  const operationTypes = (input.operationTypes ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const providerFilter = provider
    ? Prisma.sql`AND command.provider = ${provider}`
    : Prisma.empty;
  const operationFilter = operationTypes.length > 0
    ? Prisma.sql`AND command.operation_type IN (${Prisma.join(operationTypes)})`
    : Prisma.empty;

  const claimed = await claimWork({
    owner: input.owner ?? prisma,
    name: "integration_command",
    lockSeconds: input.lockSeconds,
    claim: async (tx, seed) => {
      const rows = await tx.$queryRaw<
        Array<{ integration_command_id: string; claim_generation: number }>
      >`
        WITH candidate AS (
          SELECT command.integration_command_id
          FROM integration_commands AS command
          WHERE command.command_status = 'PENDING'
            ${providerFilter}
            ${operationFilter}
          ORDER BY command.created_at ASC, command.integration_command_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE integration_commands AS command
        SET command_status = 'DISPATCHING',
            lease_token = ${seed.leaseToken}::uuid,
            claim_generation = command.claim_generation + 1,
            locked_until = ${seed.lockedUntil},
            updated_at = ${databaseNow()}
        FROM candidate
        WHERE command.integration_command_id = candidate.integration_command_id
        RETURNING command.integration_command_id, command.claim_generation
      `;
      if (rows.length === 0) return [];

      const command = await tx.integration_commands.findUniqueOrThrow({
        where: { integration_command_id: rows[0].integration_command_id },
      });
      const attemptNumberRows = await tx.$queryRaw<Array<{ attempt_no: number }>>`
        SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
        FROM integration_command_attempts
        WHERE integration_command_id = ${command.integration_command_id}::uuid
      `;
      const attemptNo = Number(attemptNumberRows[0]?.attempt_no);
      if (!Number.isSafeInteger(attemptNo) || attemptNo <= 0) {
        throw new Error("Integration attempt number is invalid.");
      }
      const attempt = await tx.integration_command_attempts.create({
        data: {
          integration_command_attempt_id: randomUUID(),
          integration_command_id: command.integration_command_id,
          attempt_no: attemptNo,
          dispatch_status: "CREATED",
        },
      });
      return [{ command, attempt, claimGeneration: rows[0].claim_generation }];
    },
    generationOf: (row) => row.claimGeneration,
  });

  if (!claimed) return null;
  return {
    command: claimed.row.command,
    attempt: claimed.row.attempt,
    leaseToken: claimed.leaseToken,
    claimGeneration: claimed.claimGeneration,
    lockedUntil: claimed.lockedUntil,
  } satisfies IntegrationCommandClaim;
}

async function lockOwnedCommand(
  tx: Prisma.TransactionClient,
  claim: IntegrationCommandClaim
) {
  const rows = await tx.$queryRaw<Array<{ integration_command_id: string }>>`
    SELECT integration_command_id
    FROM integration_commands
    WHERE integration_command_id = ${claim.command.integration_command_id}::uuid
      AND command_status = 'DISPATCHING'
      AND lease_token = ${claim.leaseToken}::uuid
      AND claim_generation = ${claim.claimGeneration}
    FOR UPDATE
  `;
  assertOwnedWorkMutation(
    rows.length,
    claim.command.integration_command_id,
    "integration command ownership changed"
  );
  return tx.integration_commands.findUniqueOrThrow({
    where: { integration_command_id: claim.command.integration_command_id },
  });
}

async function lockClaimAttempt(
  tx: Prisma.TransactionClient,
  claim: IntegrationCommandClaim
) {
  const rows = await tx.$queryRaw<
    Array<{ integration_command_attempt_id: string }>
  >`
    SELECT integration_command_attempt_id
    FROM integration_command_attempts
    WHERE integration_command_attempt_id = ${claim.attempt.integration_command_attempt_id}::uuid
      AND integration_command_id = ${claim.command.integration_command_id}::uuid
    FOR UPDATE
  `;
  assertOwnedWorkMutation(
    rows.length,
    claim.command.integration_command_id,
    "integration attempt no longer belongs to the claim"
  );
  return tx.integration_command_attempts.findUniqueOrThrow({
    where: {
      integration_command_attempt_id:
        claim.attempt.integration_command_attempt_id,
    },
  });
}

export async function markIntegrationDispatchStarted(
  claim: IntegrationCommandClaim,
  owner: TransactionOwner = prisma
) {
  return runMeasuredTransaction(
    owner,
    "integration_command.mark_dispatched",
    async (tx) => {
      await lockOwnedCommand(tx, claim);
      const attempt = await lockClaimAttempt(tx, claim);
      if (attempt.dispatch_status !== "CREATED") {
        throw new IntegrationCommandStateError(
          `attempt must be CREATED, received ${attempt.dispatch_status}`
        );
      }
      return tx.integration_command_attempts.update({
        where: {
          integration_command_attempt_id: attempt.integration_command_attempt_id,
        },
        data: {
          dispatch_status: "DISPATCHED",
          request_dispatched_at: databaseNow(),
        },
      });
    }
  );
}

function projectionHandlerKeys(values: readonly string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export async function finalizeIntegrationCommand(
  input: {
    claim: IntegrationCommandClaim;
    outcome: IntegrationDispatchOutcome;
    responseReceived: boolean;
    rawPayloadText?: string | null;
    normalizedResult?: IntegrationJsonValue;
    httpStatusCode?: number | null;
    providerCode?: string | null;
    errorCode?: string | null;
    occurredAt?: Date | null;
    evidenceType?: string;
    projectionHandlerKeys?: readonly string[];
  },
  owner: TransactionOwner = prisma
) {
  const handlers = projectionHandlerKeys(input.projectionHandlerKeys);
  if (input.outcome !== "SUCCEEDED" && handlers.length > 0) {
    throw new IntegrationCommandStateError(
      "only SUCCEEDED evidence can enqueue projection handlers"
    );
  }
  if (
    (input.outcome === "SUCCEEDED" || input.outcome === "NOT_APPLIED") &&
    !input.responseReceived
  ) {
    throw new IntegrationCommandStateError(
      `${input.outcome} requires a received provider response`
    );
  }

  return runRetriableMeasuredTransaction(
    owner,
    "integration_command.finalize",
    async (tx) => {
      await lockOwnedCommand(tx, input.claim);
      const attempt = await lockClaimAttempt(tx, input.claim);
      if (attempt.dispatch_status !== "DISPATCHED") {
        throw new IntegrationCommandStateError(
          `attempt must be DISPATCHED, received ${attempt.dispatch_status}`
        );
      }

      const now = databaseNow();
      const rawPayloadText = input.rawPayloadText ?? null;
      const evidence = await tx.integration_evidences.create({
        data: {
          integration_evidence_id: randomUUID(),
          integration_command_id: input.claim.command.integration_command_id,
          integration_command_attempt_id:
            input.claim.attempt.integration_command_attempt_id,
          provider: input.claim.command.provider,
          evidence_type:
            input.evidenceType ??
            (input.responseReceived
              ? "COMMAND_RESPONSE"
              : "COMMAND_TRANSPORT_UNCERTAIN"),
          outcome: input.outcome,
          raw_payload_text: rawPayloadText,
          raw_payload_digest: digestRawIntegrationPayload(rawPayloadText ?? ""),
          ...(input.normalizedResult === undefined
            ? {}
            : { normalized_result: jsonData(input.normalizedResult) }),
          occurred_at: input.occurredAt ?? null,
          received_at: now,
          created_at: now,
        },
      });

      await tx.integration_command_attempts.update({
        where: {
          integration_command_attempt_id: attempt.integration_command_attempt_id,
        },
        data: {
          dispatch_status: input.responseReceived
            ? "RESPONSE_RECEIVED"
            : "CONNECTION_LOST",
          response_received_at: input.responseReceived ? now : null,
          http_status: input.httpStatusCode ?? null,
          provider_code: input.providerCode?.trim() || null,
          error_code: input.errorCode?.trim() || null,
          error_message: null,
        },
      });

      const jobs = [];
      for (const handlerKey of handlers) {
        jobs.push(
          await tx.integration_projection_jobs.create({
            data: {
              integration_projection_job_id: randomUUID(),
              integration_evidence_id: evidence.integration_evidence_id,
              handler_key: handlerKey,
              projection_status: "PENDING",
              created_at: now,
              updated_at: now,
            },
          })
        );
      }

      await tx.integration_commands.update({
        where: {
          integration_command_id: input.claim.command.integration_command_id,
        },
        data: {
          command_status: input.outcome,
          lease_token: null,
          locked_until: null,
          updated_at: now,
        },
      });

      return { evidence, projectionJobs: jobs } as const;
    }
  );
}

export async function failIntegrationCommandBeforeDispatch(
  claim: IntegrationCommandClaim,
  error: unknown,
  owner: TransactionOwner = prisma
) {
  return runRetriableMeasuredTransaction(
    owner,
    "integration_command.fail_before_dispatch",
    async (tx) => {
      await lockOwnedCommand(tx, claim);
      const attempt = await lockClaimAttempt(tx, claim);
      if (attempt.dispatch_status !== "CREATED") {
        throw new IntegrationCommandStateError(
          `pre-dispatch failure requires CREATED, received ${attempt.dispatch_status}`
        );
      }
      const now = databaseNow();
      const errorCode = safeErrorCode(error, "INTEGRATION_PREPARE_FAILED");
      await tx.integration_command_attempts.update({
        where: {
          integration_command_attempt_id: attempt.integration_command_attempt_id,
        },
        data: {
          dispatch_status: "FAILED_LOCAL",
          error_code: errorCode,
          error_message: null,
        },
      });
      const evidence = await tx.integration_evidences.create({
        data: {
          integration_evidence_id: randomUUID(),
          integration_command_id: claim.command.integration_command_id,
          integration_command_attempt_id:
            claim.attempt.integration_command_attempt_id,
          provider: claim.command.provider,
          evidence_type: "COMMAND_LOCAL_FAILURE",
          outcome: "FAILED_LOCAL",
          raw_payload_text: null,
          raw_payload_digest: digestRawIntegrationPayload(""),
          received_at: now,
          created_at: now,
        },
      });
      await tx.integration_commands.update({
        where: { integration_command_id: claim.command.integration_command_id },
        data: {
          command_status: "FAILED_LOCAL",
          lease_token: null,
          locked_until: null,
          updated_at: now,
        },
      });
      return { evidence, projectionJobs: [] } as const;
    }
  );
}

export async function recoverExpiredIntegrationCommands(input: {
  owner?: TransactionOwner;
  limit?: number;
} = {}) {
  const owner = input.owner ?? prisma;
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  return runMeasuredTransaction(
    owner,
    "integration_command.recover_expired",
    async (tx) => {
      const now = databaseNow();
      const commands = await tx.$queryRaw<Array<{ integration_command_id: string }>>`
        SELECT integration_command_id
        FROM integration_commands
        WHERE command_status = 'DISPATCHING'
          AND locked_until IS NOT NULL
          AND locked_until <= ${now}
        ORDER BY locked_until ASC, integration_command_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `;
      let requeued = 0;
      let ambiguous = 0;

      for (const candidate of commands) {
        const attempt = await tx.integration_command_attempts.findFirst({
          where: { integration_command_id: candidate.integration_command_id },
          orderBy: { attempt_no: "desc" },
        });
        if (!attempt || attempt.dispatch_status === "CREATED" || attempt.dispatch_status === "FAILED_LOCAL") {
          if (attempt?.dispatch_status === "CREATED") {
            await tx.integration_command_attempts.update({
              where: {
                integration_command_attempt_id:
                  attempt.integration_command_attempt_id,
              },
              data: {
                dispatch_status: "FAILED_LOCAL",
                error_code: "CLAIM_EXPIRED_BEFORE_DISPATCH",
                error_message: null,
              },
            });
          }
          await tx.integration_commands.update({
            where: { integration_command_id: candidate.integration_command_id },
            data: {
              command_status: "PENDING",
              lease_token: null,
              locked_until: null,
              updated_at: now,
            },
          });
          requeued += 1;
          continue;
        }

        await tx.integration_command_attempts.update({
          where: {
            integration_command_attempt_id: attempt.integration_command_attempt_id,
          },
          data: {
            dispatch_status: "CONNECTION_LOST",
            error_code: "CLAIM_EXPIRED_AFTER_DISPATCH",
            error_message: null,
          },
        });
        await tx.integration_evidences.create({
          data: {
            integration_evidence_id: randomUUID(),
            integration_command_id: candidate.integration_command_id,
            integration_command_attempt_id:
              attempt.integration_command_attempt_id,
            provider: (
              await tx.integration_commands.findUniqueOrThrow({
                where: {
                  integration_command_id: candidate.integration_command_id,
                },
                select: { provider: true },
              })
            ).provider,
            evidence_type: "COMMAND_TRANSPORT_UNCERTAIN",
            outcome: "AMBIGUOUS",
            raw_payload_text: null,
            raw_payload_digest: digestRawIntegrationPayload(""),
            normalized_result: {
              reason: "CLAIM_EXPIRED_AFTER_DISPATCH",
            },
            received_at: now,
            created_at: now,
          },
        });
        await tx.integration_commands.update({
          where: { integration_command_id: candidate.integration_command_id },
          data: {
            command_status: "AMBIGUOUS",
            lease_token: null,
            locked_until: null,
            updated_at: now,
          },
        });
        ambiguous += 1;
      }

      return { recovered: commands.length, requeued, ambiguous } as const;
    }
  );
}

export type IntegrationCommandAdapter<
  TPrepared,
  TNormalized extends IntegrationJsonValue = IntegrationJsonValue,
> = {
  prepare: (claim: IntegrationCommandClaim) => Promise<TPrepared>;
  dispatch: (
    prepared: TPrepared,
    options: { signal?: AbortSignal }
  ) => Promise<IntegrationTransportResponse>;
  classifyResponse: (
    response: IntegrationTransportResponse
  ) => IntegrationClassifiedResponse<TNormalized>;
  classifyError?: (error: unknown) => IntegrationClassifiedDispatchError;
};

export async function executeClaimedIntegrationCommand<
  TPrepared,
  TNormalized extends IntegrationJsonValue,
>(input: {
  claim: IntegrationCommandClaim;
  adapter: IntegrationCommandAdapter<TPrepared, TNormalized>;
  owner?: TransactionOwner;
  signal?: AbortSignal;
}) {
  const owner = input.owner ?? prisma;
  let prepared: TPrepared;
  try {
    prepared = await input.adapter.prepare(input.claim);
  } catch (error) {
    return failIntegrationCommandBeforeDispatch(input.claim, error, owner);
  }

  await markIntegrationDispatchStarted(input.claim, owner);
  try {
    const response = await input.adapter.dispatch(prepared, {
      signal: input.signal,
    });
    let classified: IntegrationClassifiedResponse<TNormalized>;
    try {
      classified = input.adapter.classifyResponse(response);
    } catch (error) {
      const errorCode =
        error instanceof IntegrationSchemaValidationError
          ? error.code
          : safeErrorCode(error, "INTEGRATION_RESPONSE_CLASSIFICATION_FAILED");
      return finalizeIntegrationCommand(
        {
          claim: input.claim,
          outcome: "AMBIGUOUS",
          responseReceived: true,
          rawPayloadText: response.rawPayloadText,
          httpStatusCode: response.httpStatusCode,
          providerCode: response.providerCode ?? null,
          errorCode,
          occurredAt: response.occurredAt ?? null,
        },
        owner
      );
    }
    return finalizeIntegrationCommand(
      {
        claim: input.claim,
        outcome: classified.outcome,
        responseReceived: true,
        rawPayloadText: response.rawPayloadText,
        normalizedResult: classified.normalizedResult,
        httpStatusCode: response.httpStatusCode,
        providerCode: response.providerCode ?? null,
        errorCode: classified.errorCode ?? null,
        occurredAt: response.occurredAt ?? null,
        projectionHandlerKeys: classified.projectionHandlerKeys,
      },
      owner
    );
  } catch (error) {
    if (error instanceof WorkClaimOwnershipLostError) throw error;
    let classified: IntegrationClassifiedDispatchError = {
      outcome: "AMBIGUOUS",
      errorCode: safeErrorCode(error, "INTEGRATION_TRANSPORT_UNCERTAIN"),
    };
    try {
      classified = input.adapter.classifyError?.(error) ?? classified;
    } catch {
      // A failing error classifier cannot make an already-dispatched write safe.
    }
    const response = classified.response ?? null;
    const outcome =
      classified.outcome === "NOT_APPLIED" && response
        ? "NOT_APPLIED"
        : "AMBIGUOUS";
    return finalizeIntegrationCommand(
      {
        claim: input.claim,
        outcome,
        responseReceived: response !== null,
        rawPayloadText: response?.rawPayloadText ?? null,
        httpStatusCode: response?.httpStatusCode ?? null,
        providerCode: response?.providerCode ?? null,
        errorCode:
          classified.errorCode ??
          safeErrorCode(error, "INTEGRATION_TRANSPORT_UNCERTAIN"),
        occurredAt: response?.occurredAt ?? null,
      },
      owner
    );
  }
}

export function isIntegrationCommandOwnershipLost(error: unknown) {
  return error instanceof WorkClaimOwnershipLostError;
}
