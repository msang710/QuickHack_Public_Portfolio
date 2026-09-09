// QuickHack object: Inbound purchase workflow status codes shared by server and UI.
export const INBOUND_STATUS = {
  received: "RECEIVED",
  inspecting: "INSPECTING",
  inspected: "INSPECTED",
  purchased: "PURCHASED",
  supplierReturn: "SUPPLIER_RETURN",
} as const;

export type InboundStatusCode =
  (typeof INBOUND_STATUS)[keyof typeof INBOUND_STATUS];

export function inboundStatusFromInspectionLifecycle(value: string) {
  if (value === "RETURN_CHECK") {
    return INBOUND_STATUS.supplierReturn;
  }

  if (value === "INSPECTED") {
    return INBOUND_STATUS.inspected;
  }

  if (value === "INSPECTING") {
    return INBOUND_STATUS.inspecting;
  }

  return INBOUND_STATUS.received;
}

export function effectiveInventoryDisplayStatus({
  inboundStatus,
  inventoryStatus,
}: {
  inboundStatus?: string | null;
  inventoryStatus?: string | null;
}) {
  if (inboundStatus === INBOUND_STATUS.purchased && inventoryStatus) {
    return inventoryStatus;
  }

  return inboundStatus || inventoryStatus || INBOUND_STATUS.received;
}
