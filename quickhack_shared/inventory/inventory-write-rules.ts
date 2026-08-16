import {
  INVENTORY_STATUS,
  type InventoryStatusCode,
} from "@/quickhack_shared/inventory/inventory-status";

export const INVENTORY_TRANSITION_POLICY = {
  purchaseConfirmation: "PURCHASE_CONFIRMATION",
  orderMatchingReservation: "ORDER_MATCHING_RESERVATION",
  orderRematchRelease: "ORDER_REMATCH_RELEASE",
  shipmentPrintConfirmation: "SHIPMENT_PRINT_CONFIRMATION",
  packingValidation: "PACKING_VALIDATION",
  preShipmentReturn: "PRE_SHIPMENT_RETURN",
  postShipmentReturnInspection: "POST_SHIPMENT_RETURN_INSPECTION",
  manualInventoryCorrection: "MANUAL_INVENTORY_CORRECTION",
  standardShipmentInvoiceConfirmed: "STANDARD_SHIPMENT_INVOICE_CONFIRMED",
  exchangeShipmentInvoiceConfirmed: "EXCHANGE_SHIPMENT_INVOICE_CONFIRMED",
  deliveryStatusSync: "DELIVERY_STATUS_SYNC",
} as const;

export type InventoryTransitionPolicy =
  (typeof INVENTORY_TRANSITION_POLICY)[keyof typeof INVENTORY_TRANSITION_POLICY];

const INVENTORY_STATUS_VALUES = new Set<string>(Object.values(INVENTORY_STATUS));

export const INVENTORY_SKU_EDITABLE_STATUSES = new Set<InventoryStatusCode>([
  INVENTORY_STATUS.hold,
  INVENTORY_STATUS.defective,
  INVENTORY_STATUS.returnCheck,
]);

export const MANUAL_INVENTORY_INITIAL_STATUSES = new Set<InventoryStatusCode>([
  INVENTORY_STATUS.sellable,
  INVENTORY_STATUS.hold,
  INVENTORY_STATUS.defective,
  INVENTORY_STATUS.returnCheck,
]);

const MANUAL_CORRECTION_STATUSES = new Set<InventoryStatusCode>([
  INVENTORY_STATUS.sellable,
  INVENTORY_STATUS.hold,
  INVENTORY_STATUS.defective,
  INVENTORY_STATUS.returnCheck,
]);

const POST_SHIPMENT_RETURN_SOURCE_STATUSES = new Set<InventoryStatusCode>([
  INVENTORY_STATUS.reserved,
  INVENTORY_STATUS.packing,
  INVENTORY_STATUS.packed,
  INVENTORY_STATUS.departure,
  INVENTORY_STATUS.delivering,
  INVENTORY_STATUS.finalDelivery,
  INVENTORY_STATUS.noneTracking,
  INVENTORY_STATUS.returnCheck,
]);

const PRE_SHIPMENT_RETURN_SOURCE_STATUSES = new Set<InventoryStatusCode>([
  INVENTORY_STATUS.reserved,
  INVENTORY_STATUS.packing,
  INVENTORY_STATUS.packed,
  INVENTORY_STATUS.departure,
]);

const RETURN_INSPECTION_TARGET_STATUSES = new Set<InventoryStatusCode>([
  INVENTORY_STATUS.sellable,
  INVENTORY_STATUS.hold,
  INVENTORY_STATUS.defective,
]);

function statusCode(value: string, label: string): InventoryStatusCode {
  if (!INVENTORY_STATUS_VALUES.has(value)) {
    throw new Error(`${label} 재고상태가 정의되어 있지 않습니다: ${value}`);
  }

  return value as InventoryStatusCode;
}

export function assertKnownInventoryStatus(value: string, label = "요청한") {
  return statusCode(value, label);
}

export function assertManualInventoryInitialStatus(value: string) {
  const status = statusCode(value, "신규");

  if (!MANUAL_INVENTORY_INITIAL_STATUSES.has(status)) {
    throw new Error(
      `재고 추가 시 ${status} 상태로 시작할 수 없습니다. 판매가능, 보류, 불량, 반품검수 상태만 허용됩니다.`
    );
  }
}

