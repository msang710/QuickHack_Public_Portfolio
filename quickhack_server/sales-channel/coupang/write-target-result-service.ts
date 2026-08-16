import {
  COUPANG_WRITE_RESPONSE_OUTCOME,
  type CoupangWriteResponseAssessment,
} from "@/quickhack_server/sales-channel/coupang/write-response-contract";
import {
  SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS,
  SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS,
  type SalesChannelWriteCommand,
} from "@/quickhack_shared/sales-channel/write-requests";

type PersistedTargetIdentity = {
  sales_channel_write_request_target_id: number;
  target_external_id: string | null;
  external_shipment_id: string | null;
};

export type ResolvedCoupangWriteTargetResult = {
  targetId: number;
  externalResultStatus: string;
  externalResultCode: string | null;
  retryRequired: number | null;
  localFinalizationStatus: string;
};

function targetExternalId(target: PersistedTargetIdentity) {
  return String(
    target.external_shipment_id ?? target.target_external_id ?? ""
  ).trim();
}

function uniformResult(
  targets: readonly PersistedTargetIdentity[],
  status: "SUCCEEDED" | "NOT_APPLIED" | "UNKNOWN",
  code: string | null
): ResolvedCoupangWriteTargetResult[] {
  return targets.map((target) => ({
    targetId: target.sales_channel_write_request_target_id,
    externalResultStatus: status,
    externalResultCode: code,
    retryRequired: null,
    localFinalizationStatus:
      status === SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
        ? SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired
        : SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending,
  }));
}

function resolveOrderItemResults(
  targets: readonly PersistedTargetIdentity[],
  assessment: CoupangWriteResponseAssessment
): ResolvedCoupangWriteTargetResult[] | null {
  const byExternalId = new Map<
    string,
    (typeof assessment.targetResults)[number]
  >();
  for (const result of assessment.targetResults) {
    if (byExternalId.has(result.externalTargetId)) return null;
    byExternalId.set(result.externalTargetId, result);
  }
  if (
    byExternalId.size !== targets.length ||
    targets.some(
      (target) =>
        !targetExternalId(target) ||
        !byExternalId.has(targetExternalId(target))
    )
  ) {
    return null;
  }

  return targets.map((target) => {
    const result = byExternalId.get(targetExternalId(target))!;
    return {
      targetId: target.sales_channel_write_request_target_id,
      externalResultStatus: result.succeeded
        ? SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded
        : SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied,
      externalResultCode: result.resultCode,
      retryRequired:
        result.retryRequired == null ? null : result.retryRequired ? 1 : 0,
      localFinalizationStatus: result.succeeded
        ? SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending
        : SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired,
    };
  });
}

export function resolveCoupangWriteTargetResults(input: {
  command: SalesChannelWriteCommand;
  assessment: CoupangWriteResponseAssessment;
  targets: readonly PersistedTargetIdentity[];
}): ResolvedCoupangWriteTargetResult[] {
  const { command, assessment, targets } = input;

  if (assessment.outcome === COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess) {
    return uniformResult(
      targets,
      SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded,
      assessment.externalResponseCode
    );
  }
  if (
    assessment.outcome === COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure
  ) {
    if (command.requestType === "ORDER_STATUS_INSTRUCT") {
      const resolved = resolveOrderItemResults(targets, assessment);
      if (resolved) return resolved;
    }
    return uniformResult(
      targets,
      SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied,
      assessment.externalResponseCode
    );
  }
  if (
    assessment.outcome !== COUPANG_WRITE_RESPONSE_OUTCOME.partial ||
    command.requestType !== "ORDER_STATUS_INSTRUCT"
  ) {
    return uniformResult(
      targets,
      SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.unknown,
      assessment.errorCode
    );
  }
  return (
    resolveOrderItemResults(targets, assessment) ??
    uniformResult(
      targets,
      SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.unknown,
      assessment.errorCode
    )
  );
}
