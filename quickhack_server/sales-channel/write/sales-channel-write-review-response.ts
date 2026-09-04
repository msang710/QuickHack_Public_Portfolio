import type { listSalesChannelWriteRequests } from "@/quickhack_server/sales-channel/write/sales-channel-write-review-service";
import type {
  SalesChannelWriteRequestStatus,
  SalesChannelWriteRequestType,
} from "@/quickhack_shared/sales-channel/write-requests";
import type {
  SalesChannelWriteControlDto,
  SalesChannelWriteReviewItemDto,
  SalesChannelWriteReviewResponseDto,
} from "@/quickhack_shared/sales-channel/sync-checks";
import { isSalesChannelWriteReviewOperationActive } from "@/quickhack_server/sales-channel/write/sales-channel-write-review-ownership";
import { groupSalesChannelWriteTargets } from "@/quickhack_server/sales-channel/write/sales-channel-write-target-group";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

type WriteReviewResult = Awaited<
  ReturnType<typeof listSalesChannelWriteRequests>
>;
export type SalesChannelWriteReviewRow = WriteReviewResult["rows"][number];
export type SalesChannelWriteControlRow =
  WriteReviewResult["controls"][number];

export function presentSalesChannelWriteRequest(
  row: SalesChannelWriteReviewRow
): SalesChannelWriteReviewItemDto {
  const targetGroupByTargetId = new Map(
    groupSalesChannelWriteTargets({
      requestType: row.request_type,
      requestTargetExternalId: row.target_external_id,
      targets: row.targets,
    }).flatMap(
      (group) =>
        group.targetIds.map((targetId) => [
          targetId,
          {
            groupKey: group.groupKey,
            representativeTargetId: group.representativeTargetId,
            targetCount: group.targetIds.length,
          },
        ] as const)
    )
  );
  const activeAttempt =
    row.active_review_attempt_id === null
      ? null
      : row.attempts.find(
          (attempt) =>
            attempt.sales_channel_write_request_attempt_id ===
            row.active_review_attempt_id
        ) ?? null;
  const reviewOperationInProgress = Boolean(
    activeAttempt &&
      isSalesChannelWriteReviewOperationActive(
        row.active_review_heartbeat_at
      )
  );

  return {
    id: row.sales_channel_write_request_id,
    channel: row.channel,
    requestType: row.request_type as SalesChannelWriteRequestType,
    requestStatus: row.request_status as SalesChannelWriteRequestStatus,
    reviewOperationInProgress,
    activeReviewOperation: reviewOperationInProgress
      ? activeAttempt?.attempt_type ?? ""
      : "",
    activeReviewStartedAt: reviewOperationInProgress
      ? apiDateTime(activeAttempt?.started_at) ?? ""
      : "",
    failureStage: row.failure_stage ?? "",
    externalOrderId: row.external_order_id ?? "",
    targetType: row.target_type ?? "",
    targetExternalId: row.target_external_id ?? "",
    sourceMenuKey: row.source_menu_key ?? "",
    sourceEntityType: row.source_entity_type ?? "",
    sourceEntityId: row.source_entity_id ?? "",
    expectedBeforeStatus: row.expected_before_status ?? "",
    requestedAfterStatus: row.requested_after_status ?? "",
    errorCode: row.error_code ?? "",
    errorMessage: row.error_message ?? "",
    requestedAt: requiredApiDateTime(row.requested_at),
    completedAt: apiDateTime(row.completed_at) ?? "",
    reviewRequiredAt: apiDateTime(row.review_required_at) ?? "",
    manualVerificationStatus: row.manual_verification_status ?? "",
    manualVerificationNote: row.manual_verification_note ?? "",
    requestedBy:
      row.requested_by?.employee_profiles?.display_name ??
      row.requested_by?.username ??
      "",
    manualVerifiedBy:
      row.manual_verified_by?.employee_profiles?.display_name ??
      row.manual_verified_by?.username ??
      "",
    targets: row.targets.map((target) => ({
      id: target.sales_channel_write_request_target_id,
      resolutionGroupKey:
        targetGroupByTargetId.get(
          target.sales_channel_write_request_target_id
        )?.groupKey ?? "",
      resolutionGroupRepresentativeTargetId:
        targetGroupByTargetId.get(
          target.sales_channel_write_request_target_id
        )?.representativeTargetId ??
        target.sales_channel_write_request_target_id,
      resolutionGroupTargetCount:
        targetGroupByTargetId.get(
          target.sales_channel_write_request_target_id
        )?.targetCount ?? 1,
      targetPosition: target.target_position,
      targetType: target.target_type,
      targetExternalId: target.target_external_id ?? "",
      allocationId: target.allocation_id,
      pgNo: target.pg_no ?? "",
      externalOrderId: target.external_order_id ?? "",
      externalShipmentId: target.external_shipment_id ?? "",
      externalVendorItemId: target.external_vendor_item_id ?? "",
      quantity: target.quantity,
      inventoryVerificationStateId:
        target.inventory_verification_state_id,
      inventoryDesiredVersionSnapshot:
        target.inventory_desired_version_snapshot,
      inventoryMismatchSinceSnapshot:
        apiDateTime(target.inventory_mismatch_since_snapshot) ?? "",
      inventoryProjectionBasisHashSnapshot:
        target.inventory_projection_basis_hash_snapshot ?? "",
      inventoryLedgerQuantitySnapshot:
        target.inventory_ledger_quantity_snapshot,
      inventoryPendingOrderQuantitySnapshot:
        target.inventory_pending_order_quantity_snapshot,
      inventoryExpectedChannelQuantitySnapshot:
        target.inventory_expected_channel_quantity_snapshot,
      inventoryObservedChannelQuantitySnapshot:
        target.inventory_observed_channel_quantity_snapshot,
      inspectionResult: target.inspection_result ?? "",
      externalResultStatus: target.external_result_status,
      externalResultCode: target.external_result_code ?? "",
      externalResultMessage: target.external_result_message ?? "",
      retryRequired:
        target.retry_required === null ? null : target.retry_required === 1,
      resultReceivedAt: apiDateTime(target.result_received_at) ?? "",
      localFinalizationStatus: target.local_finalization_status,
      localFinalizedAt: apiDateTime(target.local_finalized_at) ?? "",
    })),
    attempts: row.attempts.map((attempt) => ({
      id: attempt.sales_channel_write_request_attempt_id,
      attemptNo: attempt.attempt_no,
      attemptType: attempt.attempt_type,
      attemptStatus: attempt.attempt_status,
      triggerType: attempt.trigger_type,
      httpStatusCode: attempt.http_status_code,
      externalResponseCode: attempt.external_response_code ?? "",
      errorCode: attempt.error_code ?? "",
      errorMessage: attempt.error_message ?? "",
      externalAppliedUnknown: attempt.external_applied_unknown === 1,
      startedAt: requiredApiDateTime(attempt.started_at),
      completedAt: apiDateTime(attempt.completed_at) ?? "",
    })),
  };
}

export function presentSalesChannelWriteControl(
  control: SalesChannelWriteControlRow
): SalesChannelWriteControlDto {
  return {
    id: control.sales_channel_write_control_id,
    revision: control.revision,
    channel: control.channel,
    endpointKey: control.endpoint_key,
    requestType: control.request_type,
    isPaused: control.is_paused === 1,
    consecutiveFailureCount: control.consecutive_failure_count,
    pauseReason: control.pause_reason ?? "",
    lastFailureMessage: control.last_failure_message ?? "",
    lastFailureAt: apiDateTime(control.last_failure_at) ?? "",
    pausedAt: apiDateTime(control.paused_at) ?? "",
  };
}

export function presentSalesChannelWriteReviewResponse(
  result: WriteReviewResult
): SalesChannelWriteReviewResponseDto {
  return {
    ok: true,
    unresolvedCount: result.unresolvedCount,
    controls: result.controls.map(presentSalesChannelWriteControl),
    items: result.rows.map(presentSalesChannelWriteRequest),
  };
}