export function assertInventorySkuEditAllowed(value: string) {
  const status = statusCode(value, "현재");

  if (!INVENTORY_SKU_EDITABLE_STATUSES.has(status)) {
    throw new Error(
      `현재 재고상태가 ${status}이므로 SKU 조합을 수정할 수 없습니다. 보류, 불량, 반품검수 상태에서만 수정할 수 있습니다.`
    );
  }
}

export function assertInventoryStatusTransition(input: {
  fromStatus: string;
  toStatus: string;
  policy: InventoryTransitionPolicy;
}) {
  const fromStatus = statusCode(input.fromStatus, "현재");
  const toStatus = statusCode(input.toStatus, "변경할");

  if (fromStatus === toStatus) {
    return;
  }

  let allowed = false;

  switch (input.policy) {
    case INVENTORY_TRANSITION_POLICY.purchaseConfirmation:
      allowed =
        MANUAL_INVENTORY_INITIAL_STATUSES.has(fromStatus) &&
        toStatus === INVENTORY_STATUS.sellable;
      break;
    case INVENTORY_TRANSITION_POLICY.orderMatchingReservation:
      allowed =
        fromStatus === INVENTORY_STATUS.sellable &&
        toStatus === INVENTORY_STATUS.reserved;
      break;
    case INVENTORY_TRANSITION_POLICY.orderRematchRelease:
      allowed =
        fromStatus === INVENTORY_STATUS.reserved &&
        toStatus === INVENTORY_STATUS.sellable;
      break;
    case INVENTORY_TRANSITION_POLICY.shipmentPrintConfirmation:
      allowed =
        fromStatus === INVENTORY_STATUS.reserved &&
        toStatus === INVENTORY_STATUS.packing;
      break;
    case INVENTORY_TRANSITION_POLICY.packingValidation:
      allowed =
        fromStatus === INVENTORY_STATUS.packing &&
        toStatus === INVENTORY_STATUS.packed;
      break;
    case INVENTORY_TRANSITION_POLICY.preShipmentReturn:
      allowed =
        PRE_SHIPMENT_RETURN_SOURCE_STATUSES.has(fromStatus) &&
        toStatus === INVENTORY_STATUS.sellable;
      break;
    case INVENTORY_TRANSITION_POLICY.postShipmentReturnInspection:
      allowed =
        POST_SHIPMENT_RETURN_SOURCE_STATUSES.has(fromStatus) &&
        RETURN_INSPECTION_TARGET_STATUSES.has(toStatus);
      break;
    case INVENTORY_TRANSITION_POLICY.manualInventoryCorrection:
      allowed =
        MANUAL_CORRECTION_STATUSES.has(fromStatus) &&
        MANUAL_CORRECTION_STATUSES.has(toStatus);
      break;
    case INVENTORY_TRANSITION_POLICY.standardShipmentInvoiceConfirmed:
      allowed =
        fromStatus === INVENTORY_STATUS.packed &&
        toStatus === INVENTORY_STATUS.departure;
      break;
    case INVENTORY_TRANSITION_POLICY.exchangeShipmentInvoiceConfirmed:
      allowed =
        fromStatus === INVENTORY_STATUS.packing &&
        toStatus === INVENTORY_STATUS.departure;
      break;
    case INVENTORY_TRANSITION_POLICY.deliveryStatusSync:
      allowed =
        (fromStatus === INVENTORY_STATUS.departure &&
          (toStatus === INVENTORY_STATUS.delivering ||
            toStatus === INVENTORY_STATUS.finalDelivery ||
            toStatus === INVENTORY_STATUS.noneTracking)) ||
        (fromStatus === INVENTORY_STATUS.delivering &&
          (toStatus === INVENTORY_STATUS.finalDelivery ||
            toStatus === INVENTORY_STATUS.noneTracking)) ||
        (fromStatus === INVENTORY_STATUS.noneTracking &&
          (toStatus === INVENTORY_STATUS.delivering ||
            toStatus === INVENTORY_STATUS.finalDelivery));
      break;
  }

  if (!allowed) {
    throw new Error(
      `허용되지 않은 재고상태 전환입니다: ${fromStatus} -> ${toStatus} (${input.policy})`
    );
  }
}
