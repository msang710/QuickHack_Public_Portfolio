export const SHIPMENT_PRINT_BATCH_STATUS = {
  pending: "PENDING",
  printDialogClosed: "PRINT_DIALOG_CLOSED",
  confirmed: "CONFIRMED",
  canceled: "CANCELED",
} as const;

export type ShipmentPrintBatchStatus =
  (typeof SHIPMENT_PRINT_BATCH_STATUS)[keyof typeof SHIPMENT_PRINT_BATCH_STATUS];

export const SHIPMENT_PRINT_BATCH_TERMINAL_STATUSES = [
  SHIPMENT_PRINT_BATCH_STATUS.confirmed,
  SHIPMENT_PRINT_BATCH_STATUS.canceled,
] as const;

export function isShipmentPrintBatchStatus(
  value: unknown
): value is ShipmentPrintBatchStatus {
  return (Object.values(SHIPMENT_PRINT_BATCH_STATUS) as string[]).includes(
    String(value ?? "")
  );
}

export function isShipmentPrintBatchTerminalStatus(
  status: ShipmentPrintBatchStatus
) {
  return (SHIPMENT_PRINT_BATCH_TERMINAL_STATUSES as readonly string[]).includes(
    status
  );
}

export function shipmentPrintBatchAllowedFromStatuses(
  targetStatus: Exclude<ShipmentPrintBatchStatus, "PENDING">
): ShipmentPrintBatchStatus[] {
  if (targetStatus === SHIPMENT_PRINT_BATCH_STATUS.printDialogClosed) {
    return [SHIPMENT_PRINT_BATCH_STATUS.pending];
  }

  return [
    SHIPMENT_PRINT_BATCH_STATUS.pending,
    SHIPMENT_PRINT_BATCH_STATUS.printDialogClosed,
  ];
}
