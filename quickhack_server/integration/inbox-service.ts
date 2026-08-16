import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { runRetriableMeasuredTransaction } from "@/quickhack_server/core/database/aggregate-command";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  digestRawIntegrationPayload,
  IntegrationSchemaValidationError,
  validateIntegrationJson,
} from "@/quickhack_server/integration/schema-validation";
import type { IntegrationJsonValue } from "@/quickhack_shared/integration/contracts";

type TransactionOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T>;
};

export class IntegrationInboxValidationFailedError extends Error {
  readonly code = "INTEGRATION_INBOX_VALIDATION_FAILED";
  readonly evidenceId: string;
  readonly validationCode: string;

  constructor(evidenceId: string, validationCode: string) {
    super("Integration response was stored but did not pass schema validation.");
    this.name = "IntegrationInboxValidationFailedError";
    this.evidenceId = evidenceId;
    this.validationCode = validationCode;
  }
}

function safeValidationCode(error: unknown) {
  if (error instanceof IntegrationSchemaValidationError) return error.code;
  return "INTEGRATION_VALIDATOR_FAILED";
}

function jsonData(value: IntegrationJsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

export async function recordValidatedIntegrationInboxEvidence<
  TNormalized extends IntegrationJsonValue,
>(input: {
  owner?: TransactionOwner;
  provider: string;
  endpoint: string;
  evidenceType: string;
  rawPayloadText: string;
  occurredAt?: Date | null;
  validate: (payload: unknown, context: {
    provider: string;
    endpoint: string;
  }) => TNormalized;
  projectionHandlerKeys?: readonly string[];
  projectionContext?: IntegrationJsonValue;
  storagePolicy?: {
    retainRawPayload?: boolean;
    minimizeNormalizedResult?: (input: {
      outcome: "SUCCEEDED" | "FAILED_LOCAL";
      normalizedResult: IntegrationJsonValue;
    }) => IntegrationJsonValue;
  };
}) {
  const provider = input.provider.trim();
  const endpoint = input.endpoint.trim();
  const evidenceType = input.evidenceType.trim();
  if (!provider || !endpoint || !evidenceType) {
    throw new Error("provider, endpoint and evidenceType are required.");
  }

  let normalizedResult: TNormalized | undefined;
  let validationError: unknown = null;
  try {
    normalizedResult = validateIntegrationJson({
      provider,
      endpoint,
      rawText: input.rawPayloadText,
      validate: input.validate,
    }).normalizedResult;
  } catch (error) {
    validationError = error;
  }

  const handlers = [
    ...new Set(
      (input.projectionHandlerKeys ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
  const validationCode = validationError
    ? safeValidationCode(validationError)
    : null;
  const validationResult = validationError instanceof IntegrationSchemaValidationError
    ? {
        validationCode: validationError.code,
        path: validationError.path,
        reason: validationError.reason,
      }
    : validationError
      ? {
          validationCode: "INTEGRATION_VALIDATOR_FAILED",
          path: "$",
          reason: "VALIDATOR_FAILED",
        }
      : null;
  const resultForStorage = (validationResult ??
    normalizedResult ??
    null) as IntegrationJsonValue;
  const normalizedResultForStorage = input.storagePolicy?.minimizeNormalizedResult
    ? input.storagePolicy.minimizeNormalizedResult({
        outcome: validationError ? "FAILED_LOCAL" : "SUCCEEDED",
        normalizedResult: resultForStorage,
      })
    : resultForStorage;
  const result = await runRetriableMeasuredTransaction(
    input.owner ?? prisma,
    "integration_inbox.record_evidence",
    async (tx) => {
      const now = databaseNow();
      const evidence = await tx.integration_evidences.create({
        data: {
          integration_evidence_id: randomUUID(),
          provider,
          evidence_type: evidenceType,
          outcome: validationError ? "FAILED_LOCAL" : "SUCCEEDED",
          raw_payload_text:
            input.storagePolicy?.retainRawPayload === false
              ? null
              : input.rawPayloadText,
          raw_payload_digest: digestRawIntegrationPayload(
            input.rawPayloadText
          ),
          normalized_result: jsonData(normalizedResultForStorage),
          occurred_at: input.occurredAt ?? null,
          received_at: now,
          created_at: now,
        },
      });
      const jobs = [];
      if (!validationError) {
        for (const handlerKey of handlers) {
          jobs.push(
            await tx.integration_projection_jobs.create({
              data: {
                integration_projection_job_id: randomUUID(),
                integration_evidence_id: evidence.integration_evidence_id,
                handler_key: handlerKey,
                ...(input.projectionContext === undefined
                  ? {}
                  : { projection_context: jsonData(input.projectionContext) }),
                projection_status: "PENDING",
                created_at: now,
                updated_at: now,
              },
            })
          );
        }
      }
      return { evidence, projectionJobs: jobs } as const;
    }
  );

  if (validationCode) {
    throw new IntegrationInboxValidationFailedError(
      result.evidence.integration_evidence_id,
      validationCode
    );
  }
  return { ...result, normalizedResult: normalizedResult as TNormalized };
}
