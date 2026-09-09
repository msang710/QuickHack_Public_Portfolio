import type {
  DetailRecord,
  DeviceDetailRecords,
} from "@/quickhack_shared/device/types";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";
import type { InventoryCorrectionPatch } from "@/quickhack_shared/inventory/inventory-correction";

export type EditableInventoryCorrectionGroup =
  | "devices"
  | "inbounds"
  | "inventory"
  | "inspections";

export type InventoryInspectionFlavor = "appearance" | "function";

export type InventoryCorrectionChange = {
  key: string;
  group: EditableInventoryCorrectionGroup;
  recordId: number;
  recordKind: InventoryCorrectionPatch["recordKind"];
  expectedRevision: number;
  recordIndex: number;
  inspectionFlavor?: InventoryInspectionFlavor;
  inspectionFlavorIndex?: number;
  fieldKey: string;
  originalValue: string;
  value: string;
  label: string;
  bulkApplicable: boolean;
};

export type InventoryPendingTextDraft = {
  group: EditableInventoryCorrectionGroup;
  recordId: string;
  fieldKey: string;
  value: string;
};

const EDITABLE_GROUPS = [
  "devices",
  "inbounds",
  "inventory",
  "inspections",
] as const satisfies readonly EditableInventoryCorrectionGroup[];

const BULK_EXCLUDED_FIELD_KEYS = new Set([
  "pg_no",
  "imei",
  "adb_serial",
  "model_seq",
]);

const APPEARANCE_INSPECTION_EVIDENCE_KEYS = new Set([
  "appearance_grade",
  "appearance_defect",
  "return_yn",
  "appearance_worker",
  "appearance_checked_at",
]);

const FUNCTION_INSPECTION_EVIDENCE_KEYS = new Set([
  "function_defect",
  "csc",
  "first_call_date",
  "function_worker",
  "function_checked_at",
]);

export function inventoryCorrectionValue(value: string | number | null) {
  if (value === null || value === "") {
    return "";
  }

  return String(value);
}

export function inventoryCorrectionFieldKey(
  group: EditableInventoryCorrectionGroup,
  recordId: string,
  fieldKey: string
) {
  return [group, recordId, fieldKey].join("\u0000");
}

function cloneDetailRecord(record: DetailRecord): DetailRecord {
  return {
    ...record,
    fields: record.fields.map((field) => ({ ...field })),
  };
}

export function emptyDeviceDetailRecords(): DeviceDetailRecords {
  return {
    devices: [],
    inbounds: [],
    inspections: [],
    inventory: [],
    orderItems: [],
    channelOrderMatches: [],
    shipmentWorks: [],
    returnDecisions: [],
  };
}

export function cloneDeviceDetailRecords(
  records: DeviceDetailRecords
): DeviceDetailRecords {
  return {
    devices: records.devices.map(cloneDetailRecord),
    inbounds: records.inbounds.map(cloneDetailRecord),
    inspections: records.inspections.map(cloneDetailRecord),
    inventory: records.inventory.map(cloneDetailRecord),
    orderItems: records.orderItems.map(cloneDetailRecord),
    channelOrderMatches: records.channelOrderMatches.map(cloneDetailRecord),
    shipmentWorks: records.shipmentWorks.map(cloneDetailRecord),
    returnDecisions: records.returnDecisions.map(cloneDetailRecord),
  };
}

function inspectionFlavor(record: DetailRecord): InventoryInspectionFlavor | null {
  const inspectionType = record.fields.find(
    (field) => field.key === "inspection_type"
  )?.value;

  if (inspectionType === INSPECTION_TYPE.appearance) {
    return "appearance";
  }

  if (inspectionType === INSPECTION_TYPE.function) {
    return "function";
  }

  if (
    record.fields.some(
      (field) =>
        APPEARANCE_INSPECTION_EVIDENCE_KEYS.has(field.key) &&
        field.value !== null &&
        field.value !== ""
    )
  ) {
    return "appearance";
  }

  if (
    record.fields.some(
      (field) =>
        FUNCTION_INSPECTION_EVIDENCE_KEYS.has(field.key) &&
        field.value !== null &&
        field.value !== ""
    )
  ) {
    return "function";
  }

  return null;
}

function inspectionRecordsByFlavor(
  records: DetailRecord[],
  flavor: InventoryInspectionFlavor
) {
  return records.filter((record) => inspectionFlavor(record) === flavor);
}

