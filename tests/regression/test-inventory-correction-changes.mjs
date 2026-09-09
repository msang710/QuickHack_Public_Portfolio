import assert from "node:assert/strict";
import {
  applyBulkInventoryCorrectionChanges,
  applyInventoryPendingTextDrafts,
  cloneDeviceDetailRecords,
  collectInventoryCorrectionChanges,
  emptyDeviceDetailRecords,
  inventoryCorrectionFieldKey,
  inventoryCorrectionPatches,
} from "../../quickhack_client/components/inventory/inventory-correction-changes.ts";

function record(id, kind, title, fields) {
  return {
    id,
    kind,
    recordId: 1,
    revision: 0,
    title,
    subtitle: null,
    at: null,
    fields,
  };
}

function field(key, label, value, readOnly = false) {
  return { key, label, value, readOnly };
}

function fixture() {
  const records = emptyDeviceDetailRecords();
  records.devices = [
    record("device-1", "device", "기기", [
      field("pg_no", "PG", "PG-1"),
      field("model", "모델", "Galaxy S24"),
      field("server_only", "서버 값", "원본", true),
    ]),
  ];
  records.inventory = [
    record("inventory-1", "inventory", "재고", [
      field("location", "위치", "포장 대기"),
    ]),
  ];
  records.inspections = [
    record("appearance-1", "inspection", "외관검수", [
      field("inspection_type", "검수 유형", "APPEARANCE", true),
      field("appearance_grade", "외관등급", "A"),
    ]),
    record("function-1", "inspection", "기능검수", [
      field("inspection_type", "검수 유형", "FUNCTION", true),
      field("function_defect", "기능하자", ""),
    ]),
  ];
  return records;
}

{
  const original = fixture();
  const edited = cloneDeviceDetailRecords(original);

  assert.deepEqual(
    collectInventoryCorrectionChanges(original, edited),
    [],
    "An unchanged inventory snapshot was marked dirty."
  );

  edited.devices[0].fields[1].value = "Galaxy S24 Ultra";
  edited.devices[0].fields[2].value = "클라이언트 변경";
  edited.inventory[0].fields[0].value = "포장 완료";

  const changes = collectInventoryCorrectionChanges(original, edited);
  assert.equal(changes.length, 2, "Editable changes were not collected exactly.");
  assert.deepEqual(
    changes.map(({ fieldKey }) => fieldKey).sort(),
    ["location", "model"],
    "Read-only changes leaked into the canonical change set."
  );
  assert.equal(
    changes.find(({ fieldKey }) => fieldKey === "model")?.bulkApplicable,
    true
  );
  assert.deepEqual(
    inventoryCorrectionPatches(changes, "missing revision").map((patch) => ({
      kind: patch.recordKind,
      id: patch.recordId,
      revision: patch.expectedRevision,
      field: patch.fieldKey,
      before: patch.expectedValue,
      after: patch.nextValue,
    })),
    [
      {
        kind: "device",
        id: 1,
        revision: 0,
        field: "model",
        before: "Galaxy S24",
        after: "Galaxy S24 Ultra",
      },
      {
        kind: "inventory",
        id: 1,
        revision: 0,
        field: "location",
        before: "포장 대기",
        after: "포장 완료",
      },
    ],
    "The client did not preserve the exact record and field baseline in its patch contract."
  );

  edited.devices[0].fields[1].value = "Galaxy S24";
  assert.deepEqual(
    collectInventoryCorrectionChanges(original, edited).map(
      ({ fieldKey }) => fieldKey
    ),
    ["location"],
    "Reverting a value to its baseline did not return it to clean."
  );
}

{
  const original = fixture();
  const pending = applyInventoryPendingTextDrafts(original, [
    {
      group: "inventory",
      recordId: "inventory-1",
      fieldKey: "location",
      value: "상품화 대기",
    },
  ]);
  const changes = collectInventoryCorrectionChanges(original, pending);

  assert.equal(changes.length, 1, "An uncommitted text draft was not detected.");
  assert.equal(
    changes[0]?.key,
    inventoryCorrectionFieldKey("inventory", "inventory-1", "location")
  );
  assert.equal(
    original.inventory[0].fields[0].value,
    "포장 대기",
    "Applying pending drafts mutated the baseline snapshot."
  );
}

{
  const original = fixture();
  const edited = cloneDeviceDetailRecords(original);
  edited.devices[0].fields[0].value = "PG-2";
  edited.inspections[0].fields[1].value = "B";
  edited.inspections[1].fields[1].value = "통화 불량";

  const changes = collectInventoryCorrectionChanges(original, edited);
  assert.equal(changes.length, 3);
  assert.equal(
    changes.find(({ fieldKey }) => fieldKey === "pg_no")?.bulkApplicable,
    false,
    "A device identity field became bulk-applicable."
  );

  const target = fixture();
  target.devices[0].fields[0].value = "TARGET-PG";
  const applied = applyBulkInventoryCorrectionChanges(target, changes);

  assert.equal(applied.appliedCount, 2);
  assert.equal(
    applied.records.devices[0].fields[0].value,
    "TARGET-PG",
    "Bulk correction overwrote an excluded identity field."
  );
  assert.equal(applied.records.inspections[0].fields[1].value, "B");
  assert.equal(
    applied.records.inspections[1].fields[1].value,
    "통화 불량",
    "Inspection changes were not applied to their matching flavor."
  );
}

console.log("Inventory correction change set verified.");
