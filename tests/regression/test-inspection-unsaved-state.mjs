import assert from "node:assert/strict";
import {
  advanceFunctionRowDraftBaseline,
  appearanceDraftSnapshotsEqual,
  createAppearanceDraftSnapshot,
  createFunctionRowDraftBaselines,
  discardPendingInspectionRecords,
  hasPendingInspectionRecords,
  isFunctionDraftDirty,
  restoreFunctionRowsFromBaselines,
} from "../../quickhack_client/components/inspection/inspection-unsaved-state.ts";
import {
  CLIENT_RECORD_ID,
  UPLOAD_STATUSES,
  UPLOAD_STATUS_COLUMN,
  createInspectionRecord,
} from "../../quickhack_shared/inspection/inspection-schema.ts";

function functionRow(id, values = {}) {
  return {
    id,
    serial: "",
    connectionState: "manual",
    product: "",
    csc: "",
    storage: "",
    firstCallDate: "",
    account: "연결되지 않음",
    cameraCheck: "-",
    warning: "",
    pg: "",
    imei: "",
    functionDefect: "",
    returnYn: "N",
    ...values,
  };
}

function inspectionRecord(id, status) {
  return {
    ...createInspectionRecord({ PG: `PG${id.padStart(10, "0")}` }),
    [CLIENT_RECORD_ID]: id,
    [UPLOAD_STATUS_COLUMN]: status,
  };
}

{
  const baseline = createAppearanceDraftSnapshot({
    batchNo: "1",
    pg: "",
    color: "",
    grade: "A",
    defectText: "",
  });

  assert.equal(
    appearanceDraftSnapshotsEqual(
      baseline,
      createAppearanceDraftSnapshot({
        batchNo: " 1 ",
        pg: "",
        color: "",
        grade: "A",
        defectText: "",
      })
    ),
    true,
    "Whitespace-only appearance input differences were marked dirty."
  );
  assert.equal(
    appearanceDraftSnapshotsEqual(
      baseline,
      createAppearanceDraftSnapshot({
        ...baseline,
        pg: "ab1234567890",
      })
    ),
    false,
    "A new appearance PG was not marked dirty."
  );
}

{
  const blankRow = functionRow("row-1");
  assert.equal(
    isFunctionDraftDirty({
      rows: [blankRow],
      baselines: {},
      selectedDefectText: "",
    }),
    false,
    "A blank function row was marked dirty."
  );

  const editedRow = functionRow("row-1", {
    product: "Galaxy S24",
    pg: "AB1234567890",
    imei: "123456789012345",
  });
  assert.equal(
    isFunctionDraftDirty({
      rows: [editedRow],
      baselines: {},
      selectedDefectText: "",
    }),
    true,
    "A new function draft was not marked dirty."
  );

  const committedBaselines = advanceFunctionRowDraftBaseline({}, editedRow);
  assert.equal(
    isFunctionDraftDirty({
      rows: [editedRow],
      baselines: committedBaselines,
      selectedDefectText: "",
    }),
    false,
    "A locally committed function row did not become clean."
  );

  const changedRow = { ...editedRow, storage: "256GB" };
  assert.equal(
    isFunctionDraftDirty({
      rows: [changedRow],
      baselines: committedBaselines,
      selectedDefectText: "",
    }),
    true,
    "An edit after function-row commit was not marked dirty."
  );
  assert.equal(
    restoreFunctionRowsFromBaselines(
      [changedRow, functionRow("uncommitted", { pg: "AB0000000001" })],
      committedBaselines
    )[0]?.storage,
    "",
    "Discard did not restore the committed function-row baseline."
  );
  assert.equal(
    restoreFunctionRowsFromBaselines(
      [changedRow, functionRow("uncommitted", { pg: "AB0000000001" })],
      committedBaselines
    ).length,
    1,
    "Discard retained an uncommitted non-empty function row."
  );
  assert.equal(
    isFunctionDraftDirty({
      rows: [editedRow],
      baselines: committedBaselines,
      selectedDefectText: "충전-충전불량",
    }),
    true,
    "An unapplied function defect selection was not marked dirty."
  );
}

{
  const adbRows = [
    functionRow("device-1", {
      serial: "device-1",
      connectionState: "device",
    }),
  ];
  const adbBaselines = createFunctionRowDraftBaselines(adbRows);

  assert.equal(
    isFunctionDraftDirty({
      rows: adbRows,
      baselines: adbBaselines,
      selectedDefectText: "",
    }),
    false,
    "Fresh ADB-derived rows were marked dirty after becoming the baseline."
  );
  const editedAdbRows = [{ ...adbRows[0], pg: "AB1234567890" }];
  const restoredAdbRows = restoreFunctionRowsFromBaselines(
    editedAdbRows,
    adbBaselines
  );
  assert.equal(
    restoredAdbRows[0]?.serial,
    "device-1",
    "Discard removed an ADB row whose editable baseline was empty."
  );
  assert.equal(
    restoredAdbRows[0]?.pg,
    "",
    "Discard did not restore an ADB row with an empty editable baseline."
  );
}

{
  const done = inspectionRecord("1", UPLOAD_STATUSES.done);
  const pending = inspectionRecord("2", UPLOAD_STATUSES.pending);
  const failed = inspectionRecord("3", UPLOAD_STATUSES.failed);

  assert.equal(hasPendingInspectionRecords([done]), false);
  assert.equal(hasPendingInspectionRecords([done, pending]), true);
  assert.equal(hasPendingInspectionRecords([done, failed]), true);
  assert.deepEqual(
    discardPendingInspectionRecords([done, pending, failed]).map(
      (record) => record[CLIENT_RECORD_ID]
    ),
    ["1"],
    "Discard removed completed history or retained pending upload records."
  );
}

console.log("Inspection unsaved state verified.");
