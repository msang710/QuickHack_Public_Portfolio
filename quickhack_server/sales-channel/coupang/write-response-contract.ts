import type { SalesChannelWriteCommand } from "@/quickhack_shared/sales-channel/write-requests";
import { safeCoupangExternalResponseCode } from "@/quickhack_server/sales-channel/coupang/external-response-metadata";

export const COUPANG_WRITE_RESPONSE_OUTCOME = {
  fullSuccess: "FULL_SUCCESS",
  partial: "PARTIAL",
  explicitFailure: "EXPLICIT_FAILURE",
  unknownResponse: "UNKNOWN_RESPONSE",
} as const;

export type CoupangWriteResponseOutcome =
  (typeof COUPANG_WRITE_RESPONSE_OUTCOME)[keyof typeof COUPANG_WRITE_RESPONSE_OUTCOME];

export const COUPANG_WRITE_RESPONSE_ERROR_CODE = {
  partialSuccess: "COUPANG_WRITE_PARTIAL_SUCCESS",
  explicitFailure: "COUPANG_WRITE_EXPLICIT_FAILURE",
  malformed: "COUPANG_WRITE_RESPONSE_MALFORMED",
  targetMismatch: "COUPANG_WRITE_RESPONSE_TARGET_MISMATCH",
  summaryConflict: "COUPANG_WRITE_RESPONSE_SUMMARY_CONFLICT",
} as const;

export type CoupangWriteResponseErrorCode =
  (typeof COUPANG_WRITE_RESPONSE_ERROR_CODE)[keyof typeof COUPANG_WRITE_RESPONSE_ERROR_CODE];

export type CoupangWriteFailedTarget = {
  externalTargetId: string | null;
  resultCode: string | null;
  retryRequired: boolean | null;
};

export type CoupangWriteTargetResult = {
  externalTargetId: string;
  succeeded: boolean;
  resultCode: string;
  retryRequired: boolean | null;
};

export type CoupangWriteResponseAssessment = {
  outcome: CoupangWriteResponseOutcome;
  externalResponseCode: string | null;
  targetCount: number;
  succeededTargetCount: number | null;
  failedTargetCount: number | null;
  failedTargets: CoupangWriteFailedTarget[];
  targetResults: CoupangWriteTargetResult[];
  errorCode: CoupangWriteResponseErrorCode | null;
  summary: string;
};

const MAX_SUMMARY_LENGTH = 2_000;
const MAX_SUMMARY_FAILED_TARGETS = 20;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedCode(value: unknown): string | null {
  return safeCoupangExternalResponseCode(value)?.toUpperCase() ?? null;
}

function externalTargetId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : null;
  }

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requestTargetIds(command: SalesChannelWriteCommand): string[] {
  switch (command.requestType) {
    case "ORDER_STATUS_INSTRUCT":
      return command.shipmentBoxIds.map((value) => String(value).trim());
    case "COUPANG_INVOICE_UPLOAD":
    case "COUPANG_INVOICE_UPDATE":
      return command.invoiceItems.map((item) =>
        String(item.shipmentBoxId).trim()
      );
    case "RETURN_STOPPED_SHIPMENT":
    case "RETURN_RECEIVE_CONFIRMATION":
    case "RETURN_APPROVAL":
      return [String(command.receiptId).trim()];
    case "COUPANG_INVENTORY_QUANTITY_UPDATE":
      return [String(command.vendorItemId).trim()];
  }
}

function targetCounts(targetIds: string[]) {
  const counts = new Map<string, number>();

  for (const targetId of targetIds) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }

  return counts;
}

function sameTargetMultiset(expected: string[], actual: string[]) {
  if (expected.length !== actual.length) {
    return false;
  }

  const expectedCounts = targetCounts(expected);
  const actualCounts = targetCounts(actual);

  if (expectedCounts.size !== actualCounts.size) {
    return false;
  }

  for (const [targetId, count] of expectedCounts) {
    if (actualCounts.get(targetId) !== count) {
      return false;
    }
  }

  return true;
}

function failedTargetSummary(failedTargets: CoupangWriteFailedTarget[]) {
  if (failedTargets.length === 0) {
    return "";
  }

  const shown = failedTargets
    .slice(0, MAX_SUMMARY_FAILED_TARGETS)
    .map(
      (target) =>
        `${target.externalTargetId ?? "UNKNOWN_TARGET"}:${
          target.resultCode ?? "UNKNOWN_RESULT"
        }`
    )
    .join(", ");
  const omitted = failedTargets.length - MAX_SUMMARY_FAILED_TARGETS;

  return omitted > 0 ? `${shown}, and ${omitted} more` : shown;
}

