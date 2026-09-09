import { prisma } from "@/quickhack_server/core/prisma";
import { publicConflict } from "@/quickhack_server/core/public-error";
import { digestDomainOperation } from "@/quickhack_server/core/database/aggregate-command";
import {
  COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES,
  COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES,
  COUPANG_RELEASE_STOP_PENDING_STATUSES,
  COUPANG_RELEASE_STOP_RECEIPT_STATUSES,
} from "@/quickhack_server/sales-channel/coupang/config";
import {
  requestSalesChannelWrite,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-service";
import {
  INSPECTION_RESULT,
  type InspectionResult,
} from "@/quickhack_shared/inspection/inspection-types";
import {
  normalizeSelectedSupplyEventIds,
} from "@/quickhack_server/supplies/outbound-supply-service";
import { finalizePersistedCoupangReturnWrite } from "@/quickhack_server/returns/return-write-finalizer";
import {
  assertReturnSelectionMatchesRequirements,
  buildReturnItemRequirements,
} from "@/quickhack_server/returns/return-item-requirement";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  type SalesChannelWriteCommand,
  type SalesChannelWriteTargetInput,
} from "@/quickhack_shared/sales-channel/write-requests";

type CoupangReturnAction = "stopShipment" | "receiveConfirm" | "approve";
type ReturnInspectionInput = {
  allocationId: number;
  inspectionResult: InspectionResult;
  appearanceGrade: string | null;
  appearanceDefect: string | null;
  functionDefect: string | null;
  note: string | null;
  reusableSupplyConsumptionEventIds: number[];
};

const RECEIVE_CONFIRM_STATUSES = [
  "RU",
  "UC",
  "RELEASE_STOP_UNCHECKED",
  "RETURNS_UNCHECKED",
] as const;

const APPROVAL_STATUSES = ["VENDOR_WAREHOUSE_CONFIRM"] as const;
const ACTIVE_RETURN_ALLOCATION_STATUSES = [
  "ALLOCATED",
  "API_ACKED",
  "SHIPMENT_LIST_PRINTED",
] as const;
const INSPECTION_RESULT_VALUES = new Set<string>(Object.values(INSPECTION_RESULT));

