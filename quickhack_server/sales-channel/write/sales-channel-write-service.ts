import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { digestDomainOperation } from "@/quickhack_server/core/database/aggregate-command";
import { registerIntegrationCommand } from "@/quickhack_server/integration/command-service";
import { digestRawIntegrationPayload } from "@/quickhack_server/integration/schema-validation";
import type { IntegrationJsonObject, IntegrationJsonValue } from "@/quickhack_shared/integration/contracts";
import { prisma } from "@/quickhack_server/core/prisma";
import { publicConflict } from "@/quickhack_server/core/public-error";
import {
  assertSalesChannelWriteAllowed,
  executeSalesChannelWriteAdapter,
  getSalesChannelWriteEndpoint,
} from "@/quickhack_server/sales-channel/coupang/write-adapter";
import {
  verifyAndRefreshCoupangWriteRequest,
  type CoupangWriteVerificationResult,
} from "@/quickhack_server/sales-channel/coupang/write-verification-service";
import {
  CoupangApiResponseError,
  openCoupangApiCredentialContext,
  type CoupangApiCredentialContext,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import {
  assessCoupangWriteResponse,
  COUPANG_WRITE_RESPONSE_OUTCOME,
  CoupangWriteResponseContractError,
  type CoupangWriteResponseAssessment,
} from "@/quickhack_server/sales-channel/coupang/write-response-contract";
import { safeCoupangExternalResponseCode } from "@/quickhack_server/sales-channel/coupang/external-response-metadata";
import {
  databaseDateTimeOrNull,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  setOperationTraceField,
  setOperationTraceTargetCount,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import {
  SALES_CHANNEL_WRITE_ATTEMPT_STATUS,
  SALES_CHANNEL_WRITE_ATTEMPT_TYPE,
  SALES_CHANNEL_WRITE_FAILURE_STAGE,
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS,
  SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS,
  type SalesChannelWriteCommand,
  type SalesChannelWriteRequestStatus,
  type SalesChannelWriteTargetInput,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  assertOwnedSalesChannelWriteAttempt,
  createSalesChannelWriteAttempt,
  isSalesChannelWriteExecutionOwnershipLost,
  transferOwnedSalesChannelWriteAttempt,
  transitionOwnedSalesChannelWriteAttempt,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-execution-ownership";
import {
  assertSalesChannelWriteReviewOwnership,
  completeSalesChannelWriteReviewOperation,
  isSalesChannelWriteReviewOwnershipLost,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-review-ownership";
import {
  isSalesChannelWriteRequestRetryable,
  SALES_CHANNEL_WRITE_RETRYABLE_REQUEST_STATUSES,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-retry-policy";
import {
  loadSalesChannelWriteTargetSettlement,
  markPendingSalesChannelWriteTargets,
  markSalesChannelWriteTargetsLocalStatus,
  settleCoupangWriteTargetAssessment,
  settleSalesChannelWriteVerificationGroups,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-target-service";
import {
  deriveSalesChannelWriteRequestStatus,
  isCommittedSalesChannelWriteAttempt,
  isCommittedSalesChannelWriteLocalFinalization,
  successfulPendingTargetIds,
  type SalesChannelWriteAttemptCommitExpectation,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-target-state";

const CIRCUIT_FAILURE_LIMIT = 3;
const RETRYING_REQUEST_STATUS = "RETRYING";
const COMMITTED_FINALIZATION_INTEGRITY_ERROR =
  "Sales channel write committed finalization state is inconsistent.";

type SalesChannelWriteSettlement = {
  finalizeAttemptId: number | undefined;
  finalizeAttemptNo?: number;
  targetIds: number[];
  requestStatus: SalesChannelWriteRequestStatus;
};

type CommittedSettlementWithoutLocalFinalization = {
  result: SalesChannelWriteSettlement;
  expectedAttempt: SalesChannelWriteAttemptCommitExpectation;
};

export type SalesChannelWriteVerificationResult =
  CoupangWriteVerificationResult;

export type SalesChannelWriteConfirmation =
  | {
      source: "WRITE_RESPONSE";
      code: string | null;
    }
  | {
      source: "READ_AFTER_AMBIGUOUS_WRITE";
      verification: SalesChannelWriteVerificationResult;
    };

export type SalesChannelWriteLifecycle = {
  beforeDispatch?: (input: {
    requestId: number;
    command: SalesChannelWriteCommand;
  }) => Promise<void>;
  finalize: (input: {
    tx: Prisma.TransactionClient;
    requestId: number;
    command: SalesChannelWriteCommand;
    targetIds: readonly number[];
    finalizedAt: Date;
  }) => Promise<void>;
};

export type SalesChannelWriteExecutionDependencies = {
  executeWrite?: typeof executeSalesChannelWriteAdapter;
  verifyWrite?: typeof verifyAndRefreshCoupangWriteRequest;
  openCredentialContext?: typeof openCoupangApiCredentialContext;
};

export class SalesChannelWriteReviewRequiredError extends Error {
  readonly requestId: number;

  constructor(requestId: number, message: string) {
    super(message);
    this.name = "SalesChannelWriteReviewRequiredError";
    this.requestId = requestId;
  }
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown, fallback: string) {
  if (error instanceof CoupangWriteResponseContractError) {
    return error.code;
  }

  return error instanceof Error && text(error.name) ? error.name : fallback;
}

function committedFinalizationTargetIds(input: {
  expectedAttempt: SalesChannelWriteAttemptCommitExpectation;
  requestStatus: string;
  expectedTargetIds: readonly number[];
  finalizedAt: Date | string;
  attempt: {
    id: number;
    requestId: number;
    attemptNo: number;
    type: string;
    status: string;
    triggerType: string;
    completedAt: Date | string | null;
    requestDispatched: number;
    responseReceived: number;
    externalAppliedUnknown: number;
  };
  targets: readonly {
    id: number;
    externalResultStatus: string;
    localFinalizationStatus: string;
    localFinalizedAt: Date | string | null;
  }[];
}) {
  if (!isCommittedSalesChannelWriteLocalFinalization({
    expectedAttempt: input.expectedAttempt,
    requestStatus: input.requestStatus,
    expectedTargetIds: input.expectedTargetIds,
    finalizedAt: input.finalizedAt,
    attempt: {
      salesChannelWriteRequestId: input.attempt.requestId,
      salesChannelWriteRequestAttemptId: input.attempt.id,
      attemptNo: input.attempt.attemptNo,
      attemptType: input.attempt.type,
      attemptStatus: input.attempt.status,
      triggerType: input.attempt.triggerType,
      completedAt: input.attempt.completedAt,
      requestDispatched: input.attempt.requestDispatched,
      responseReceived: input.attempt.responseReceived,
      externalAppliedUnknown: input.attempt.externalAppliedUnknown,
    },
    targets: input.targets.map((target) => ({
      salesChannelWriteRequestTargetId: target.id,
      externalResultStatus: target.externalResultStatus,
      localFinalizationStatus: target.localFinalizationStatus,
      localFinalizedAt: target.localFinalizedAt,
    })),
  })) {
    throw new Error(COMMITTED_FINALIZATION_INTEGRITY_ERROR);
  }

  return [...input.expectedTargetIds];
}

async function recoverCommittedLocalFinalizationHandoff(input: {
  requestId: number;
  currentAttemptId: number;
  currentAttemptType: string;
  nextTriggerType: string;
}) {
  const [request, currentAttempt] = await Promise.all([
    prisma.sales_channel_write_requests.findUnique({
      where: { sales_channel_write_request_id: input.requestId },
      include: {
        active_review_attempt: true,
        targets: {
          orderBy: { target_position: "asc" },
          select: {
            sales_channel_write_request_target_id: true,
            external_result_status: true,
            local_finalization_status: true,
          },
        },
      },
    }),
    prisma.sales_channel_write_request_attempts.findUnique({
      where: {
        sales_channel_write_request_attempt_id: input.currentAttemptId,
      },
    }),
  ]);
  if (
    !request ||
    currentAttempt?.sales_channel_write_request_id !== input.requestId ||
    currentAttempt.attempt_type !== input.currentAttemptType ||
    !currentAttempt.completed_at ||
    currentAttempt.response_received !== 1
  ) {
    return null;
  }

  const targets = request.targets.map((target) => ({
    salesChannelWriteRequestTargetId:
      target.sales_channel_write_request_target_id,
    externalResultStatus: target.external_result_status,
    localFinalizationStatus: target.local_finalization_status,
  }));
  const targetIds = successfulPendingTargetIds(targets);
  const derivedRequestStatus = deriveSalesChannelWriteRequestStatus(targets);
  const activeAttempt = request.active_review_attempt;
  if (
    request.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending &&
    targetIds.length > 0 &&
    activeAttempt?.attempt_type ===
      SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize &&
    activeAttempt.attempt_status === SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending &&
    activeAttempt.trigger_type === input.nextTriggerType &&
    activeAttempt.attempt_no === currentAttempt.attempt_no + 1
  ) {
    return {
      finalizeAttemptId:
        activeAttempt.sales_channel_write_request_attempt_id,
      finalizeAttemptNo: activeAttempt.attempt_no,
      targetIds,
      requestStatus: derivedRequestStatus,
    };
  }
  return null;
}

async function recoverCommittedSettlementWithoutLocalFinalization(
  snapshot: CommittedSettlementWithoutLocalFinalization | null
) {
  if (!snapshot) return null;

  const attempt = await prisma.sales_channel_write_request_attempts.findUnique({
    where: {
      sales_channel_write_request_attempt_id:
        snapshot.expectedAttempt.attemptId,
    },
  });
  if (
    !attempt ||
    !isCommittedSalesChannelWriteAttempt({
      expected: snapshot.expectedAttempt,
      attempt: {
        salesChannelWriteRequestId: attempt.sales_channel_write_request_id,
        salesChannelWriteRequestAttemptId:
          attempt.sales_channel_write_request_attempt_id,
        attemptNo: attempt.attempt_no,
        attemptType: attempt.attempt_type,
        attemptStatus: attempt.attempt_status,
        triggerType: attempt.trigger_type,
        completedAt: attempt.completed_at,
        requestDispatched: attempt.request_dispatched,
        responseReceived: attempt.response_received,
        externalAppliedUnknown: attempt.external_applied_unknown,
      },
    })
  ) {
    return null;
  }

  return {
    ...snapshot.result,
    targetIds: [...snapshot.result.targetIds],
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Sales channel write was aborted before dispatch.");
}

function httpStatusFromError(error: unknown) {
  if (error instanceof CoupangWriteResponseContractError) {
    return error.httpStatusCode;
  }

  if (error instanceof CoupangApiResponseError) {
    return error.httpStatusCode;
  }

  const match = errorMessage(error).match(/response error \((\d{3})\)/i);

  return match ? Number.parseInt(match[1], 10) : null;
}

function externalResponseCodeFromError(error: unknown) {
  if (error instanceof CoupangWriteResponseContractError) {
    return error.externalResponseCode;
  }

  return error instanceof CoupangApiResponseError
    ? error.externalResponseCode
    : null;
}

function responseWasReceived(error: unknown, requestDispatched: boolean) {
  return (
    requestDispatched &&
    (error instanceof CoupangWriteResponseContractError ||
      httpStatusFromError(error) !== null)
  );
}

function writeRequestErrorCode(error: unknown, fallback: string) {
  return error instanceof CoupangWriteResponseContractError
    ? error.code
    : externalResponseCodeFromError(error) ?? errorCode(error, fallback);
}

function isAmbiguousWriteFailure(error: unknown) {
  const status = httpStatusFromError(error);
  const message = errorMessage(error).toLowerCase();

  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("json parse")
  );
}

function isReturnWriteRequest(command: SalesChannelWriteCommand) {
  return (
    command.requestType === "RETURN_STOPPED_SHIPMENT" ||
    command.requestType === "RETURN_RECEIVE_CONFIRMATION" ||
    command.requestType === "RETURN_APPROVAL"
  );
}

function supportsReadAfterAmbiguousWrite(command: SalesChannelWriteCommand) {
  return (
    isReturnWriteRequest(command) ||
    command.requestType === "ORDER_STATUS_INSTRUCT" ||
    command.requestType === "COUPANG_INVOICE_UPLOAD" ||
    command.requestType === "COUPANG_INVOICE_UPDATE" ||
    command.requestType === "COUPANG_INVENTORY_QUANTITY_UPDATE"
  );
}

function writeFailureDisposition(
  command: SalesChannelWriteCommand,
  error: unknown,
  requestDispatched: boolean
) {
  if (!requestDispatched) {
    return "NOT_APPLIED" as const;
  }

  if (error instanceof CoupangWriteResponseContractError) {
    if (
      error.assessment.outcome ===
      COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure
    ) {
      return "NOT_APPLIED" as const;
    }
    return supportsReadAfterAmbiguousWrite(command)
      ? ("VERIFY_REQUIRED" as const)
      : ("REVIEW_REQUIRED" as const);
  }

  const ambiguous = isAmbiguousWriteFailure(error);
  const returnStateConflict =
    isReturnWriteRequest(command) &&
    externalResponseCodeFromError(error)?.toUpperCase() ===
      "INVALID_RETURN_ACTION";

  if (
    (supportsReadAfterAmbiguousWrite(command) && ambiguous) ||
    returnStateConflict
  ) {
    return "VERIFY_REQUIRED" as const;
  }

  return ambiguous ? ("REVIEW_REQUIRED" as const) : ("NOT_APPLIED" as const);
}

function isCircuitFailure(error: unknown) {
  const status = httpStatusFromError(error);
  const message = errorMessage(error).toLowerCase();

  return (
    (status !== null && status >= 500) ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function completedAttemptData(input: {
    status: string;
    completedAt: Date;
    httpStatusCode?: number | null;
    externalResponseCode?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    requestDispatched?: boolean;
    responseReceived?: boolean;
    externalAppliedUnknown?: boolean;
    endpointPath?: string | null;
}) {
  return {
    attempt_status: input.status,
    completed_at: input.completedAt,
    http_status_code: input.httpStatusCode ?? null,
    external_response_code: safeCoupangExternalResponseCode(
      input.externalResponseCode
    ),
    external_response_message: null,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    request_dispatched: input.requestDispatched ? 1 : 0,
    response_received: input.responseReceived ? 1 : 0,
    external_applied_unknown: input.externalAppliedUnknown ? 1 : 0,
    endpoint_path: input.endpointPath ?? undefined,
  };
}

async function recordCircuitBookkeepingBestEffort(
  outcome: "SUCCESS" | "FAILURE",
  operation: () => Promise<void>
) {
  try {
    await operation();
  } catch (error) {
    // Circuit bookkeeping is secondary evidence. It must never reclassify an
    // external response or send the same write again.
    setOperationTraceField(
      "write.circuit_bookkeeping_status",
      `${outcome}_FAILED`
    );
    setOperationTraceField(
      "write.circuit_bookkeeping_error_code",
      errorCode(error, "CIRCUIT_BOOKKEEPING_ERROR")
    );
  }
}

function writeRequestSnapshotData(
  command: SalesChannelWriteCommand,
  endpoint: ReturnType<typeof getSalesChannelWriteEndpoint>
) {
  return {
    external_order_id: command.externalOrderId ?? null,
    allocation_id: command.allocationId ?? null,
    pg_no: command.pgNo ?? null,
    target_type: command.targetType ?? null,
    target_external_id: command.targetExternalId ?? null,
    package_group_id: command.packageGroupId ?? null,
    carrier_shipment_id: command.carrierShipmentId ?? null,
    method: endpoint.method,
    endpoint_path: endpoint.endpointPath,
    cancel_count: command.cancelCount ?? null,
    expected_before_status: command.expectedBeforeStatus ?? null,
    requested_after_status: command.requestedAfterStatus ?? null,
    source_menu_key: command.sourceMenuKey,
    source_entity_type: command.sourceEntityType,
    source_entity_id: command.sourceEntityId,
    source_projection_revision: command.sourceProjectionRevision ?? null,
    source_snapshot_digest: command.sourceSnapshotDigest ?? null,
    requested_by_user_id: command.requestedByUserId ?? null,
    worker_job_id: command.workerJobId ?? null,
  };
}

function writeRequestTargetData(input: {
  requestId: number;
  target: SalesChannelWriteTargetInput;
  targetPosition: number;
  createdAt: Date;
}) {
  const { requestId, target, targetPosition, createdAt } = input;

  return {
    sales_channel_write_request_id: requestId,
    target_type: target.targetType,
    target_external_id: target.targetExternalId ?? null,
    allocation_id: target.allocationId ?? null,
    pg_no: target.pgNo ?? null,
    external_order_id: target.externalOrderId ?? null,
    external_shipment_id: target.externalShipmentId ?? null,
    external_vendor_item_id: target.externalVendorItemId ?? null,
    package_group_id: target.packageGroupId ?? null,
    carrier_shipment_id: target.carrierShipmentId ?? null,
    delivery_company_code: target.deliveryCompanyCode ?? null,
    invoice_number_snapshot: target.invoiceNumberSnapshot ?? null,
    split_shipping:
      target.splitShipping == null ? null : target.splitShipping ? 1 : 0,
    pre_split_shipped:
      target.preSplitShipped == null
        ? null
        : target.preSplitShipped
          ? 1
          : 0,
    estimated_shipping_date: target.estimatedShippingDate ?? null,
    supply_consumption_event_id: target.supplyConsumptionEventId ?? null,
    quantity: target.quantity ?? null,
    inventory_verification_state_id:
      target.inventoryVerificationStateId ?? null,
    inventory_desired_version_snapshot:
      target.inventoryDesiredVersionSnapshot ?? null,
    inventory_mismatch_since_snapshot:
      databaseDateTimeOrNull(target.inventoryMismatchSinceSnapshot),
    inventory_projection_basis_hash_snapshot:
      target.inventoryProjectionBasisHashSnapshot ?? null,
    inventory_ledger_quantity_snapshot:
      target.inventoryLedgerQuantitySnapshot ?? null,
    inventory_pending_order_quantity_snapshot:
      target.inventoryPendingOrderQuantitySnapshot ?? null,
    inventory_expected_channel_quantity_snapshot:
      target.inventoryExpectedChannelQuantitySnapshot ?? null,
    inventory_observed_channel_quantity_snapshot:
      target.inventoryObservedChannelQuantitySnapshot ?? null,
    expected_before_status: target.expectedBeforeStatus ?? null,
    requested_after_status: target.requestedAfterStatus ?? null,
    inspection_result: target.inspectionResult ?? null,
    appearance_grade: target.appearanceGrade ?? null,
    appearance_defect: target.appearanceDefect ?? null,
    function_defect: target.functionDefect ?? null,
    inspection_note: target.inspectionNote ?? null,
    target_position: targetPosition,
    created_at: createdAt,
  };
}

async function createWriteRequestTargets(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targets: SalesChannelWriteTargetInput[];
  createdAt: Date;
}) {
  for (const [targetPosition, target] of input.targets.entries()) {
    await input.tx.sales_channel_write_request_targets.create({
      data: writeRequestTargetData({
        requestId: input.requestId,
        target,
        targetPosition,
        createdAt: input.createdAt,
      }),
    });
  }
}

function writeCommandTargets(
  command: SalesChannelWriteCommand
): SalesChannelWriteTargetInput[] {
  return command.targets.length > 0
    ? command.targets
    : [
        {
          targetType: command.targetType ?? command.sourceEntityType,
          targetExternalId: command.targetExternalId ?? command.sourceEntityId,
          allocationId: command.allocationId ?? null,
          pgNo: command.pgNo ?? null,
          externalOrderId: command.externalOrderId ?? null,
          packageGroupId: command.packageGroupId ?? null,
          carrierShipmentId: command.carrierShipmentId ?? null,
          expectedBeforeStatus: command.expectedBeforeStatus ?? null,
          requestedAfterStatus: command.requestedAfterStatus ?? null,
        },
      ];
}

export function digestSalesChannelWriteCommand(
  command: SalesChannelWriteCommand
) {
  // Execution ownership is allowed to change when a durable request is retried.
  // The idempotency contract therefore covers only the requested external
  // effect and its immutable target snapshot, never the worker/user that
  // happened to dispatch it.
  const immutableCommand: Partial<SalesChannelWriteCommand> = { ...command };
  delete immutableCommand.workerJobId;
  delete immutableCommand.requestedByUserId;

  return digestDomainOperation({
    channel: command.channel,
    requestType: command.requestType,
    command: immutableCommand,
  });
}

async function registerSalesChannelWriteIntegrationCommand(input: {
  tx: Prisma.TransactionClient;
  command: SalesChannelWriteCommand;
  requestId: number;
  dispatchGeneration: number;
}) {
  const targetSnapshot = JSON.parse(
    JSON.stringify({
      salesChannelWriteRequestId: input.requestId,
      dispatchGeneration: input.dispatchGeneration,
      targets: writeCommandTargets(input.command),
    })
  ) as IntegrationJsonObject;
  const requestPayload = JSON.parse(
    JSON.stringify(input.command)
  ) as IntegrationJsonValue;
  const registered = await registerIntegrationCommand(input.tx, {
    provider: input.command.channel,
    operationType: input.command.requestType,
    operationKey: `sales-channel-write:${input.requestId}:dispatch:${input.dispatchGeneration}`,
    targetSnapshot,
    requestPayload,
  });
  if (registered.created) {
    await input.tx.integration_command_attempts.create({
      data: {
        integration_command_attempt_id: randomUUID(),
        integration_command_id: registered.row.integration_command_id,
        attempt_no: 1,
        dispatch_status: "CREATED",
      },
    });
  }
  return registered;
}

async function recordSalesChannelWriteIntegrationEvidence(input: {
  tx: Prisma.TransactionClient;
  integrationCommandId: string | null;
  response: Awaited<ReturnType<typeof executeSalesChannelWriteAdapter>> | undefined;
  assessment: CoupangWriteResponseAssessment | undefined;
  receivedAt: Date;
}) {
  if (!input.integrationCommandId) return;
  const attempt = await input.tx.integration_command_attempts.findFirst({
    where: { integration_command_id: input.integrationCommandId },
    orderBy: { attempt_no: "desc" },
  });
  if (!attempt) return;
  const rawPayloadText = input.response
    ? input.response.rawPayloadText ?? JSON.stringify(input.response.payload)
    : "";
  const outcome =
    input.assessment?.outcome === COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess ||
    input.assessment?.outcome === COUPANG_WRITE_RESPONSE_OUTCOME.partial
      ? "SUCCEEDED"
      : input.assessment?.outcome ===
          COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure
        ? "NOT_APPLIED"
        : "AMBIGUOUS";
  await input.tx.integration_evidences.create({
    data: {
      integration_evidence_id: randomUUID(),
      integration_command_id: input.integrationCommandId,
      integration_command_attempt_id:
        attempt.integration_command_attempt_id,
      provider: "COUPANG",
      evidence_type: input.response
        ? "COMMAND_RESPONSE"
        : "COMMAND_TRANSPORT_UNCERTAIN",
      outcome,
      raw_payload_text: input.response ? rawPayloadText : null,
      raw_payload_digest: digestRawIntegrationPayload(rawPayloadText),
      ...(input.assessment
        ? {
            normalized_result: JSON.parse(
              JSON.stringify(input.assessment)
            ) as Prisma.InputJsonValue,
          }
        : {}),
      received_at: input.receivedAt,
      created_at: input.receivedAt,
    },
  });
}

async function createWriteRequest(command: SalesChannelWriteCommand) {
  const timestamp = databaseNow();
  const endpoint = getSalesChannelWriteEndpoint(command);
  const snapshotData = writeRequestSnapshotData(command, endpoint);
  const requestDigest = digestSalesChannelWriteCommand(command);

  return runMeasuredTransaction(prisma, "sales-channel.write.request", async (tx) => {
    // The idempotency row may not exist yet, so a row lock cannot serialize
    // two first submissions. PostgreSQL's transaction advisory lock gives the
    // key a database-owned critical section before the lookup/create decision.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${command.idempotencyKey}, 0)
      )
    `;
    const existing = await tx.sales_channel_write_requests.findUnique({
      where: { idempotency_key: command.idempotencyKey },
    });

    if (existing) {
      if (
        existing.channel !== command.channel ||
        existing.request_type !== command.requestType ||
        existing.request_digest !== requestDigest
      ) {
        throw new SalesChannelWriteReviewRequiredError(
          existing.sales_channel_write_request_id,
          "같은 멱등 키가 다른 외부 API 작업에 사용되었습니다. 처리 확인 메뉴에서 기존 요청을 확인하세요."
        );
      }

      const retryable = isSalesChannelWriteRequestRetryable(
        existing.request_status
      );

      if (retryable) {
        const claimed = await tx.sales_channel_write_requests.updateMany({
          where: {
            sales_channel_write_request_id:
              existing.sales_channel_write_request_id,
            channel: command.channel,
            request_type: command.requestType,
            idempotency_key: command.idempotencyKey,
            request_status: {
              in: [...SALES_CHANNEL_WRITE_RETRYABLE_REQUEST_STATUSES],
            },
            active_review_attempt_id: null,
          },
          data: {
            request_status: RETRYING_REQUEST_STATUS,
            updated_at: timestamp,
          },
        });

        if (claimed.count !== 1) {
          throw new SalesChannelWriteReviewRequiredError(
            existing.sales_channel_write_request_id,
            "같은 외부 API 요청의 재시도가 이미 시작되었습니다. 처리 확인 메뉴에서 상태를 확인하세요."
          );
        }

        const [targetCount, resetTargets] = await Promise.all([
          tx.sales_channel_write_request_targets.count({
            where: {
              sales_channel_write_request_id:
                existing.sales_channel_write_request_id,
            },
          }),
          tx.sales_channel_write_request_targets.updateMany({
            where: {
              sales_channel_write_request_id:
                existing.sales_channel_write_request_id,
              external_result_status:
                SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied,
              local_finalization_status:
                SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired,
            },
            data: {
              external_result_status:
                SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.pending,
              external_result_code: null,
              external_result_message: null,
              retry_required: 0,
              result_received_at: null,
              local_finalization_status:
                SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending,
              local_finalized_at: null,
            },
          }),
        ]);
        if (targetCount === 0 || resetTargets.count !== targetCount) {
          throw new Error(
            "Retryable sales-channel write targets are inconsistent."
          );
        }

        const request = await tx.sales_channel_write_requests.update({
          where: {
            sales_channel_write_request_id:
              existing.sales_channel_write_request_id,
          },
          data: {
            request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.pending,
            revision: { increment: 1 },
            failure_stage: null,
            error_code: null,
            error_message: null,
            sending_at: null,
            verifying_at: null,
            completed_at: null,
            local_finalized_at: null,
            review_required_at: null,
            manual_verification_status: null,
            manual_verified_by_user_id: null,
            manual_verified_at: null,
            manual_verification_note: null,
            active_review_attempt_id: null,
            active_review_heartbeat_at: null,
            requested_at: timestamp,
            updated_at: timestamp,
          },
        });

        const integrationCommand =
          await registerSalesChannelWriteIntegrationCommand({
            tx,
            command,
            requestId: request.sales_channel_write_request_id,
            dispatchGeneration: request.revision,
          });

        const writeAttempt = await createSalesChannelWriteAttempt(tx, {
          requestId: request.sales_channel_write_request_id,
          attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
          triggerType: "INITIAL",
          method: endpoint.method,
          endpointPath: endpoint.endpointPath,
          startedAt: timestamp,
          integrationCommandId:
            integrationCommand.row.integration_command_id,
        });

        return { request, writeAttempt };
      }

      throw new SalesChannelWriteReviewRequiredError(
        existing.sales_channel_write_request_id,
        existing.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.completed
          ? "이미 완료된 외부 API 요청입니다."
          : "같은 외부 API 요청 이력이 이미 있습니다. 처리 확인 메뉴에서 상태를 확인하세요."
      );
    }

    const request = await tx.sales_channel_write_requests.create({
      data: {
        channel: command.channel,
        request_type: command.requestType,
        request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.pending,
        idempotency_key: command.idempotencyKey,
        request_digest: requestDigest,
        revision: 1,
        ...snapshotData,
        requested_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });

    await createWriteRequestTargets({
      tx,
      requestId: request.sales_channel_write_request_id,
      targets: writeCommandTargets(command),
      createdAt: timestamp,
    });

    const integrationCommand =
      await registerSalesChannelWriteIntegrationCommand({
        tx,
        command,
        requestId: request.sales_channel_write_request_id,
        dispatchGeneration: request.revision,
      });

    const writeAttempt = await createSalesChannelWriteAttempt(tx, {
      requestId: request.sales_channel_write_request_id,
      attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
      triggerType: "INITIAL",
      method: endpoint.method,
      endpointPath: endpoint.endpointPath,
      startedAt: timestamp,
      integrationCommandId: integrationCommand.row.integration_command_id,
    });

    return { request, writeAttempt };
  });
}

async function rejectWriteRequest(input: {
  requestId: number;
  attemptId: number;
  error: unknown;
}) {
  const timestamp = databaseNow();

  await runMeasuredTransaction(
    prisma,
    "sales-channel.write.reject",
    async (tx) => {
      await markPendingSalesChannelWriteTargets({
        tx,
        requestId: input.requestId,
        externalStatus: "NOT_APPLIED",
        resultCode: errorCode(input.error, "WRITE_BLOCKED"),
        receivedAt: timestamp,
      });
      return transitionOwnedSalesChannelWriteAttempt(tx, {
        requestId: input.requestId,
        attemptId: input.attemptId,
        expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.pending,
        expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
        expectedRequestDispatched: false,
        requestData: {
          request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.rejected,
          failure_stage: SALES_CHANNEL_WRITE_FAILURE_STAGE.writeTransport,
          error_code: errorCode(input.error, "WRITE_BLOCKED"),
          error_message: errorMessage(input.error),
          updated_at: timestamp,
        },
        attemptData: completedAttemptData({
          status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed,
          completedAt: timestamp,
          errorCode: errorCode(input.error, "WRITE_BLOCKED"),
          errorMessage: errorMessage(input.error),
        }),
      });
    }
  );
}

async function assertControlIsOpen(command: SalesChannelWriteCommand) {
  const endpoint = getSalesChannelWriteEndpoint(command);
  const control = await prisma.sales_channel_write_controls.findUnique({
    where: {
      channel_endpoint_key: {
        channel: command.channel,
        endpoint_key: endpoint.endpointKey,
      },
    },
  });

  if (control?.is_paused === 1) {
    throw publicConflict(
      "SALES_CHANNEL_WRITE_PAUSED",
      `${command.channel} ${command.requestType} 쓰기가 연속 실패로 일시 정지되었습니다. 시스템 관리자가 처리 확인 후 다시 열어야 합니다.`
    );
  }
}

async function recordCircuitSuccess(command: SalesChannelWriteCommand) {
  const endpoint = getSalesChannelWriteEndpoint(command);

  await prisma.sales_channel_write_controls.updateMany({
    where: {
      channel: command.channel,
      endpoint_key: endpoint.endpointKey,
      is_paused: 0,
    },
    data: {
      consecutive_failure_count: 0,
      revision: { increment: 1 },
      updated_at: databaseNow(),
    },
  });
}

async function recordCircuitFailure(
  command: SalesChannelWriteCommand,
  error: unknown
) {
  if (!isCircuitFailure(error)) {
    return;
  }

  const timestamp = databaseNow();
  const endpoint = getSalesChannelWriteEndpoint(command);

  await runMeasuredTransaction(prisma, "sales-channel.write.failure", async (tx) => {
    const pauseReason = "동일 쓰기 API에서 전송 오류가 3회 연속 발생했습니다.";
    const failureCode = errorCode(error, "WRITE_TRANSPORT_ERROR");
    const failureMessage = errorMessage(error);
    await tx.$executeRaw`
      INSERT INTO sales_channel_write_controls (
        revision, channel, endpoint_key, request_type, is_paused,
        consecutive_failure_count, pause_reason, last_failure_code,
        last_failure_message, last_failure_at, paused_at, created_at, updated_at
      ) VALUES (
        1, ${command.channel}, ${endpoint.endpointKey}, ${command.requestType}, 0,
        1, NULL, ${failureCode}, ${failureMessage}, ${timestamp}, NULL,
        ${timestamp}, ${timestamp}
      )
      ON CONFLICT (channel, endpoint_key) DO UPDATE
      SET revision = sales_channel_write_controls.revision + 1,
          consecutive_failure_count = sales_channel_write_controls.consecutive_failure_count + 1,
          is_paused = CASE
            WHEN sales_channel_write_controls.consecutive_failure_count + 1 >= ${CIRCUIT_FAILURE_LIMIT}
              THEN 1
            ELSE sales_channel_write_controls.is_paused
          END,
          pause_reason = CASE
            WHEN sales_channel_write_controls.consecutive_failure_count + 1 >= ${CIRCUIT_FAILURE_LIMIT}
              THEN ${pauseReason}
            ELSE sales_channel_write_controls.pause_reason
          END,
          paused_at = CASE
            WHEN sales_channel_write_controls.is_paused = 0
             AND sales_channel_write_controls.consecutive_failure_count + 1 >= ${CIRCUIT_FAILURE_LIMIT}
              THEN ${timestamp}
            ELSE sales_channel_write_controls.paused_at
          END,
          last_failure_code = ${failureCode},
          last_failure_message = ${failureMessage},
          last_failure_at = ${timestamp},
          updated_at = ${timestamp}
    `;
  });
}

export async function requestSalesChannelWrite(
  command: SalesChannelWriteCommand,
  lifecycle: SalesChannelWriteLifecycle,
  dependencies: SalesChannelWriteExecutionDependencies = {},
  options: { signal?: AbortSignal } = {}
) {
  throwIfAborted(options.signal);
  setOperationTraceField("write.request_type", command.requestType);
  setOperationTraceField("write.channel", command.channel);
  setOperationTraceTargetCount(writeCommandTargets(command).length);
  const execution = await traceOperationSpan("WRITE_REQUEST_CREATE", () =>
    createWriteRequest(command)
  );
  const request = execution.request;
  const writeAttempt = execution.writeAttempt;
  const requestId = request.sales_channel_write_request_id;

  try {
    throwIfAborted(options.signal);
    assertSalesChannelWriteAllowed(command);
    await assertControlIsOpen(command);
    await lifecycle.beforeDispatch?.({ requestId, command });
  } catch (error) {
    await rejectWriteRequest({
      requestId,
      attemptId: writeAttempt.sales_channel_write_request_attempt_id,
      error,
    });
    throw error;
  }

  const sendingAt = databaseNow();
  await runMeasuredTransaction(
    prisma,
    "sales-channel.write.begin",
    (tx) =>
      transitionOwnedSalesChannelWriteAttempt(tx, {
        requestId,
        attemptId: writeAttempt.sales_channel_write_request_attempt_id,
        expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.pending,
        expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
        expectedRequestDispatched: false,
        requestData: {
          request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
          sending_at: sendingAt,
          updated_at: sendingAt,
        },
        attemptData: { started_at: sendingAt },
      })
  );

  let writeResponse:
    | Awaited<ReturnType<typeof executeSalesChannelWriteAdapter>>
    | undefined;
  let writeResponseAssessment: CoupangWriteResponseAssessment | undefined;
  let credentialContext: CoupangApiCredentialContext | undefined;
  let requestDispatched = false;
  let verificationAttemptTrigger = "IMMEDIATE_VERIFY";
  let writeFailed = false;
  let writeError: unknown;

  try {
    throwIfAborted(options.signal);
    const needsCredentialContext =
      Boolean(dependencies.openCredentialContext) ||
      !dependencies.executeWrite;

    if (needsCredentialContext) {
      credentialContext = await (
        dependencies.openCredentialContext ?? openCoupangApiCredentialContext
      )("FORCE_FRESH_WRITE");
      setOperationTraceField(
        "qhkey.credential_context_scope",
        "WRITE_WITH_RECOVERY_READ"
      );
      setOperationTraceField("qhkey.credential_context_reuse_enabled", true);
    }

    throwIfAborted(options.signal);
    const dispatchedAt = databaseNow();
    await runMeasuredTransaction(
      prisma,
      "sales-channel.write.dispatch",
      (tx) =>
        transitionOwnedSalesChannelWriteAttempt(tx, {
          requestId,
          attemptId: writeAttempt.sales_channel_write_request_attempt_id,
          expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
          expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
          expectedRequestDispatched: false,
          requestData: { updated_at: dispatchedAt },
          attemptData: { request_dispatched: 1 },
        })
    );
    requestDispatched = true;

    writeResponse = await traceOperationSpan("EXTERNAL_WRITE", () =>
      (dependencies.executeWrite ?? executeSalesChannelWriteAdapter)(
        command,
        credentialContext,
        { signal: options.signal }
      )
    );
    writeResponseAssessment = assessCoupangWriteResponse(
      command,
      writeResponse.payload
    );
    const safelyAttributablePartial =
      writeResponseAssessment.outcome ===
        COUPANG_WRITE_RESPONSE_OUTCOME.partial &&
      command.requestType === "ORDER_STATUS_INSTRUCT";
    if (
      writeResponseAssessment.outcome !==
        COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess &&
      !safelyAttributablePartial
    ) {
      throw new CoupangWriteResponseContractError({
        assessment: writeResponseAssessment,
        httpStatusCode: writeResponse.httpStatusCode,
      });
    }
  } catch (error) {
    if (isSalesChannelWriteExecutionOwnershipLost(error)) {
      throw error;
    }
    writeFailed = true;
    writeError = error;
  }

  let verifyAttemptId: number | undefined;
  let verifyAttemptNo: number | undefined;
  let finalizeAttemptId: number | undefined;
  let finalizeAttemptNo: number | undefined;
  let finalizationTriggerType: string | null = null;
  let finalizationTargetIds: number[] = [];
  let verification: SalesChannelWriteVerificationResult | null = null;
  let unresolvedReviewAfterFinalization: {
    failureStage: string;
    errorCode: string;
    errorMessage: string;
  } | null = null;
  let confirmation!: SalesChannelWriteConfirmation;

  if (!writeFailed) {
    const completedAt = databaseNow();

    let responseSettlement: SalesChannelWriteSettlement;
    let committedResponseSettlementWithoutLocalFinalization:
      | CommittedSettlementWithoutLocalFinalization
      | null = null;
    try {
      responseSettlement = await runMeasuredTransaction(
        prisma,
        "sales-channel.write.response-confirmed",
        async (tx) => {
        await assertOwnedSalesChannelWriteAttempt(tx, {
          requestId,
          attemptId: writeAttempt.sales_channel_write_request_attempt_id,
          expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
          expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
          expectedRequestDispatched: true,
        });
        await recordSalesChannelWriteIntegrationEvidence({
          tx,
          integrationCommandId: writeAttempt.integration_command_id,
          response: writeResponse,
          assessment: writeResponseAssessment,
          receivedAt: completedAt,
        });
        const targetSettlement = await settleCoupangWriteTargetAssessment({
          tx,
          requestId,
          command,
          assessment: writeResponseAssessment!,
          receivedAt: completedAt,
        });

        if (
          targetSettlement.requestStatus ===
            SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired &&
          targetSettlement.targetIds.length === 0
        ) {
          await transitionOwnedSalesChannelWriteAttempt(tx, {
            requestId,
            attemptId: writeAttempt.sales_channel_write_request_attempt_id,
            expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
            expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            expectedRequestDispatched: true,
            attemptData: completedAttemptData({
              status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
              completedAt,
              httpStatusCode: writeResponse?.httpStatusCode ?? null,
              externalResponseCode:
                writeResponseAssessment?.externalResponseCode ?? null,
              errorCode:
                writeResponseAssessment?.errorCode ??
                "WRITE_TARGET_RESULT_UNKNOWN",
              errorMessage: writeResponseAssessment?.summary ?? null,
              requestDispatched: true,
              responseReceived: true,
              externalAppliedUnknown: true,
            }),
            requestData: {
              request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
              failure_stage: SALES_CHANNEL_WRITE_FAILURE_STAGE.writeResponse,
              error_code:
                writeResponseAssessment?.errorCode ??
                "WRITE_TARGET_RESULT_UNKNOWN",
              error_message: writeResponseAssessment?.summary ?? null,
              review_required_at: completedAt,
              updated_at: completedAt,
            },
          });
          const result = {
            finalizeAttemptId: undefined,
            targetIds: [] as number[],
            requestStatus: targetSettlement.requestStatus,
          };
          committedResponseSettlementWithoutLocalFinalization = {
            result,
            expectedAttempt: {
              requestId,
              attemptId:
                writeAttempt.sales_channel_write_request_attempt_id,
              attemptNo: writeAttempt.attempt_no,
              attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
              attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
              triggerType: "INITIAL",
              completedAt,
              requestDispatched: true,
              responseReceived: true,
              externalAppliedUnknown: true,
            },
          };
          return result;
        }

        const finalizeAttempt = await transferOwnedSalesChannelWriteAttempt(tx, {
          requestId,
          attemptId: writeAttempt.sales_channel_write_request_attempt_id,
          expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
          expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
          expectedRequestDispatched: true,
          nextRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
          currentAttemptData: completedAttemptData({
            status:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous
                : SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
            completedAt,
            httpStatusCode: writeResponse?.httpStatusCode ?? null,
            externalResponseCode:
              writeResponseAssessment?.externalResponseCode ?? null,
            requestDispatched: true,
            responseReceived: true,
            externalAppliedUnknown:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
          }),
          requestData: {
            request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
            failure_stage:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? SALES_CHANNEL_WRITE_FAILURE_STAGE.writeResponse
                : null,
            error_code:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? writeResponseAssessment?.errorCode ??
                  "WRITE_TARGET_RESULT_UNKNOWN"
                : null,
            error_message:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? writeResponseAssessment?.summary ?? null
                : null,
            review_required_at:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? completedAt
                : null,
            updated_at: completedAt,
          },
          nextAttempt: {
            attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
            triggerType: "AFTER_CONFIRMED_WRITE_RESPONSE",
            startedAt: completedAt,
          },
          bindNextAsActiveReviewAttempt: true,
        });
        return {
          finalizeAttemptId:
            finalizeAttempt.sales_channel_write_request_attempt_id,
          finalizeAttemptNo: finalizeAttempt.attempt_no,
          targetIds: targetSettlement.targetIds,
          requestStatus: targetSettlement.requestStatus,
        };
        }
      );
    } catch (error) {
      const recovered = committedResponseSettlementWithoutLocalFinalization
        ? await recoverCommittedSettlementWithoutLocalFinalization(
            committedResponseSettlementWithoutLocalFinalization
          )
        : await recoverCommittedLocalFinalizationHandoff({
            requestId,
            currentAttemptId:
              writeAttempt.sales_channel_write_request_attempt_id,
            currentAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            nextTriggerType: "AFTER_CONFIRMED_WRITE_RESPONSE",
          });
      if (!recovered) throw error;
      responseSettlement = recovered;
    }
    finalizeAttemptId = responseSettlement.finalizeAttemptId;
    finalizeAttemptNo = responseSettlement.finalizeAttemptNo;
    if (finalizeAttemptId !== undefined) {
      finalizationTriggerType = "AFTER_CONFIRMED_WRITE_RESPONSE";
    }
    finalizationTargetIds = responseSettlement.targetIds;
    if (
      responseSettlement.requestStatus ===
      SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
    ) {
      unresolvedReviewAfterFinalization = {
        failureStage: SALES_CHANNEL_WRITE_FAILURE_STAGE.writeResponse,
        errorCode:
          writeResponseAssessment?.errorCode ?? "WRITE_TARGET_RESULT_UNKNOWN",
        errorMessage:
          writeResponseAssessment?.summary ??
          "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다.",
      };
    }
    confirmation = {
      source: "WRITE_RESPONSE",
      code: writeResponseAssessment?.externalResponseCode ?? null,
    };
    setOperationTraceField("write.confirmation_source", confirmation.source);
    await recordCircuitBookkeepingBestEffort("SUCCESS", () =>
      recordCircuitSuccess(command)
    );
    if (finalizeAttemptId === undefined) {
      throw new SalesChannelWriteReviewRequiredError(
        requestId,
        "외부 채널의 대상별 처리 결과를 안전하게 식별할 수 없습니다. 처리 확인 메뉴에서 확인하세요."
      );
    }
  } else {
    const completedAt = databaseNow();
    const disposition = writeFailureDisposition(
      command,
      writeError,
      requestDispatched
    );
    const externalAppliedUnknown =
      disposition === "VERIFY_REQUIRED" ||
      disposition === "REVIEW_REQUIRED";

    if (disposition === "REVIEW_REQUIRED") {
      await runMeasuredTransaction(
        prisma,
        "sales-channel.write.review-required",
        async (tx) => {
          await assertOwnedSalesChannelWriteAttempt(tx, {
            requestId,
            attemptId: writeAttempt.sales_channel_write_request_attempt_id,
            expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
            expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            expectedRequestDispatched: requestDispatched,
          });
          await recordSalesChannelWriteIntegrationEvidence({
            tx,
            integrationCommandId: writeAttempt.integration_command_id,
            response: writeResponse,
            assessment: writeResponseAssessment,
            receivedAt: completedAt,
          });
          if (writeError instanceof CoupangWriteResponseContractError) {
            await settleCoupangWriteTargetAssessment({
              tx,
              requestId,
              command,
              assessment: writeError.assessment,
              receivedAt: completedAt,
            });
          } else {
            await markPendingSalesChannelWriteTargets({
              tx,
              requestId,
              externalStatus: "UNKNOWN",
              resultCode: writeRequestErrorCode(
                writeError,
                "WRITE_RESULT_UNKNOWN"
              ),
              receivedAt: completedAt,
            });
          }
          return transitionOwnedSalesChannelWriteAttempt(tx, {
            requestId,
            attemptId: writeAttempt.sales_channel_write_request_attempt_id,
            expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
            expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            expectedRequestDispatched: requestDispatched,
            attemptData: completedAttemptData({
              status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
              completedAt,
              httpStatusCode: httpStatusFromError(writeError),
              externalResponseCode: externalResponseCodeFromError(writeError),
              errorCode: errorCode(writeError, "EXTERNAL_WRITE_ERROR"),
              errorMessage: errorMessage(writeError),
              requestDispatched,
              responseReceived: responseWasReceived(
                writeError,
                requestDispatched
              ),
              externalAppliedUnknown: true,
            }),
            requestData: {
              request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
              failure_stage:
                writeError instanceof CoupangWriteResponseContractError
                  ? SALES_CHANNEL_WRITE_FAILURE_STAGE.writeResponse
                  : SALES_CHANNEL_WRITE_FAILURE_STAGE.writeTransport,
              error_code: writeRequestErrorCode(
                writeError,
                "WRITE_RESULT_UNKNOWN"
              ),
              error_message: errorMessage(writeError),
              review_required_at: completedAt,
              updated_at: completedAt,
            },
          });
        }
      );
      if (requestDispatched) {
        await recordCircuitBookkeepingBestEffort("FAILURE", () =>
          recordCircuitFailure(command, writeError)
        );
      }
      throw new SalesChannelWriteReviewRequiredError(
        requestId,
        "외부 채널 처리 여부를 확정할 수 없습니다. 자동 재요청하지 않았으므로 처리 확인 메뉴에서 채널 결과를 확인하세요."
      );
    }

    if (disposition === "VERIFY_REQUIRED") {
      // Do not resend. State-aware writes are followed by a read-only targeted
      // verification, which can safely resolve timeout-after-apply and
      // already-transitioned return state conflicts.
      writeResponse = undefined;
      verificationAttemptTrigger =
        externalResponseCodeFromError(writeError)?.toUpperCase() ===
        "INVALID_RETURN_ACTION"
          ? "IMMEDIATE_VERIFY_AFTER_STATE_CONFLICT"
          : "IMMEDIATE_VERIFY_AFTER_WRITE_UNCERTAINTY";

      const verifyingAt = databaseNow();
      const verifyAttemptIdentity = await runMeasuredTransaction(
        prisma,
        "sales-channel.write.ambiguous-and-verify",
        async (tx) => {
          await recordSalesChannelWriteIntegrationEvidence({
            tx,
            integrationCommandId: writeAttempt.integration_command_id,
            response: writeResponse,
            assessment: writeResponseAssessment,
            receivedAt: completedAt,
          });
          const verifyAttempt = await transferOwnedSalesChannelWriteAttempt(tx, {
            requestId,
            attemptId: writeAttempt.sales_channel_write_request_attempt_id,
            expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
            expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            expectedRequestDispatched: requestDispatched,
            nextRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
            currentAttemptData: completedAttemptData({
              status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
              completedAt,
              httpStatusCode: httpStatusFromError(writeError),
              externalResponseCode: externalResponseCodeFromError(writeError),
              errorCode: errorCode(writeError, "EXTERNAL_WRITE_ERROR"),
              errorMessage: errorMessage(writeError),
              requestDispatched,
              responseReceived: responseWasReceived(
                writeError,
                requestDispatched
              ),
              externalAppliedUnknown: true,
            }),
            requestData: {
              request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
              verifying_at: verifyingAt,
              updated_at: verifyingAt,
            },
            nextAttempt: {
              attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
              triggerType: verificationAttemptTrigger,
              method: "GET",
              endpointPath: command.sourceEntityType,
              startedAt: verifyingAt,
            },
          });
          return {
            attemptId: verifyAttempt.sales_channel_write_request_attempt_id,
            attemptNo: verifyAttempt.attempt_no,
          };
        }
      );
      verifyAttemptId = verifyAttemptIdentity.attemptId;
      verifyAttemptNo = verifyAttemptIdentity.attemptNo;
    } else {
      await runMeasuredTransaction(
        prisma,
        "sales-channel.write.not-applied",
        async (tx) => {
          await assertOwnedSalesChannelWriteAttempt(tx, {
            requestId,
            attemptId: writeAttempt.sales_channel_write_request_attempt_id,
            expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
            expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            expectedRequestDispatched: requestDispatched,
          });
          await recordSalesChannelWriteIntegrationEvidence({
            tx,
            integrationCommandId: writeAttempt.integration_command_id,
            response: writeResponse,
            assessment: writeResponseAssessment,
            receivedAt: completedAt,
          });
          if (writeError instanceof CoupangWriteResponseContractError) {
            await settleCoupangWriteTargetAssessment({
              tx,
              requestId,
              command,
              assessment: writeError.assessment,
              receivedAt: completedAt,
            });
          } else {
            await markPendingSalesChannelWriteTargets({
              tx,
              requestId,
              externalStatus: "NOT_APPLIED",
              resultCode: writeRequestErrorCode(
                writeError,
                "EXTERNAL_WRITE_REJECTED"
              ),
              receivedAt: completedAt,
            });
          }
          return transitionOwnedSalesChannelWriteAttempt(tx, {
            requestId,
            attemptId: writeAttempt.sales_channel_write_request_attempt_id,
            expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
            expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write,
            expectedRequestDispatched: requestDispatched,
            attemptData: completedAttemptData({
              status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed,
              completedAt,
              httpStatusCode: httpStatusFromError(writeError),
              externalResponseCode: externalResponseCodeFromError(writeError),
              errorCode: errorCode(writeError, "EXTERNAL_WRITE_ERROR"),
              errorMessage: errorMessage(writeError),
              requestDispatched,
              responseReceived: responseWasReceived(
                writeError,
                requestDispatched
              ),
              externalAppliedUnknown,
            }),
            requestData: {
              request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied,
              failure_stage: requestDispatched
                ? SALES_CHANNEL_WRITE_FAILURE_STAGE.writeResponse
                : SALES_CHANNEL_WRITE_FAILURE_STAGE.writeTransport,
              error_code: writeRequestErrorCode(
                writeError,
                "EXTERNAL_WRITE_REJECTED"
              ),
              error_message: errorMessage(writeError),
              updated_at: completedAt,
            },
          });
        }
      );
      if (requestDispatched) {
        await recordCircuitBookkeepingBestEffort("FAILURE", () =>
          recordCircuitFailure(command, writeError)
        );
      }
      throw writeError;
    }

    if (requestDispatched) {
      await recordCircuitBookkeepingBestEffort("FAILURE", () =>
        recordCircuitFailure(command, writeError)
      );
    }
  }

  if (verifyAttemptId !== undefined) {
  if (verifyAttemptNo === undefined) {
    throw new Error("Sales channel verification attempt identity is incomplete.");
  }
  let verificationEndpointPath = command.sourceEntityType;

  const verificationDispatchedAt = databaseNow();
  await runMeasuredTransaction(
    prisma,
    "sales-channel.write.verification-dispatch",
    (tx) =>
      transitionOwnedSalesChannelWriteAttempt(tx, {
        requestId,
        attemptId: verifyAttemptId,
        expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
        expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
        expectedRequestDispatched: false,
        requestData: { updated_at: verificationDispatchedAt },
        attemptData: { request_dispatched: 1 },
      })
  );

  try {
    if (credentialContext) {
      setOperationTraceField("qhkey.credential_context_reused", true);
    }
    const targetedVerification = await traceOperationSpan(
      "TARGETED_WRITE_VERIFICATION",
      () =>
        (dependencies.verifyWrite ?? verifyAndRefreshCoupangWriteRequest)(
          {
            requestId,
            triggerType: "IMMEDIATE_VERIFY",
          },
          credentialContext ? { credentialContext } : undefined
        )
    );
    verification = targetedVerification as CoupangWriteVerificationResult;
    verificationEndpointPath = targetedVerification.endpointPath;
  } catch (error) {
    const completedAt = databaseNow();

    await runMeasuredTransaction(
      prisma,
      "sales-channel.write.verification-failed",
      async (tx) => {
        await markPendingSalesChannelWriteTargets({
          tx,
          requestId,
          externalStatus: "UNKNOWN",
          resultCode: errorCode(error, "EXTERNAL_VERIFICATION_ERROR"),
          receivedAt: completedAt,
        });
        return transitionOwnedSalesChannelWriteAttempt(tx, {
          requestId,
          attemptId: verifyAttemptId,
          expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
          expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
          expectedRequestDispatched: true,
          attemptData: completedAttemptData({
            status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
            completedAt,
            errorCode: errorCode(error, "EXTERNAL_VERIFICATION_ERROR"),
            errorMessage: errorMessage(error),
            requestDispatched: true,
            externalAppliedUnknown: true,
          }),
          requestData: {
            request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
            failure_stage:
              SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification,
            error_code: errorCode(error, "EXTERNAL_VERIFICATION_ERROR"),
            error_message: errorMessage(error),
            review_required_at: completedAt,
            updated_at: completedAt,
          },
        });
      }
    );
    throw new SalesChannelWriteReviewRequiredError(
      requestId,
      "쓰기 응답은 성공했지만 외부 채널의 실제 상태를 확인하지 못했습니다. 처리 확인 메뉴에서 확인하세요."
    );
  }

  if (!verification) {
    throw new Error("Ambiguous Coupang write verification returned no result.");
  }
  const confirmedVerification = verification;

  const verificationCompletedAt = databaseNow();

  let verificationSettlement: SalesChannelWriteSettlement;
  let committedVerificationSettlementWithoutLocalFinalization:
    | CommittedSettlementWithoutLocalFinalization
    | null = null;
  try {
    verificationSettlement = await runMeasuredTransaction(
      prisma,
      "sales-channel.write.verification-settlement",
      async (tx) => {
      await assertOwnedSalesChannelWriteAttempt(tx, {
        requestId,
        attemptId: verifyAttemptId,
        expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
        expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
        expectedRequestDispatched: true,
      });
      const targetSettlement = await settleSalesChannelWriteVerificationGroups({
        tx,
        requestId,
        expectedExternalStatuses: ["PENDING"],
        groupResults: confirmedVerification.targetGroups,
        receivedAt: verificationCompletedAt,
      });

      if (targetSettlement.targetIds.length === 0) {
        const attemptStatus =
          targetSettlement.requestStatus ===
          SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
            ? SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous
            : SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded;
        const externalAppliedUnknown =
          targetSettlement.requestStatus ===
          SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired;
        await transitionOwnedSalesChannelWriteAttempt(tx, {
          requestId,
          attemptId: verifyAttemptId,
          expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
          expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
          expectedRequestDispatched: true,
          attemptData: completedAttemptData({
            status: attemptStatus,
            completedAt: verificationCompletedAt,
            externalResponseCode: confirmedVerification.code,
            requestDispatched: true,
            responseReceived: true,
            externalAppliedUnknown,
            endpointPath: verificationEndpointPath,
          }),
          requestData: {
            request_status: targetSettlement.requestStatus,
            failure_stage:
              SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification,
            error_code: confirmedVerification.code,
            error_message: confirmedVerification.message,
            review_required_at:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? verificationCompletedAt
                : null,
            updated_at: verificationCompletedAt,
          },
        });
        const result = {
          finalizeAttemptId: undefined,
          targetIds: [] as number[],
          requestStatus: targetSettlement.requestStatus,
        };
        committedVerificationSettlementWithoutLocalFinalization = {
          result,
          expectedAttempt: {
            requestId,
            attemptId: verifyAttemptId,
            attemptNo: verifyAttemptNo,
            attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
            attemptStatus,
            triggerType: verificationAttemptTrigger,
            completedAt: verificationCompletedAt,
            requestDispatched: true,
            responseReceived: true,
            externalAppliedUnknown,
          },
        };
        return result;
      }

      const finalizeAttempt = await transferOwnedSalesChannelWriteAttempt(tx, {
        requestId,
        attemptId: verifyAttemptId,
        expectedRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
        expectedAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
        expectedRequestDispatched: true,
        nextRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
        currentAttemptData: completedAttemptData({
          status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
          completedAt: verificationCompletedAt,
          externalResponseCode:
            confirmedVerification.code ?? confirmedVerification.outcome,
          requestDispatched: true,
          responseReceived: true,
          endpointPath: verificationEndpointPath,
        }),
        requestData: {
          request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
          failure_stage:
            targetSettlement.requestStatus ===
            SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
              ? SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification
              : null,
          error_code:
            targetSettlement.requestStatus ===
            SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
              ? confirmedVerification.code
              : null,
          error_message:
            targetSettlement.requestStatus ===
            SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
              ? confirmedVerification.message
              : null,
          review_required_at:
            targetSettlement.requestStatus ===
            SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
              ? verificationCompletedAt
              : null,
          updated_at: verificationCompletedAt,
        },
        nextAttempt: {
          attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
          triggerType: "AFTER_EXTERNAL_VERIFICATION",
          startedAt: verificationCompletedAt,
        },
        bindNextAsActiveReviewAttempt: true,
      });
      return {
        finalizeAttemptId:
          finalizeAttempt.sales_channel_write_request_attempt_id,
        finalizeAttemptNo: finalizeAttempt.attempt_no,
        targetIds: targetSettlement.targetIds,
        requestStatus: targetSettlement.requestStatus,
      };
      }
    );
  } catch (error) {
    const recovered = committedVerificationSettlementWithoutLocalFinalization
      ? await recoverCommittedSettlementWithoutLocalFinalization(
          committedVerificationSettlementWithoutLocalFinalization
        )
      : await recoverCommittedLocalFinalizationHandoff({
          requestId,
          currentAttemptId: verifyAttemptId,
          currentAttemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
          nextTriggerType: "AFTER_EXTERNAL_VERIFICATION",
        });
    if (!recovered) throw error;
    verificationSettlement = recovered;
  }
  finalizeAttemptId = verificationSettlement.finalizeAttemptId;
  finalizeAttemptNo = verificationSettlement.finalizeAttemptNo;
  if (finalizeAttemptId !== undefined) {
    finalizationTriggerType = "AFTER_EXTERNAL_VERIFICATION";
  }
  finalizationTargetIds = verificationSettlement.targetIds;
  if (
    verificationSettlement.requestStatus ===
    SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
  ) {
    unresolvedReviewAfterFinalization = {
      failureStage: SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification,
      errorCode:
        confirmedVerification.code ?? "EXTERNAL_VERIFICATION_UNKNOWN",
      errorMessage:
        "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다.",
    };
  }
  confirmation = {
    source: "READ_AFTER_AMBIGUOUS_WRITE",
    verification: confirmedVerification,
  };
  setOperationTraceField("write.confirmation_source", confirmation.source);

  if (finalizeAttemptId === undefined) {
    if (
      verificationSettlement.requestStatus ===
      SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied
    ) {
      throw publicConflict(
        confirmedVerification.code ?? "EXTERNAL_WRITE_NOT_APPLIED",
        "외부 판매 채널에 요청 결과가 반영되지 않았습니다. 처리 확인 메뉴에서 상태를 확인하세요."
      );
    }
    throw new SalesChannelWriteReviewRequiredError(
      requestId,
      "외부 판매 채널의 실제 처리 결과를 확정하지 못했습니다. 처리 확인 메뉴에서 확인하세요."
    );
  }
  }

  if (
    finalizeAttemptId === undefined ||
    finalizeAttemptNo === undefined ||
    finalizationTriggerType === null
  ) {
    throw new Error("Sales channel write reached no local finalization path.");
  }

  const finalizedAt = databaseNow();
  let committedFinalizationRequestStatus: SalesChannelWriteRequestStatus | null =
    null;
  try {
    const finalizedRequestStatus = await traceOperationSpan("LOCAL_FINALIZE", () =>
      runMeasuredTransaction(prisma, "sales-channel.write.finalize", async (tx) => {
        await assertSalesChannelWriteReviewOwnership(tx, {
          requestId,
          attemptId: finalizeAttemptId,
          allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
        });
        await lifecycle.finalize({
          tx,
          requestId,
          command,
          targetIds: finalizationTargetIds,
          finalizedAt,
        });
        await markSalesChannelWriteTargetsLocalStatus({
          tx,
          requestId,
          targetIds: finalizationTargetIds,
          status: "SUCCEEDED",
          finalizedAt,
        });
        const targetSettlement = await loadSalesChannelWriteTargetSettlement(
          tx,
          requestId
        );
        await completeSalesChannelWriteReviewOperation(tx, {
          requestId,
          attemptId: finalizeAttemptId,
          allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
          requestData: {
            request_status: targetSettlement.requestStatus,
            failure_stage:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? unresolvedReviewAfterFinalization?.failureStage ??
                  SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification
                : null,
            error_code:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? unresolvedReviewAfterFinalization?.errorCode ??
                  "EXTERNAL_VERIFICATION_UNKNOWN"
                : null,
            error_message:
              targetSettlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? unresolvedReviewAfterFinalization?.errorMessage ??
                  "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다."
                : null,
            completed_at:
              targetSettlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.completed ||
              targetSettlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.partiallyCompleted
                ? finalizedAt
                : null,
            local_finalized_at: finalizedAt,
            updated_at: finalizedAt,
          },
          attemptData: completedAttemptData({
            status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
            completedAt: finalizedAt,
          }),
        });
        committedFinalizationRequestStatus = targetSettlement.requestStatus;
        return targetSettlement.requestStatus;
      })
    );

    return {
      requestId,
      status: finalizedRequestStatus,
      response: writeResponse,
      verification,
      confirmation,
      targetIds: finalizationTargetIds,
    };
  } catch (error) {
    const [persisted, persistedAttempt] = await Promise.all([
      prisma.sales_channel_write_requests.findUnique({
        where: { sales_channel_write_request_id: requestId },
        select: {
          request_status: true,
          active_review_attempt_id: true,
          targets: {
            orderBy: { target_position: "asc" },
            select: {
              sales_channel_write_request_target_id: true,
              external_result_status: true,
              local_finalization_status: true,
              local_finalized_at: true,
            },
          },
        },
      }),
      prisma.sales_channel_write_request_attempts.findUnique({
        where: { sales_channel_write_request_attempt_id: finalizeAttemptId },
      }),
    ]);

    if (
      persisted &&
      persistedAttempt &&
      committedFinalizationRequestStatus !== null &&
      persisted.active_review_attempt_id !== finalizeAttemptId &&
      finalizationTriggerType !== null
    ) {
      const recoveredTargetIds = committedFinalizationTargetIds({
        expectedAttempt: {
          requestId,
          attemptId: finalizeAttemptId,
          attemptNo: finalizeAttemptNo,
          attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
          attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
          triggerType: finalizationTriggerType,
          completedAt: finalizedAt,
          requestDispatched: false,
          responseReceived: false,
          externalAppliedUnknown: false,
        },
        requestStatus: persisted.request_status,
        expectedTargetIds: finalizationTargetIds,
        finalizedAt,
        attempt: {
          id: persistedAttempt.sales_channel_write_request_attempt_id,
          requestId: persistedAttempt.sales_channel_write_request_id,
          attemptNo: persistedAttempt.attempt_no,
          type: persistedAttempt.attempt_type,
          status: persistedAttempt.attempt_status,
          triggerType: persistedAttempt.trigger_type,
          completedAt: persistedAttempt.completed_at,
          requestDispatched: persistedAttempt.request_dispatched,
          responseReceived: persistedAttempt.response_received,
          externalAppliedUnknown:
            persistedAttempt.external_applied_unknown,
        },
        targets: persisted.targets.map((target) => ({
          id: target.sales_channel_write_request_target_id,
          externalResultStatus: target.external_result_status,
          localFinalizationStatus: target.local_finalization_status,
          localFinalizedAt: target.local_finalized_at,
        })),
      });
      return {
        requestId,
        status: committedFinalizationRequestStatus,
        response: writeResponse,
        verification,
        confirmation,
        targetIds: recoveredTargetIds,
      };
    }

    if (
      isSalesChannelWriteExecutionOwnershipLost(error) ||
      isSalesChannelWriteReviewOwnershipLost(error)
    ) {
      throw error;
    }

    const completedAt = databaseNow();
    await runMeasuredTransaction(
      prisma,
      "sales-channel.write.finalize-failed",
      async (tx) => {
        await markSalesChannelWriteTargetsLocalStatus({
          tx,
          requestId,
          targetIds: finalizationTargetIds,
          status: "FAILED",
        });
        return completeSalesChannelWriteReviewOperation(tx, {
          requestId,
          attemptId: finalizeAttemptId,
          allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
          attemptData: completedAttemptData({
            status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed,
            completedAt,
            errorCode: errorCode(error, "LOCAL_FINALIZATION_ERROR"),
            errorMessage: errorMessage(error),
          }),
          requestData: {
            request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
            failure_stage: SALES_CHANNEL_WRITE_FAILURE_STAGE.localFinalization,
            error_code: errorCode(error, "LOCAL_FINALIZATION_ERROR"),
            error_message: errorMessage(error),
            review_required_at: completedAt,
            updated_at: completedAt,
          },
        });
      }
    );
    throw new SalesChannelWriteReviewRequiredError(
      requestId,
      "외부 채널 반영은 확인됐지만 QuickHack 내부 확정에 실패했습니다. 처리 확인 메뉴에서 내부 확정을 다시 실행하세요."
    );
  }
}

export async function resumeSalesChannelWriteControl(input: {
  controlId: number;
  userId: number;
  expectedRevision: number;
}) {
  const timestamp = databaseNow();

  const resumed = await prisma.sales_channel_write_controls.updateMany({
    where: {
      sales_channel_write_control_id: input.controlId,
      revision: input.expectedRevision,
      is_paused: 1,
    },
    data: {
      revision: { increment: 1 },
      is_paused: 0,
      consecutive_failure_count: 0,
      pause_reason: null,
      resumed_at: timestamp,
      resumed_by_user_id: input.userId,
      updated_at: timestamp,
    },
  });
  if (resumed.count !== 1) {
    throw publicConflict(
      "SALES_CHANNEL_WRITE_CONTROL_STALE",
      "쓰기 차단 상태가 변경되었습니다. 최신 상태를 새로고침한 뒤 다시 시도하세요."
    );
  }
  return prisma.sales_channel_write_controls.findUniqueOrThrow({
    where: { sales_channel_write_control_id: input.controlId },
  });
}