function assessment(input: {
  outcome: CoupangWriteResponseOutcome;
  externalResponseCode: string | null;
  targetCount: number;
  succeededTargetCount: number | null;
  failedTargetCount: number | null;
  failedTargets?: CoupangWriteFailedTarget[];
  targetResults?: CoupangWriteTargetResult[];
  errorCode: CoupangWriteResponseErrorCode | null;
  reason: string;
}): CoupangWriteResponseAssessment {
  const failedTargets = input.failedTargets ?? [];
  const failedSummary = failedTargetSummary(failedTargets);
  const counts =
    input.succeededTargetCount === null || input.failedTargetCount === null
      ? `${input.targetCount} target(s)`
      : `${input.succeededTargetCount}/${input.targetCount} succeeded, ${input.failedTargetCount} failed`;
  const summary = [
    `Coupang write response ${input.outcome}: ${input.reason} (${counts}).`,
    failedSummary ? `Failed targets: ${failedSummary}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_SUMMARY_LENGTH);

  return {
    outcome: input.outcome,
    externalResponseCode: input.externalResponseCode,
    targetCount: input.targetCount,
    succeededTargetCount: input.succeededTargetCount,
    failedTargetCount: input.failedTargetCount,
    failedTargets,
    targetResults: input.targetResults ?? [],
    errorCode: input.errorCode,
    summary,
  };
}

function batchAssessment(
  command: SalesChannelWriteCommand,
  payload: unknown
): CoupangWriteResponseAssessment {
  const expectedTargetIds = requestTargetIds(command);
  const targetCount = expectedTargetIds.length;
  const root = objectRecord(payload);
  const topLevelCode = normalizedCode(root?.code);

  if (expectedTargetIds.some((targetId) => !targetId) || targetCount === 0) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: topLevelCode,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed,
      reason: "the write command has no valid response targets",
    });
  }

  if (!root || !topLevelCode) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: topLevelCode,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed,
      reason: "the top-level response code is missing or malformed",
    });
  }

  if (topLevelCode === "SUCCESS") {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: topLevelCode,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed,
      reason: "a success code from a different endpoint contract was returned",
    });
  }

  if (topLevelCode !== "200") {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure,
      externalResponseCode: topLevelCode,
      targetCount,
      succeededTargetCount: 0,
      failedTargetCount: targetCount,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.explicitFailure,
      reason: "the top-level response explicitly rejected the write",
    });
  }

  const data = objectRecord(root.data);
  const responseCode = normalizedCode(data?.responseCode);
  const responseList = data?.responseList;

  if (
    !data ||
    !responseCode ||
    !["0", "1", "99"].includes(responseCode) ||
    !Array.isArray(responseList)
  ) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: responseCode ?? topLevelCode,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed,
      reason: "the batch response summary or response list is malformed",
    });
  }

  const parsedItems: Array<{
    targetId: string;
    succeeded: boolean;
    resultCode: string;
    retryRequired: boolean | null;
    failedTarget: CoupangWriteFailedTarget | null;
  }> = [];

  for (const value of responseList) {
    const item = objectRecord(value);
    const targetId = externalTargetId(item?.shipmentBoxId);
    const resultCode = normalizedCode(item?.resultCode);
    const succeeded = item?.succeed;

    if (
      !item ||
      !targetId ||
      typeof succeeded !== "boolean" ||
      !resultCode ||
      (succeeded && resultCode !== "OK") ||
      (!succeeded && resultCode === "OK")
    ) {
      return assessment({
        outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
        externalResponseCode: responseCode,
        targetCount,
        succeededTargetCount: null,
        failedTargetCount: null,
        errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.summaryConflict,
        reason: "a batch result item is missing required fields or contradicts itself",
      });
    }

    parsedItems.push({
      targetId,
      succeeded,
      resultCode,
      retryRequired:
        typeof item.retryRequired === "boolean" ? item.retryRequired : null,
      failedTarget: succeeded
        ? null
        : {
            externalTargetId: targetId,
            resultCode,
            retryRequired:
              typeof item.retryRequired === "boolean"
                ? item.retryRequired
                : null,
          },
    });
  }

  const actualTargetIds = parsedItems.map((item) => item.targetId);

  if (!sameTargetMultiset(expectedTargetIds, actualTargetIds)) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: responseCode,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.targetMismatch,
      reason: "the response targets do not exactly match the requested targets",
    });
  }

  const succeededTargetCount = parsedItems.filter(
    (item) => item.succeeded
  ).length;
  const failedTargets = parsedItems.flatMap((item) =>
    item.failedTarget ? [item.failedTarget] : []
  );
  const failedTargetCount = failedTargets.length;

  if (responseCode === "0" && succeededTargetCount === targetCount) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess,
      externalResponseCode: responseCode,
      targetCount,
      succeededTargetCount,
      failedTargetCount,
      targetResults: parsedItems.map((item) => ({
        externalTargetId: item.targetId,
        succeeded: item.succeeded,
        resultCode: item.resultCode,
        retryRequired: item.retryRequired,
      })),
      errorCode: null,
      reason: "every requested target succeeded",
    });
  }

  if (
    responseCode === "1" &&
    succeededTargetCount > 0 &&
    failedTargetCount > 0
  ) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.partial,
      externalResponseCode: responseCode,
      targetCount,
      succeededTargetCount,
      failedTargetCount,
      failedTargets,
      targetResults: parsedItems.map((item) => ({
        externalTargetId: item.targetId,
        succeeded: item.succeeded,
        resultCode: item.resultCode,
        retryRequired: item.retryRequired,
      })),
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.partialSuccess,
      reason: "the provider applied only part of the batch",
    });
  }

  if (responseCode === "99" && failedTargetCount === targetCount) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure,
      externalResponseCode: responseCode,
      targetCount,
      succeededTargetCount,
      failedTargetCount,
      failedTargets,
      targetResults: parsedItems.map((item) => ({
        externalTargetId: item.targetId,
        succeeded: item.succeeded,
        resultCode: item.resultCode,
        retryRequired: item.retryRequired,
      })),
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.explicitFailure,
      reason: "the provider explicitly rejected every target",
    });
  }

  return assessment({
    outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
    externalResponseCode: responseCode,
    targetCount,
    succeededTargetCount,
    failedTargetCount,
    failedTargets,
    targetResults: parsedItems.map((item) => ({
      externalTargetId: item.targetId,
      succeeded: item.succeeded,
      resultCode: item.resultCode,
      retryRequired: item.retryRequired,
    })),
    errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.summaryConflict,
    reason: "the batch summary contradicts the item-level results",
  });
}

function topLevelAssessment(
  command: SalesChannelWriteCommand,
  payload: unknown,
  successCode: "200" | "SUCCESS"
): CoupangWriteResponseAssessment {
  const targetCount = requestTargetIds(command).length;
  const root = objectRecord(payload);
  const code = normalizedCode(root?.code);

  if (!root || !code) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: code,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed,
      reason: "the top-level response code is missing or malformed",
    });
  }

  if (code === successCode) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess,
      externalResponseCode: code,
      targetCount,
      succeededTargetCount: targetCount,
      failedTargetCount: 0,
      errorCode: null,
      reason: "the endpoint-specific success code was returned",
    });
  }

  if (
    (successCode === "SUCCESS" && code === "200") ||
    (successCode === "200" && code === "SUCCESS")
  ) {
    return assessment({
      outcome: COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse,
      externalResponseCode: code,
      targetCount,
      succeededTargetCount: null,
      failedTargetCount: null,
      errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed,
      reason: "a success code from a different endpoint contract was returned",
    });
  }

  return assessment({
    outcome: COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure,
    externalResponseCode: code,
    targetCount,
    succeededTargetCount: 0,
    failedTargetCount: targetCount,
    errorCode: COUPANG_WRITE_RESPONSE_ERROR_CODE.explicitFailure,
    reason: "the endpoint-specific response code explicitly rejected the write",
  });
}

export function assessCoupangWriteResponse(
  command: SalesChannelWriteCommand,
  payload: unknown
): CoupangWriteResponseAssessment {
  switch (command.requestType) {
    case "ORDER_STATUS_INSTRUCT":
    case "COUPANG_INVOICE_UPLOAD":
    case "COUPANG_INVOICE_UPDATE":
      return batchAssessment(command, payload);
    case "RETURN_STOPPED_SHIPMENT":
    case "RETURN_RECEIVE_CONFIRMATION":
    case "RETURN_APPROVAL":
      return topLevelAssessment(command, payload, "200");
    case "COUPANG_INVENTORY_QUANTITY_UPDATE":
      return topLevelAssessment(command, payload, "SUCCESS");
  }
}

export class CoupangWriteResponseContractError extends Error {
  readonly code: CoupangWriteResponseErrorCode;
  readonly assessment: CoupangWriteResponseAssessment;
  readonly httpStatusCode: number;
  readonly externalResponseCode: string | null;

  constructor(input: {
    assessment: CoupangWriteResponseAssessment;
    httpStatusCode: number;
  }) {
    super(input.assessment.summary);
    this.name = "CoupangWriteResponseContractError";
    this.code =
      input.assessment.errorCode ??
      COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed;
    this.assessment = input.assessment;
    this.httpStatusCode = input.httpStatusCode;
    this.externalResponseCode = input.assessment.externalResponseCode;
  }
}
