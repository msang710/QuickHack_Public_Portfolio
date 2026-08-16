import assert from "node:assert/strict";
import {
  failedLabelSelectionIsDirty,
  normalizeFailedLabelIds,
  printerCalibrationSettingsSnapshotsEqual,
  shipmentLabelConfirmationFormId,
} from "../../quickhack_client/components/shipment/shipment-label-draft-state.ts";

function printer(values = {}) {
  return {
    printerName: "TSC DA200",
    sensorType: "GAP",
    gapMm: 3,
    gapOffsetMm: 0,
    direction: 1,
    referenceX: 0,
    referenceY: 0,
    shiftX: 0,
    shiftY: 0,
    speed: 3,
    density: 8,
    ...values,
  };
}

{
  assert.equal(
    printerCalibrationSettingsSnapshotsEqual(
      printer(),
      printer({ printerName: " TSC DA200 " })
    ),
    true,
    "Printer-name whitespace created a false dirty state."
  );
  assert.equal(
    printerCalibrationSettingsSnapshotsEqual(
      printer(),
      printer({ shiftX: 2 })
    ),
    false,
    "A printer calibration change was not detected."
  );
  assert.equal(
    printerCalibrationSettingsSnapshotsEqual(null, null),
    true,
    "Two unloaded printer settings were not equal."
  );
}

{
  assert.deepEqual(normalizeFailedLabelIds([4, 2, 4, -1, 0]), [2, 4]);
  assert.equal(failedLabelSelectionIsDirty([]), false);
  assert.equal(failedLabelSelectionIsDirty([4]), true);
  assert.equal(
    shipmentLabelConfirmationFormId(7),
    "shipment.label-confirm:7"
  );
}

console.log("Shipment label draft state verified.");
