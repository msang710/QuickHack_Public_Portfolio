export const INVENTORY_CORRECTION_RECORD_KINDS = [
  "device",
  "inbound",
  "inventory",
  "inspection",
] as const;

export type InventoryCorrectionRecordKind =
  (typeof INVENTORY_CORRECTION_RECORD_KINDS)[number];

export type InventoryCorrectionScalar = string | number | null;

export type InventoryCorrectionPatch = {
  recordKind: InventoryCorrectionRecordKind;
  recordId: number;
  expectedRevision: number;
  fieldKey: string;
  expectedValue: InventoryCorrectionScalar;
  nextValue: InventoryCorrectionScalar;
};

export type InventoryCorrectionRevision = {
  recordKind: InventoryCorrectionRecordKind;
  recordId: number;
  revision: number;
};
