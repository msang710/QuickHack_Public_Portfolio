import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";

export type PrinterCalibrationSettingsSnapshot = {
  printerName: string;
  sensorType: "GAP" | "BLINE";
  gapMm: number;
  gapOffsetMm: number;
  direction: 0 | 1;
  referenceX: number;
  referenceY: number;
  shiftX: number;
  shiftY: number;
  speed: number;
  density: number;
};

function normalizedNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function createPrinterCalibrationSettingsSnapshot(
  settings: PrinterCalibrationSettingsSnapshot
): PrinterCalibrationSettingsSnapshot {
  return {
    printerName: settings.printerName.trim(),
    sensorType: settings.sensorType === "BLINE" ? "BLINE" : "GAP",
    gapMm: normalizedNumber(settings.gapMm),
    gapOffsetMm: normalizedNumber(settings.gapOffsetMm),
    direction: settings.direction === 0 ? 0 : 1,
    referenceX: normalizedNumber(settings.referenceX),
    referenceY: normalizedNumber(settings.referenceY),
    shiftX: normalizedNumber(settings.shiftX),
    shiftY: normalizedNumber(settings.shiftY),
    speed: normalizedNumber(settings.speed),
    density: normalizedNumber(settings.density),
  };
}

export function printerCalibrationSettingsSnapshotsEqual(
  baseline: PrinterCalibrationSettingsSnapshot | null,
  current: PrinterCalibrationSettingsSnapshot | null
) {
  if (!baseline || !current) {
    return baseline === current;
  }

  return unsavedFormSnapshotsEqual(
    createPrinterCalibrationSettingsSnapshot(baseline),
    createPrinterCalibrationSettingsSnapshot(current)
  );
}

export function normalizeFailedLabelIds(values: readonly number[]) {
  return Array.from(
    new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))
  ).sort((left, right) => left - right);
}

export function failedLabelSelectionIsDirty(values: readonly number[]) {
  return normalizeFailedLabelIds(values).length > 0;
}

export function shipmentLabelConfirmationFormId(
  issueBatchId: number | null | undefined
) {
  return Number.isSafeInteger(issueBatchId) && Number(issueBatchId) > 0
    ? `shipment.label-confirm:${Number(issueBatchId)}`
    : "shipment.label-confirm:none";
}
