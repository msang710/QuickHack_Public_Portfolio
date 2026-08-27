import type { Prisma } from "@/generated/prisma/client";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  appendDomainAuditEvent,
  defineDomainAuditEvent,
} from "@/quickhack_server/audit/domain-audit-service";
import {
  advanceSalesChannelProjectionRevision,
  SALES_CHANNEL_PROJECTION_CHANNEL,
} from "@/quickhack_server/sales-channel/projection-revision-service";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  lockInventoryQuantityBalanceKeys,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { groupSalesChannelWriteTargets } from "@/quickhack_server/sales-channel/write/sales-channel-write-target-group";
import { applyPreShipmentReturnToPackageGroups } from "@/quickhack_server/shipment/shipment-package-group-service";
import { restoreReturnSupplies } from "@/quickhack_server/supplies/outbound-supply-service";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  INSPECTION_RESULT,
  INSPECTION_SOURCE_TYPE,
  INSPECTION_TYPE,
  type InspectionResult,
} from "@/quickhack_shared/inspection/inspection-types";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  lockSalesAllocationRoots,
  markSalesRecordsReturnedForAllocations,
} from "@/quickhack_server/sales/sales-record-service";
import { lockDeviceAggregates } from "@/quickhack_server/inventory/device-aggregate-lock";

const ACTIVE_RETURN_ALLOCATION_STATUSES = [
  "ALLOCATED",
  "API_ACKED",
  "SHIPMENT_LIST_PRINTED",
] as const;

const RETURN_AUDIT_CONTRACT = defineDomainAuditEvent({
  eventType: "COUPANG_RETURN_WRITE_FINALIZED",
  allowedFieldPaths: [
    "receiptStatus",
    "releaseStatus",
    "writeRequestId",
    "sourceProjectionRevision",
    "selectedAllocationIds",
  ] as const,
});

function inventoryStatusForInspection(result: InspectionResult) {
  if (result === INSPECTION_RESULT.passed) {
    return INVENTORY_STATUS.sellable;
  }

  if (
    result === INSPECTION_RESULT.failed ||
    result === INSPECTION_RESULT.disposal
  ) {
    return INVENTORY_STATUS.defective;
  }

  return INVENTORY_STATUS.hold;
}

function actionForRequestType(requestType: string) {
  if (requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment) {
    return "stopShipment" as const;
  }

  if (
    requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.returnReceiveConfirmation
  ) {
    return "receiveConfirm" as const;
  }

  if (requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval) {
    return "approve" as const;
  }

  throw new Error("반품 내부 확정을 지원하지 않는 쓰기 요청입니다.");
}