function inspectionTarget(
  records: DetailRecord[],
  recordId: string
):
  | {
      flavor: InventoryInspectionFlavor;
      flavorIndex: number;
    }
  | null {
  for (const flavor of ["appearance", "function"] as const) {
    const flavorIndex = inspectionRecordsByFlavor(records, flavor).findIndex(
      (record) => record.id === recordId
    );
    if (flavorIndex !== -1) {
      return { flavor, flavorIndex };
    }
  }

  return null;
}

function findOriginalRecord(
  records: DetailRecord[],
  record: DetailRecord,
  index: number
) {
  return records.find((item) => item.id === record.id) ?? records[index] ?? null;
}

export function collectInventoryCorrectionChanges(
  originalRecords: DeviceDetailRecords,
  editedRecords: DeviceDetailRecords
) {
  const changes: InventoryCorrectionChange[] = [];

  for (const group of EDITABLE_GROUPS) {
    editedRecords[group].forEach((record, recordIndex) => {
      const originalRecord = findOriginalRecord(
        originalRecords[group],
        record,
        recordIndex
      );

      if (!originalRecord) {
        return;
      }

      const target =
        group === "inspections"
          ? inspectionTarget(originalRecords.inspections, record.id)
          : null;

      if (group === "inspections" && !target) {
        return;
      }

      for (const field of record.fields) {
        if (field.readOnly) {
          continue;
        }

        const originalField = originalRecord.fields.find(
          (item) => item.key === field.key
        );
        if (!originalField) {
          continue;
        }

        const value = inventoryCorrectionValue(field.value);
        const originalValue = inventoryCorrectionValue(originalField.value);
        if (value === originalValue) {
          continue;
        }

        changes.push({
          key: inventoryCorrectionFieldKey(group, record.id, field.key),
          group,
          recordId: record.recordId ?? -1,
          recordKind: record.kind as InventoryCorrectionPatch["recordKind"],
          expectedRevision: record.revision ?? -1,
          recordIndex,
          inspectionFlavor: target?.flavor,
          inspectionFlavorIndex: target?.flavorIndex,
          fieldKey: field.key,
          originalValue,
          value,
          label: `${originalRecord.title} / ${field.key}`,
          bulkApplicable: !BULK_EXCLUDED_FIELD_KEYS.has(field.key),
        });
      }
    });
  }

  return changes;
}

export function applyInventoryPendingTextDrafts(
  records: DeviceDetailRecords,
  drafts: readonly InventoryPendingTextDraft[]
) {
  if (drafts.length === 0) {
    return records;
  }

  const nextRecords = cloneDeviceDetailRecords(records);

  for (const draft of drafts) {
    const record = nextRecords[draft.group].find(
      (item) => item.id === draft.recordId
    );
    const field = record?.fields.find((item) => item.key === draft.fieldKey);

    if (!field || field.readOnly) {
      continue;
    }

    field.value = draft.value;
    field.displayValue = undefined;
  }

  return nextRecords;
}

export function inventoryCorrectionPatches(
  changes: readonly InventoryCorrectionChange[],
  missingRevisionMessage: string
): InventoryCorrectionPatch[] {
  return changes.map((change) => {
    if (change.recordId <= 0 || change.expectedRevision < 0) {
      throw new Error(missingRevisionMessage);
    }
    return {
      recordKind: change.recordKind,
      recordId: change.recordId,
      expectedRevision: change.expectedRevision,
      fieldKey: change.fieldKey,
      expectedValue: change.originalValue,
      nextValue: change.value,
    };
  });
}

export function applyBulkInventoryCorrectionChanges(
  records: DeviceDetailRecords,
  changes: readonly InventoryCorrectionChange[]
) {
  const nextRecords = cloneDeviceDetailRecords(records);
  let appliedCount = 0;

  for (const change of changes) {
    if (!change.bulkApplicable) {
      continue;
    }

    let record: DetailRecord | undefined;

    if (change.group === "inspections" && change.inspectionFlavor) {
      const flavorRecords = inspectionRecordsByFlavor(
        nextRecords.inspections,
        change.inspectionFlavor
      );
      const targetRecord =
        flavorRecords[change.inspectionFlavorIndex ?? -1];
      record = targetRecord
        ? nextRecords.inspections.find((item) => item.id === targetRecord.id)
        : undefined;
    } else {
      record = nextRecords[change.group][change.recordIndex];
    }

    const field = record?.fields.find(
      (item) => item.key === change.fieldKey
    );
    if (!field || field.readOnly) {
      continue;
    }

    field.value = change.value;
    field.displayValue = undefined;
    appliedCount += 1;
  }

  return {
    records: nextRecords,
    appliedCount,
  };
}