function positiveInt(value: unknown, label: string) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 값이 올바르지 않습니다.`);
  }

  return parsed;
}

function code(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function hasCode(value: unknown, codes: readonly string[]) {
  return codes.includes(code(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextActionForReceiptStatus(
  value: unknown
): CoupangReturnAction | null {
  if (hasCode(value, RECEIVE_CONFIRM_STATUSES)) {
    return "receiveConfirm";
  }

  if (hasCode(value, APPROVAL_STATUSES)) {
    return "approve";
  }

  return null;
}

function nextActionForReturnState(input: {
  orderStatus: string | null;
  receiptStatus: string | null;
  releaseStatus: string | null;
}): CoupangReturnAction | null {
  if (hasCode(input.orderStatus, COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES)) {
    return hasCode(input.receiptStatus, COUPANG_RELEASE_STOP_RECEIPT_STATUSES) &&
      hasCode(input.releaseStatus, COUPANG_RELEASE_STOP_PENDING_STATUSES)
      ? "stopShipment"
      : null;
  }

  if (hasCode(input.orderStatus, COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES)) {
    return nextActionForReceiptStatus(input.receiptStatus);
  }

  return null;
}

function normalizeAction(value: unknown): CoupangReturnAction | null {
  const text = String(value ?? "").trim();

  return text === "stopShipment" ||
    text === "receiveConfirm" ||
    text === "approve"
    ? text
    : null;
}

function normalizeAllocationIds(value: unknown) {
  const values = Array.isArray(value) ? value : [];
  const ids = values.map((item) => positiveInt(item, "PG 선택 ID"));

  return Array.from(new Set(ids));
}

function nullableInputText(value: unknown) {
  const text = String(value ?? "").trim();

  return text || null;
}

function normalizeInspectionResult(value: unknown) {
  const text = code(value);

  if (!INSPECTION_RESULT_VALUES.has(text)) {
    throw new Error("반품검수 결과 값이 올바르지 않습니다.");
  }

  return text as InspectionResult;
}

function normalizeReturnInspections(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const inspections: ReturnInspectionInput[] = [];
  const seenAllocationIds = new Set<number>();

  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error("반품검수 입력 형식이 올바르지 않습니다.");
    }

    const allocationId = positiveInt(item.allocationId, "반품검수 PG ID");

    if (seenAllocationIds.has(allocationId)) {
      throw new Error("반품검수 PG ID가 중복되었습니다.");
    }

    seenAllocationIds.add(allocationId);
    inspections.push({
      allocationId,
      inspectionResult: normalizeInspectionResult(item.inspectionResult),
      appearanceGrade: nullableInputText(item.appearanceGrade),
      appearanceDefect: nullableInputText(item.appearanceDefect),
      functionDefect: nullableInputText(item.functionDefect),
      note: nullableInputText(item.note),
      reusableSupplyConsumptionEventIds: normalizeSelectedSupplyEventIds(
        item.reusableSupplyConsumptionEventIds
      ),
    });
  }

  return inspections;
}

function sameNumberSet(left: number[], right: number[]) {
  if (left.length !== right.length) {
    return false;
  }

  const rightValues = new Set(right);

  return left.every((value) => rightValues.has(value));
}

function requestTypeForAction(action: CoupangReturnAction) {
  if (action === "stopShipment") {
    return SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment;
  }

  return action === "receiveConfirm"
    ? SALES_CHANNEL_WRITE_REQUEST_TYPE.returnReceiveConfirmation
    : SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval;
}

function nextReceiptStatusForAction(action: CoupangReturnAction) {
  if (action === "receiveConfirm") {
    return "VENDOR_WAREHOUSE_CONFIRM";
  }

  return "RETURNS_COMPLETED";
}

function nextReleaseStatusForAction(
  action: CoupangReturnAction,
  currentReleaseStatus: string | null
) {
  return action === "stopShipment" ? "S" : currentReleaseStatus;
}

function idempotencyKeyForAction(
  action: CoupangReturnAction,
  externalReceiptId: string
) {
  return `${requestTypeForAction(action)}:${externalReceiptId}`;
}

function expectedStatusForAction(input: {
  action: CoupangReturnAction;
  currentReceiptStatus: string | null;
  currentReleaseStatus: string | null;
}) {
  return input.action === "stopShipment"
    ? input.currentReleaseStatus
    : input.currentReceiptStatus;
}

function requestedStatusForAction(input: {
  action: CoupangReturnAction;
  currentReleaseStatus: string | null;
}) {
  return input.action === "stopShipment"
    ? nextReleaseStatusForAction(input.action, input.currentReleaseStatus)
    : nextReceiptStatusForAction(input.action);
}

function returnWriteTargets(
  selectedAllocations: Array<{
    allocation_id: number;
    pg_no: string;
    external_shipment_id: string | null;
    external_vendor_item_id: string | null;
  }>
): SalesChannelWriteTargetInput[] {
  return selectedAllocations.map((allocation) => ({
    targetType: "MATCH_WORKER_ALLOCATION",
    targetExternalId: String(allocation.allocation_id),
    allocationId: allocation.allocation_id,
    pgNo: allocation.pg_no,
    externalShipmentId: allocation.external_shipment_id,
    externalVendorItemId: allocation.external_vendor_item_id,
    quantity: 1,
  }));
}


export async function processCoupangPreShipmentReturnAction(input: {
  returnRawId?: unknown;
  expectedProjectionRevision?: unknown;
  action?: unknown;
  allocationIds?: unknown;
  returnInspections?: unknown;
  userId?: number | null;
}) {
  const returnRawId = positiveInt(input.returnRawId, "반품 row ID");
  const expectedProjectionRevision = positiveInt(
    input.expectedProjectionRevision,
    "반품 projection revision"
  );
  const requestedAction = normalizeAction(input.action);
  const selectedAllocationIds = normalizeAllocationIds(input.allocationIds);
  const returnInspections = normalizeReturnInspections(input.returnInspections);

  if (!requestedAction) {
    throw new Error("지원하지 않는 반품 작업입니다.");
  }

  const returnRow = await prisma.coupang_return_raw.findUnique({
    where: {
      coupang_return_raw_id: returnRawId,
    },
    include: {
      order: true,
      items: true,
    },
  });

  if (!returnRow) {
    throw new Error("반품 접수 데이터를 찾을 수 없습니다.");
  }

  if (returnRow.projection_revision !== expectedProjectionRevision) {
    throw new Error(
      "반품 정보가 조회 이후 변경되었습니다. 목록을 새로 고친 뒤 다시 처리해 주세요."
    );
  }
  const withdrawal = await prisma.coupang_return_withdrawal.findUnique({
    where: { external_receipt_id: returnRow.external_receipt_id },
    select: { coupang_return_withdrawal_id: true },
  });
  if (withdrawal) {
    throw new Error("철회된 반품 요청은 처리할 수 없습니다.");
  }
  if (returnRow.item_integrity_status !== "VALID") {
    throw new Error(
      `반품 품목 수량 무결성을 확인해야 합니다: ${returnRow.item_integrity_status}`
    );
  }

  const orderRow = returnRow.order;

  if (!orderRow) {
    throw new Error(
      "반품의 주문번호와 배송번호에 정확히 일치하는 쿠팡 주문 원본이 없습니다. 주문 동기화 후 다시 처리해 주세요."
    );
  }

  if (code(returnRow.cancel_type) === "EXCHANGE") {
    throw new Error("교환 접수는 출고 전 반품 처리 API 대상이 아닙니다.");
  }

  const currentReceiptStatus = returnRow.return_receipt_status;
  const currentReleaseStatus = returnRow.return_release_status;
  const expectedAction = nextActionForReturnState({
    orderStatus: orderRow.external_order_status,
    receiptStatus: currentReceiptStatus,
    releaseStatus: currentReleaseStatus,
  });
  const scopedShipmentIds = Array.from(
    new Set(
      returnRow.items
        .map((item) => String(item.external_shipment_id ?? "").trim())
        .filter(Boolean)
    )
  ).sort();
  const scopedOrders = await prisma.coupang_order_raw.findMany({
    where: {
      external_order_id: returnRow.external_order_id,
      external_shipment_id: { in: scopedShipmentIds },
    },
    select: {
      external_shipment_id: true,
      external_order_status: true,
    },
  });
  if (
    scopedShipmentIds.length === 0 ||
    scopedOrders.length !== scopedShipmentIds.length ||
    scopedOrders.some(
      (order) =>
        nextActionForReturnState({
          orderStatus: order.external_order_status,
          receiptStatus: currentReceiptStatus,
          releaseStatus: currentReleaseStatus,
        }) !== expectedAction
    )
  ) {
    throw new Error(
      "반품에 포함된 모든 송장의 현재 업무 단계가 같지 않아 외부 API 작업을 확정할 수 없습니다. 판매 채널 동기화 점검에서 주문·반품 범위를 확인하세요."
    );
  }

  if (!expectedAction) {
    throw new Error("현재 접수상태에서 실행할 다음 반품 작업이 없습니다.");
  }

  if (requestedAction !== expectedAction) {
    throw publicConflict(
      "RETURN_ACTION_MISMATCH",
      "RETURN_ACTION_MISMATCH",
      { expectedAction }
    );
  }

  const cancelCount = returnRow.cancel_count;
  const existingReturnAllocations =
    await prisma.coupang_return_allocation.findMany({
      where: {
        coupang_return_raw_id: returnRawId,
      },
      orderBy: [
        { linked_at: "asc" },
        { coupang_return_allocation_id: "asc" },
      ],
      select: {
        allocation_id: true,
        pg_no: true,
        action_type: true,
      },
    });
  const existingAllocationIds = Array.from(
    new Set(existingReturnAllocations.map((allocation) => allocation.allocation_id))
  );
  const orderAllocations = await prisma.match_worker_allocation.findMany({
    where: {
      external_order_id: returnRow.external_order_id,
      ...(existingAllocationIds.length > 0
        ? {
            OR: [
              {
                allocation_status: {
                  in: [...ACTIVE_RETURN_ALLOCATION_STATUSES],
                },
              },
              {
                allocation_id: {
                  in: existingAllocationIds,
                },
              },
            ],
          }
        : {
            allocation_status: {
              in: [...ACTIVE_RETURN_ALLOCATION_STATUSES],
            },
          }),
    },
    include: {
      device: true,
    },
  });
  const requirementResult = buildReturnItemRequirements({
    rootCancelCount: cancelCount,
    items: returnRow.items.map((item) => ({
      externalShipmentId: item.external_shipment_id,
      externalVendorItemId: item.external_vendor_item_id,
      cancelCount: item.cancel_count,
      vendorItemName: item.vendor_item_name,
    })),
    allocations: orderAllocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      externalShipmentId: allocation.external_shipment_id,
      externalVendorItemId: allocation.external_vendor_item_id,
      pgNo: allocation.pg_no,
    })),
  });
  const hasExistingReturnAllocation = existingAllocationIds.length > 0;
  const effectiveSelectedAllocationIds =
    requestedAction === "approve" && hasExistingReturnAllocation
      ? existingAllocationIds
      : selectedAllocationIds;

  if (
    requestedAction === "approve" &&
    hasExistingReturnAllocation &&
    !sameNumberSet(selectedAllocationIds, existingAllocationIds)
  ) {
    throw new Error(
      "입고 확인 때 연결한 PG와 동일한 PG만 반품 완료 처리할 수 있습니다."
    );
  }

  assertReturnSelectionMatchesRequirements({
    result: requirementResult,
    selectedAllocationIds: effectiveSelectedAllocationIds,
  });

  const selectedAllocations = effectiveSelectedAllocationIds.map((allocationId) => {
    const allocation = orderAllocations.find(
      (item) => item.allocation_id === allocationId
    );

    if (!allocation) {
      throw new Error("선택한 PG 정보를 찾을 수 없습니다.");
    }

    return allocation;
  });
  const returnInspectionByAllocationId = new Map(
    returnInspections.map((inspection) => [
      inspection.allocationId,
      inspection,
    ])
  );

  if (requestedAction === "approve" && selectedAllocations.length > 0) {
    const selectedAllocationIdSet = new Set(
      selectedAllocations.map((allocation) => allocation.allocation_id)
    );
    const invalidInspectionIds = returnInspections
      .map((inspection) => inspection.allocationId)
      .filter((allocationId) => !selectedAllocationIdSet.has(allocationId));

    if (invalidInspectionIds.length > 0) {
      throw new Error("반품검수 입력에 선택되지 않은 PG가 포함되어 있습니다.");
    }

    const missingInspectionIds = selectedAllocations
      .map((allocation) => allocation.allocation_id)
      .filter((allocationId) => !returnInspectionByAllocationId.has(allocationId));

    if (missingInspectionIds.length > 0) {
      throw new Error("반품 완료 시 선택한 PG별 반품검수 결과를 입력해야 합니다.");
    }
  }

  const nextReceiptStatus = nextReceiptStatusForAction(requestedAction);
  const nextReleaseStatus = nextReleaseStatusForAction(
    requestedAction,
    currentReleaseStatus
  );
  const selectedTargets: SalesChannelWriteTargetInput[] = [
    ...returnWriteTargets(selectedAllocations).map((target) => {
      const inspection = target.allocationId
        ? returnInspectionByAllocationId.get(target.allocationId)
        : null;

      return {
        ...target,
        externalOrderId: returnRow.external_order_id,
        expectedBeforeStatus: expectedStatusForAction({
          action: requestedAction,
          currentReceiptStatus,
          currentReleaseStatus,
        }),
        requestedAfterStatus: requestedStatusForAction({
          action: requestedAction,
          currentReleaseStatus,
        }),
        inspectionResult: inspection?.inspectionResult ?? null,
        appearanceGrade: inspection?.appearanceGrade ?? null,
        appearanceDefect: inspection?.appearanceDefect ?? null,
        functionDefect: inspection?.functionDefect ?? null,
        inspectionNote: inspection?.note ?? null,
      };
    }),
    ...returnInspections.flatMap((inspection) =>
      inspection.reusableSupplyConsumptionEventIds.map((eventId) => ({
        targetType: "SUPPLY_CONSUMPTION_EVENT",
        targetExternalId: String(eventId),
        allocationId: inspection.allocationId,
        externalOrderId: returnRow.external_order_id,
        supplyConsumptionEventId: eventId,
        quantity: 1,
      }))
    ),
  ];
  const sourceSnapshotDigest = digestDomainOperation({
    receiptId: returnRow.external_receipt_id,
    projectionRevision: expectedProjectionRevision,
    receiptStatus: currentReceiptStatus,
    releaseStatus: currentReleaseStatus,
    itemRequirements: requirementResult.requirements.map((requirement) => ({
      shipmentId: requirement.externalShipmentId,
      vendorItemId: requirement.externalVendorItemId,
      requiredQuantity: requirement.requiredQuantity,
      selectedAllocationIds: requirement.candidateAllocationIds.filter((id) =>
        effectiveSelectedAllocationIds.includes(id)
      ),
    })),
  });
  const commandBase = {
    channel: "COUPANG" as const,
    idempotencyKey: idempotencyKeyForAction(
      requestedAction,
      returnRow.external_receipt_id
    ),
    externalOrderId: returnRow.external_order_id,
    targetType: "COUPANG_RETURN_RECEIPT",
    targetExternalId: returnRow.external_receipt_id,
    cancelCount:
      requestedAction === "stopShipment" || requestedAction === "approve"
        ? cancelCount
        : null,
    expectedBeforeStatus: expectedStatusForAction({
      action: requestedAction,
      currentReceiptStatus,
      currentReleaseStatus,
    }),
    requestedAfterStatus: requestedStatusForAction({
      action: requestedAction,
      currentReleaseStatus,
    }),
    sourceMenuKey:
      requestedAction === "stopShipment"
        ? "return-before-shipment"
        : "return-after-shipment",
    sourceEntityType: "COUPANG_RETURN_RECEIPT",
    sourceEntityId: returnRow.external_receipt_id,
    sourceProjectionRevision: expectedProjectionRevision,
    sourceSnapshotDigest,
    requestedByUserId: input.userId ?? null,
    targets: selectedTargets,
  };
  const command: SalesChannelWriteCommand =
    requestedAction === "stopShipment"
      ? {
          ...commandBase,
          requestType:
            SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment,
          receiptId: returnRow.external_receipt_id,
          cancelCount,
        }
      : requestedAction === "receiveConfirm"
        ? {
            ...commandBase,
            requestType:
              SALES_CHANNEL_WRITE_REQUEST_TYPE.returnReceiveConfirmation,
            receiptId: returnRow.external_receipt_id,
          }
        : {
            ...commandBase,
            requestType: SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval,
            receiptId: returnRow.external_receipt_id,
            cancelCount,
          };

  await requestSalesChannelWrite(command, {
    beforeDispatch: async () => {
      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            projection_revision: number;
            return_receipt_status: string | null;
            return_release_status: string | null;
          }>
        >`
          SELECT projection_revision, return_receipt_status, return_release_status
          FROM coupang_return_raw
          WHERE coupang_return_raw_id = ${returnRawId}
          FOR UPDATE
        `;
        const current = rows[0];
        if (!current || current.projection_revision !== expectedProjectionRevision) {
          throw new Error(
            "반품 정보가 쓰기 직전에 변경되었습니다. 외부 API를 호출하지 않았습니다."
          );
        }
        const currentExpectedStatus = expectedStatusForAction({
          action: requestedAction,
          currentReceiptStatus: current.return_receipt_status,
          currentReleaseStatus: current.return_release_status,
        });
        if (currentExpectedStatus !== command.expectedBeforeStatus) {
          throw new Error(
            "반품 상태가 쓰기 직전에 변경되었습니다. 외부 API를 호출하지 않았습니다."
          );
        }
        const currentScopedOrders = await tx.coupang_order_raw.findMany({
          where: {
            external_order_id: returnRow.external_order_id,
            external_shipment_id: { in: scopedShipmentIds },
          },
          select: { external_order_status: true },
        });
        if (
          currentScopedOrders.length !== scopedShipmentIds.length ||
          currentScopedOrders.some(
            (order) =>
              nextActionForReturnState({
                orderStatus: order.external_order_status,
                receiptStatus: current.return_receipt_status,
                releaseStatus: current.return_release_status,
              }) !== requestedAction
          )
        ) {
          throw new Error(
            "반품 송장 범위의 업무 단계가 외부 API 호출 직전에 변경되어 요청을 중단했습니다."
          );
        }
        const withdrawn = await tx.coupang_return_withdrawal.findUnique({
          where: { external_receipt_id: returnRow.external_receipt_id },
          select: { coupang_return_withdrawal_id: true },
        });
        if (withdrawn) {
          throw new Error("철회된 반품 요청이므로 외부 API를 호출하지 않았습니다.");
        }
      });
    },
    finalize: async ({ tx, requestId, targetIds, finalizedAt: confirmedAt }) => {
      await finalizePersistedCoupangReturnWrite({
        tx,
        requestId,
        targetIds,
        actorUserId: input.userId ?? null,
        finalizedAt: confirmedAt,
      });
    },
  });

  return {
    action: requestedAction,
    externalReceiptId: returnRow.external_receipt_id,
    externalOrderId: returnRow.external_order_id,
    nextReceiptStatus,
    nextReleaseStatus,
    cancelCount,
    selectedAllocationCount: selectedAllocations.length,
  };
}