async function projectConfirmedReturnStatus(input: {
  tx: Prisma.TransactionClient;
  action: "stopShipment" | "receiveConfirm" | "approve";
  returnRow: {
    coupang_return_raw_id: number;
    return_receipt_status: string | null;
    return_release_status: string | null;
    projection_revision: number;
    updated_at: Date;
  };
  expectedBeforeStatus: string | null;
  requestedAfterStatus: string | null;
  finalizedAt: Date;
}) {
  const expectedBeforeStatus = String(
    input.expectedBeforeStatus ?? ""
  ).trim();
  const requestedAfterStatus = String(
    input.requestedAfterStatus ?? ""
  ).trim();

  if (!expectedBeforeStatus || !requestedAfterStatus) {
    throw new Error(
      "The persisted Coupang return transition snapshot is invalid."
    );
  }

  if (input.action === "stopShipment") {
    const currentStatus = String(
      input.returnRow.return_release_status ?? ""
    ).trim();

    if (currentStatus === requestedAfterStatus) {
      return;
    }

    if (currentStatus !== expectedBeforeStatus) {
      throw new Error(
        `Coupang return release status changed from ${expectedBeforeStatus} to ${currentStatus || "UNKNOWN"} before local finalization.`
      );
    }

    const projectionRevision = await advanceSalesChannelProjectionRevision(
      input.tx,
      SALES_CHANNEL_PROJECTION_CHANNEL.coupang,
      input.finalizedAt
    );

    const updated = await input.tx.coupang_return_raw.updateMany({
      where: {
        coupang_return_raw_id: input.returnRow.coupang_return_raw_id,
        return_release_status: input.returnRow.return_release_status,
        projection_revision: input.returnRow.projection_revision,
        updated_at: input.returnRow.updated_at,
      },
      data: {
        return_release_status: requestedAfterStatus,
        projection_revision: projectionRevision,
        updated_at: input.finalizedAt,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        "The Coupang return release status changed during local finalization."
      );
    }
    return;
  }

  const currentStatus = String(
    input.returnRow.return_receipt_status ?? ""
  ).trim();

  if (currentStatus === requestedAfterStatus) {
    return;
  }

  if (currentStatus !== expectedBeforeStatus) {
    throw new Error(
      `Coupang return receipt status changed from ${expectedBeforeStatus} to ${currentStatus || "UNKNOWN"} before local finalization.`
    );
  }

  const projectionRevision = await advanceSalesChannelProjectionRevision(
    input.tx,
    SALES_CHANNEL_PROJECTION_CHANNEL.coupang,
    input.finalizedAt
  );

  const updated = await input.tx.coupang_return_raw.updateMany({
    where: {
      coupang_return_raw_id: input.returnRow.coupang_return_raw_id,
      return_receipt_status: input.returnRow.return_receipt_status,
      projection_revision: input.returnRow.projection_revision,
      updated_at: input.returnRow.updated_at,
    },
    data: {
      return_receipt_status: requestedAfterStatus,
      projection_revision: projectionRevision,
      updated_at: input.finalizedAt,
    },
  });

  if (updated.count !== 1) {
    throw new Error(
      "The Coupang return receipt status changed during local finalization."
    );
  }
}

export async function finalizePersistedCoupangReturnWrite(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targetIds: readonly number[];
  actorUserId: number | null;
  finalizedAt: Date;
}) {
  const request = await input.tx.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: input.requestId },
    include: {
      targets: {
        orderBy: { sales_channel_write_request_target_id: "asc" },
      },
    },
  });

  if (!request || request.channel !== "COUPANG") {
    throw new Error("쿠팡 쓰기 요청 이력을 찾을 수 없습니다.");
  }

  const action = actionForRequestType(request.request_type);
  const receiptId = String(request.target_external_id ?? "").trim();

  if (!receiptId) {
    throw new Error("반품 접수번호 스냅샷이 없습니다.");
  }

  const targetGroups = groupSalesChannelWriteTargets({
    requestType: request.request_type,
    requestTargetExternalId: request.target_external_id,
    targets: request.targets,
  });
  const targetGroup = targetGroups[0];
  const selectedTargetIds = new Set(input.targetIds);
  if (
    request.targets.length === 0 ||
    targetGroups.length !== 1 ||
    !targetGroup ||
    targetGroup.targetIds.length !== request.targets.length ||
    selectedTargetIds.size !== input.targetIds.length ||
    selectedTargetIds.size !== targetGroup.targetIds.length ||
    targetGroup.targetIds.some((targetId) => !selectedTargetIds.has(targetId))
  ) {
    throw new Error(
      "Return local finalization requires the complete target set for exactly one receipt."
    );
  }

  if (
    targetGroup.targets.some(
      (target) =>
        target.external_result_status !==
        SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded
    )
  ) {
    throw new Error(
      "Return local finalization requires every receipt target to have a succeeded external result."
    );
  }

  const returnRow = await input.tx.coupang_return_raw.findUnique({
    where: { external_receipt_id: receiptId },
    include: { order: true },
  });

  if (!returnRow || !returnRow.order) {
    throw new Error("반품 원본 또는 연결된 주문 원본을 찾을 수 없습니다.");
  }

  const withdrawal = await input.tx.coupang_return_withdrawal.findUnique({
    where: { external_receipt_id: receiptId },
    select: { coupang_return_withdrawal_id: true },
  });
  if (withdrawal) {
    throw new Error(
      "외부 성공 뒤 반품 철회가 확인되어 로컬 상태를 자동 확정하지 않습니다. 판매 채널 동기화 점검에서 확인해 주세요."
    );
  }

  const allocationTargets = request.targets.filter(
    (target) =>
      target.target_type === "MATCH_WORKER_ALLOCATION" &&
      target.allocation_id !== null
  );
  const allocationIds = allocationTargets.map(
    (target) => target.allocation_id as number
  );
  const allocationPgRows = allocationIds.length === 0
    ? []
    : await input.tx.match_worker_allocation.findMany({
        where: { allocation_id: { in: allocationIds } },
        select: { allocation_id: true, pg_no: true },
        orderBy: { allocation_id: "asc" },
      });
  await lockDeviceAggregates(input.tx, {
    pgNos: allocationPgRows.map((allocation) => allocation.pg_no),
    requireDevice: true,
    requireInventory: true,
  });
  await lockSalesAllocationRoots(input.tx, allocationIds);
  const allocations =
    allocationIds.length === 0
      ? []
      : await input.tx.match_worker_allocation.findMany({
          where: { allocation_id: { in: allocationIds } },
          orderBy: { allocation_id: "asc" },
        });
  const allocationById = new Map(
    allocations.map((allocation) => [allocation.allocation_id, allocation])
  );

  if (allocations.length !== allocationIds.length) {
    throw new Error("요청 당시 선택한 PG 배정 일부를 찾을 수 없습니다.");
  }

  for (const target of allocationTargets) {
    const allocation = allocationById.get(target.allocation_id as number);

    if (!allocation || allocation.pg_no !== target.pg_no) {
      throw new Error("요청 당시 PG 배정 스냅샷과 현재 배정 정보가 다릅니다.");
    }
  }

  await lockInventoryQuantityBalanceKeys(
    input.tx,
    allocations
      .map((allocation) => allocation.inventory_sku_id)
      .filter((inventorySkuId): inventorySkuId is number => Number.isSafeInteger(inventorySkuId) && Number(inventorySkuId) > 0)
      .flatMap((inventorySkuId) =>
        Object.values(INVENTORY_STATUS).map((inventoryStatus) => ({
          inventorySkuId,
          inventoryStatus,
        }))
      )
  );

  if (
    request.source_projection_revision === null ||
    !request.source_snapshot_digest
  ) {
    throw new Error(
      "반품 쓰기 요청의 원문 snapshot 증거가 없습니다."
    );
  }

  const beforeReceiptStatus = returnRow.return_receipt_status;
  const beforeReleaseStatus = returnRow.return_release_status;
  const afterReceiptStatus =
    action === "stopShipment"
      ? beforeReceiptStatus
      : request.requested_after_status;
  const afterReleaseStatus =
    action === "stopShipment"
      ? request.requested_after_status
      : beforeReleaseStatus;

  await projectConfirmedReturnStatus({
    tx: input.tx,
    action,
    returnRow,
    expectedBeforeStatus: request.expected_before_status,
    requestedAfterStatus: request.requested_after_status,
    finalizedAt: input.finalizedAt,
  });
  if (action === "stopShipment" || action === "approve") {
    const { resolveDesktopNotificationBySource } = await import(
      "@/quickhack_server/notifications/desktop-notification-service"
    );
    await resolveDesktopNotificationBySource(input.tx, {
      sourceType: "COUPANG_RETURN_RAW",
      sourceId: String(returnRow.coupang_return_raw_id),
      resolvedAt: input.finalizedAt,
    });
  }

  if (action === "stopShipment" || action === "approve") {
    if (action === "stopShipment") {
      await applyPreShipmentReturnToPackageGroups(input.tx, {
        allocationIds,
        returnedAt: input.finalizedAt,
        operationKey: `sales-channel-write:${input.requestId}`,
      });
    }
    for (const target of allocationTargets) {
      const allocation = allocationById.get(target.allocation_id as number);

      if (!allocation) {
        continue;
      }

      if (action === "approve" && !target.inspection_result) {
        throw new Error("반품 완료 요청에 검수 결과 스냅샷이 없습니다.");
      }

      const toStatus =
        action === "stopShipment"
          ? INVENTORY_STATUS.sellable
          : inventoryStatusForInspection(
              target.inspection_result as InspectionResult
            );

      await transitionInventoryStatusWithLedger(input.tx, {
        pgNo: allocation.pg_no,
        toStatus,
        transitionPolicy:
          action === "stopShipment"
            ? INVENTORY_TRANSITION_POLICY.preShipmentReturn
            : INVENTORY_TRANSITION_POLICY.postShipmentReturnInspection,
        operationKey:
          `sales-channel-write:${input.requestId}:return:${allocation.allocation_id}`,
        movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "SALES_CHANNEL_WRITE_REQUEST",
        sourceId: String(input.requestId),
        reason:
          action === "stopShipment"
            ? "출고 전 반품 출고중지 완료"
            : "출고 후 반품 검수 완료",
        actorUserId: input.actorUserId,
        occurredAt: input.finalizedAt,
      });
    }

    if (allocationIds.length > 0) {
      await input.tx.match_worker_allocation.updateMany({
        where: {
          allocation_id: { in: allocationIds },
          allocation_status: { in: [...ACTIVE_RETURN_ALLOCATION_STATUSES] },
        },
        data: {
          allocation_status: "CANCELED",
          released_at: input.finalizedAt,
          updated_at: input.finalizedAt,
        },
      });
    }
  }

  if (allocationIds.length > 0) {
    await input.tx.coupang_return_allocation.deleteMany({
      where: {
        coupang_return_raw_id: returnRow.coupang_return_raw_id,
        allocation_id: { notIn: allocationIds },
      },
    });
  }

  for (const target of allocationTargets) {
    const allocation = allocationById.get(target.allocation_id as number);

    if (!allocation) {
      continue;
    }

    const returnAllocation = await input.tx.coupang_return_allocation.upsert({
      where: {
        coupang_return_raw_id_allocation_id: {
          coupang_return_raw_id: returnRow.coupang_return_raw_id,
          allocation_id: allocation.allocation_id,
        },
      },
      create: {
        coupang_return_raw_id: returnRow.coupang_return_raw_id,
        allocation_id: allocation.allocation_id,
        external_receipt_id: receiptId,
        external_order_id: returnRow.external_order_id,
        external_shipment_id: allocation.external_shipment_id,
        external_vendor_item_id: allocation.external_vendor_item_id,
        pg_no: allocation.pg_no,
        action_type: action,
        linked_by_user_id: input.actorUserId,
        linked_at: input.finalizedAt,
        created_at: input.finalizedAt,
        updated_at: input.finalizedAt,
      },
      update: {
        action_type: action,
        linked_by_user_id: input.actorUserId,
        linked_at: input.finalizedAt,
        updated_at: input.finalizedAt,
      },
    });
    const selectedSupplyEventIds = request.targets
      .filter(
        (supplyTarget) =>
          supplyTarget.target_type === "SUPPLY_CONSUMPTION_EVENT" &&
          supplyTarget.allocation_id === allocation.allocation_id &&
          supplyTarget.supply_consumption_event_id !== null
      )
      .map(
        (supplyTarget) =>
          supplyTarget.supply_consumption_event_id as number
      );

    if (action === "stopShipment") {
      await restoreReturnSupplies(input.tx, {
        allocationId: allocation.allocation_id,
        coupangReturnAllocationId:
          returnAllocation.coupang_return_allocation_id,
        restoreAllReusable: true,
        occurredAt: input.finalizedAt,
        actorUserId: input.actorUserId,
      });
    } else if (action === "approve") {
      await restoreReturnSupplies(input.tx, {
        allocationId: allocation.allocation_id,
        coupangReturnAllocationId:
          returnAllocation.coupang_return_allocation_id,
        selectedConsumptionEventIds: selectedSupplyEventIds,
        restoreAllReusable: false,
        occurredAt: input.finalizedAt,
        actorUserId: input.actorUserId,
      });

      if (!target.inspection_result) {
        throw new Error("반품 완료 요청의 검수 결과 스냅샷이 없습니다.");
      }

      const existingInspection = await input.tx.inspections.findFirst({
        where: {
          inspection_type: INSPECTION_TYPE.returnCheck,
          source_type: INSPECTION_SOURCE_TYPE.coupangReturn,
          coupang_return_allocation_id:
            returnAllocation.coupang_return_allocation_id,
        },
      });
      const inspectionData = {
        inspection_result: target.inspection_result,
        checked_by_user_id: input.actorUserId,
        checked_at: input.finalizedAt,
        appearance_grade: target.appearance_grade,
        appearance_defect: target.appearance_defect,
        function_defect: target.function_defect,
        appearance_checked_at: input.finalizedAt,
        function_checked_at: input.finalizedAt,
        note: target.inspection_note,
      };

      if (existingInspection) {
        await input.tx.inspections.update({
          where: { inspection_id: existingInspection.inspection_id },
          data: {
            ...inspectionData,
            revision: { increment: 1 },
          },
        });
      } else {
        const inspectionRound =
          (await input.tx.inspections.count({
            where: {
              pg_no: allocation.pg_no,
              inspection_type: INSPECTION_TYPE.returnCheck,
            },
          })) + 1;

        await input.tx.inspections.create({
          data: {
            pg_no: allocation.pg_no,
            inspection_type: INSPECTION_TYPE.returnCheck,
            inspection_round: inspectionRound,
            source_type: INSPECTION_SOURCE_TYPE.coupangReturn,
            coupang_return_allocation_id:
              returnAllocation.coupang_return_allocation_id,
            return_yn: "N",
            created_at: input.finalizedAt,
            ...inspectionData,
          },
        });
      }
    }
  }

  if (action === "approve" && allocationIds.length > 0) {
    await markSalesRecordsReturnedForAllocations(input.tx, {
      allocationIds,
      returnedAt: input.finalizedAt,
    });
  }

  await input.tx.employee_activity_logs.create({
    data: {
      user_id: input.actorUserId,
      action_type:
        action === "stopShipment"
          ? "COUPANG_RETURN_STOPPED_SHIPMENT"
          : action === "receiveConfirm"
            ? "COUPANG_RETURN_RECEIVE_CONFIRMED"
            : "COUPANG_RETURN_APPROVED",
      target_type: "COUPANG_RETURN_RECEIPT",
      target_id: receiptId,
      ...activityLogChangeData(
        {
          receiptStatus: beforeReceiptStatus,
          releaseStatus: beforeReleaseStatus,
          externalOrderId: returnRow.external_order_id,
        },
        {
          receiptStatus: afterReceiptStatus,
          releaseStatus: afterReleaseStatus,
          cancelCount: request.cancel_count,
          selectedAllocationIds: allocationIds.join(","),
          writeRequestId: input.requestId,
        }
      ),
      result: "SUCCESS",
      created_at: input.finalizedAt,
    },
  });

  await appendDomainAuditEvent(input.tx, {
    contract: RETURN_AUDIT_CONTRACT,
    actorUserId: input.actorUserId,
    action:
      action === "stopShipment"
        ? "COUPANG_RETURN_STOPPED_SHIPMENT"
        : action === "receiveConfirm"
          ? "COUPANG_RETURN_RECEIVE_CONFIRMED"
          : "COUPANG_RETURN_APPROVED",
    aggregateType: "COUPANG_RETURN_RECEIPT",
    aggregateId: receiptId,
    operationKey: `sales-channel-write:${input.requestId}:return-finalized`,
    occurredAt: input.finalizedAt,
    changes: [
      {
        fieldPath: "receiptStatus",
        before: beforeReceiptStatus,
        after: afterReceiptStatus,
      },
      {
        fieldPath: "releaseStatus",
        before: beforeReleaseStatus,
        after: afterReleaseStatus,
      },
      { fieldPath: "writeRequestId", before: null, after: input.requestId },
      {
        fieldPath: "sourceProjectionRevision",
        before: null,
        after: request.source_projection_revision,
      },
      {
        fieldPath: "selectedAllocationIds",
        before: null,
        after: allocationIds.join(","),
      },
    ],
  });
}
