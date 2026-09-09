// QuickHack note: 기존 재고 수정 메뉴에서 PG에 연결된 모든 기록을 편집 가능한 섹션으로 표시하는 도구입니다.
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  DEVICE_WARRANTY_OPTIONS,
  type DetailRecord,
  type DeviceDetailRecords,
  type DeviceListItem,
} from "@/quickhack_shared/device/types";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import {
  getStorageOptionsForProduct,
  type ProductCriteriaPayload,
} from "@/quickhack_shared/catalog/product-criteria";
import {
  InventoryEditField,
  InventoryEditSection,
  type InventoryEditFieldProps,
  type InventoryEditOption,
} from "@/quickhack_client/components/inventory/inventory-edit-fields";
import {
  inventoryCorrectionFieldKey,
  inventoryCorrectionValue,
  type EditableInventoryCorrectionGroup,
} from "@/quickhack_client/components/inventory/inventory-correction-changes";
import {
  APPEARANCE_INSPECTION_EVIDENCE_KEYS,
  APPEARANCE_INSPECTION_FIELD_KEYS,
  FUNCTION_INSPECTION_EVIDENCE_KEYS,
  FUNCTION_INSPECTION_FIELD_KEYS,
  filterInspectionRecords,
  detailFieldLabel,
  inspectionResultLabel,
  inspectionTypeLabel,
  statusLabel,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  INSPECTION_RESULT,
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";

const DEVICE_SALE_GRADE_OPTIONS = ["A", "A-", "B+", "B"];

function optionList(values: readonly string[]): InventoryEditOption[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((value) => ({ value, label: value }));
}

const WARRANTY_EDIT_OPTIONS = optionList(DEVICE_WARRANTY_OPTIONS);
const SALE_GRADE_EDIT_OPTIONS = optionList(DEVICE_SALE_GRADE_OPTIONS);

type InventoryStatusOptions = {
  inbound: InventoryEditOption[];
  inventory: InventoryEditOption[];
  inspectionType: InventoryEditOption[];
  inspectionResult: InventoryEditOption[];
};

function detailFieldValueMapKey(recordId: string, fieldKey: string) {
  return `${recordId}\u0000${fieldKey}`;
}

function buildOriginalDetailValueMap(records: DetailRecord[] | undefined) {
  const values = new Map<string, string>();

  for (const record of records ?? []) {
    for (const field of record.fields) {
      values.set(
        detailFieldValueMapKey(record.id, field.key),
        inventoryCorrectionValue(field.value)
      );
    }
  }

  return values;
}

function originalDetailFieldValue(
  originalFieldValues: Map<string, string> | undefined,
  recordId: string,
  fieldKey: string
) {
  return originalFieldValues?.get(detailFieldValueMapKey(recordId, fieldKey)) ?? "";
}

export type InventoryCorrectionOptionSets = {
  models: InventoryEditOption[];
  modelCodes: InventoryEditOption[];
  storages: InventoryEditOption[];
  colors: InventoryEditOption[];
};

function mergedOptionValues(...groups: Array<Array<string | null | undefined>>) {
  const values = new Set<string>();

  for (const group of groups) {
    for (const value of group) {
      const normalizedValue = value?.trim();

      if (normalizedValue) {
        values.add(normalizedValue);
      }
    }
  }

  return Array.from(values);
}

function productModelOptionsFromCriteria(
  criteria: ProductCriteriaPayload | null
) {
  if (!criteria) {
    return [];
  }

  return optionList(
    criteria.rawOptions
      .filter(
        (option) =>
          option.isActive &&
          option.category === "PRODUCT_MODEL" &&
          option.label.trim()
      )
      .map((option) => option.label)
  );
}

function productModelCodeOptionsFromCriteria(
  criteria: ProductCriteriaPayload | null
) {
  if (!criteria) {
    return [];
  }

  return criteria.rawOptions
    .filter(
      (option) =>
        option.isActive &&
        option.category === "PRODUCT_MODEL" &&
        option.optionKey.trim()
    )
    .map((option) => ({
      value: option.optionKey.trim(),
      label: `${option.optionKey.trim()} / ${option.label.trim()}`,
    }))
    .filter(
      (option, index, list) =>
        list.findIndex((current) => current.value === option.value) === index
    )
    .sort((a, b) => a.value.localeCompare(b.value, "ko"));
}

export function buildInventoryCorrectionOptionSets(
  criteria: ProductCriteriaPayload | null,
  devices: Array<
    Pick<DeviceListItem, "model" | "modelCode" | "storage" | "color">
  >
): InventoryCorrectionOptionSets {
  const modelOptions = new Map<string, InventoryEditOption>();
  const modelCodeOptions = new Map<string, InventoryEditOption>();

  for (const option of productModelOptionsFromCriteria(criteria)) {
    modelOptions.set(option.value, option);
  }

  for (const device of devices) {
    const model = device.model.trim();

    if (model && !modelOptions.has(model)) {
      modelOptions.set(model, { value: model, label: model });
    }
  }

  for (const option of productModelCodeOptionsFromCriteria(criteria)) {
    modelCodeOptions.set(option.value, option);
  }

  for (const device of devices) {
    const modelCode = device.modelCode?.trim();

    if (modelCode && !modelCodeOptions.has(modelCode)) {
      modelCodeOptions.set(modelCode, { value: modelCode, label: modelCode });
    }
  }

  return {
    models: Array.from(modelOptions.values()).sort((a, b) =>
      (a.label ?? a.value).localeCompare(b.label ?? b.value, "ko")
    ),
    modelCodes: Array.from(modelCodeOptions.values()).sort((a, b) =>
      a.value.localeCompare(b.value, "ko")
    ),
    storages: optionList(
      mergedOptionValues(
        criteria?.storages ?? [],
        devices.map((device) => device.storage)
      )
    ),
    colors: optionList(
      mergedOptionValues(
        criteria?.colors ?? [],
        devices.map((device) => device.color)
      )
    ),
  };
}

function detailRecordFieldValue(record: DetailRecord, fieldKey: string) {
  const field = record.fields.find((item) => item.key === fieldKey);
  return field ? inventoryCorrectionValue(field.value) : "";
}

function detailRecordModelValue(record: DetailRecord) {
  return detailRecordFieldValue(record, "model");
}

function inventoryEditFieldEditor({
  criteria,
  optionSets,
  record,
  fieldKey,
  criteriaPlaceholder,
  statusOptions,
}: {
  criteria: ProductCriteriaPayload | null;
  optionSets: InventoryCorrectionOptionSets;
  record: DetailRecord;
  fieldKey: string;
  criteriaPlaceholder: string;
  statusOptions: InventoryStatusOptions;
}): Pick<
  InventoryEditFieldProps,
  "mode" | "options" | "allowEmpty" | "placeholder"
> {
  switch (fieldKey) {
    case "first_call_date":
      return { mode: "date" };
    case "received_at":
    case "price_agreed_at":
    case "stocked_at":
    case "checked_at":
    case "appearance_checked_at":
    case "function_checked_at":
      return { mode: "datetime-local" };
    case "inbound_status":
      return {
        mode: "select",
        options: statusOptions.inbound,
        allowEmpty: false,
      };
    case "inventory_status":
      return {
        mode: "select",
        options: statusOptions.inventory,
        allowEmpty: false,
      };
    case "inspection_type":
      return {
        mode: "select",
        options: statusOptions.inspectionType,
        allowEmpty: false,
      };
    case "inspection_result":
      return {
        mode: "select",
        options: statusOptions.inspectionResult,
        allowEmpty: true,
      };
    case "sale_grade":
      return {
        mode: "select",
        options: SALE_GRADE_EDIT_OPTIONS,
        allowEmpty: true,
      };
    case "warranty":
      return {
        mode: "select",
        options: WARRANTY_EDIT_OPTIONS,
        allowEmpty: true,
      };
    case "model":
      return {
        mode: "datalist",
        options: optionSets.models,
        allowEmpty: false,
        placeholder: criteriaPlaceholder,
      };
    case "model_code":
      return {
        mode: "datalist",
        options: optionSets.modelCodes,
        allowEmpty: true,
        placeholder: criteriaPlaceholder,
      };
    case "storage": {
      const model = detailRecordModelValue(record);
      const scopedStorages = criteria
        ? getStorageOptionsForProduct(criteria, model)
        : [];

      return {
        mode: "datalist",
        options:
          scopedStorages.length > 0 ? optionList(scopedStorages) : optionSets.storages,
        allowEmpty: true,
        placeholder: criteriaPlaceholder,
      };
    }
    case "color":
      return {
        mode: "datalist",
        options: optionSets.colors,
        allowEmpty: true,
        placeholder: criteriaPlaceholder,
      };
    default:
      return {};
  }
}

function InventoryEditableRecordFields({
  group,
  title,
  records,
  originalFieldValues,
  changedFieldKeys,
  criteria,
  optionSets,
  empty,
  onFieldChange,
  onDraftFieldChange,
}: {
  group: EditableInventoryCorrectionGroup | null;
  title: string;
  records: DetailRecord[];
  originalFieldValues?: Map<string, string>;
  changedFieldKeys: ReadonlySet<string>;
  criteria: ProductCriteriaPayload | null;
  optionSets: InventoryCorrectionOptionSets;
  empty: string;
  onFieldChange: (recordId: string, fieldKey: string, value: string) => void;
  onDraftFieldChange: (
    group: EditableInventoryCorrectionGroup,
    recordId: string,
    fieldKey: string,
    value: string | null,
    isChanged: boolean
  ) => void;
}) {
  const t = useTranslations("inventory.correctionRecords");
  const detailT = useTranslations("common.deviceDetail");
  const statusOptions = React.useMemo<InventoryStatusOptions>(() => ({
    inbound: Object.values(INBOUND_STATUS).map((value) => ({
      value,
      label: statusLabel(value, detailT),
    })),
    inventory: Object.values(INVENTORY_STATUS).map((value) => ({
      value,
      label: statusLabel(value, detailT),
    })),
    inspectionType: Object.values(INSPECTION_TYPE).map((value) => ({
      value,
      label: inspectionTypeLabel(value, detailT),
    })),
    inspectionResult: Object.values(INSPECTION_RESULT).map((value) => ({
      value,
      label: inspectionResultLabel(value, detailT),
    })),
  }), [detailT]);
  const handleFieldChange = React.useCallback(
    (value: string, recordId?: string, fieldKey?: string) => {
      if (!recordId || !fieldKey) {
        return;
      }
      if (!group) {
        return;
      }

      onFieldChange(recordId, fieldKey, value);
    },
    [group, onFieldChange]
  );
  const handleDraftChange = React.useCallback(
    (
      value: string | null,
      isChanged: boolean,
      recordId?: string,
      fieldKey?: string
    ) => {
      if (!group || !recordId || !fieldKey) {
        return;
      }

      onDraftFieldChange(
        group,
        recordId,
        fieldKey,
        value,
        isChanged
      );
    },
    [group, onDraftFieldChange]
  );

  if (records.length === 0) {
    return (
      <InventoryEditSection title={title}>
        <InventoryEditField
          label={t("status")}
          value={empty}
          readOnly
          onChange={() => undefined}
        />
      </InventoryEditSection>
    );
  }

  return (
    <>
      {records.map((record, index) => (
        <InventoryEditSection
          key={record.id}
          title={`${title}${records.length > 1 ? ` ${index + 1}` : ""}`}
        >
          {record.fields.map((field) => (
            <InventoryEditField
              key={`${record.id}-${field.key}`}
              recordId={record.id}
              fieldKey={field.key}
              label={detailFieldLabel(field.key, detailT)}
              value={inventoryCorrectionValue(field.value)}
              readOnly={field.readOnly}
              {...inventoryEditFieldEditor({
                criteria,
                optionSets,
                record,
                fieldKey: field.key,
                criteriaPlaceholder: t("criteriaPlaceholder"),
                statusOptions,
              })}
              isChanged={
                !field.readOnly &&
                Boolean(
                  group &&
                    changedFieldKeys.has(
                      inventoryCorrectionFieldKey(group, record.id, field.key)
                    )
                )
              }
              originalValue={originalDetailFieldValue(
                originalFieldValues,
                record.id,
                field.key
              )}
              onChange={handleFieldChange}
              onDraftChange={handleDraftChange}
            />
          ))}
        </InventoryEditSection>
      ))}
    </>
  );
}

export function InventoryRelatedRecordFields({
  records,
  originalRecords,
  changedFieldKeys,
  criteria,
  optionSets,
  onFieldChange,
  onDraftFieldChange,
}: {
  records: DeviceDetailRecords;
  originalRecords?: DeviceDetailRecords;
  changedFieldKeys: ReadonlySet<string>;
  criteria: ProductCriteriaPayload | null;
  optionSets: InventoryCorrectionOptionSets;
  onFieldChange: (
    group: keyof DeviceDetailRecords,
    recordId: string,
    fieldKey: string,
    value: string
  ) => void;
  onDraftFieldChange: (
    group: EditableInventoryCorrectionGroup,
    recordId: string,
    fieldKey: string,
    value: string | null,
    isChanged: boolean
  ) => void;
}) {
  const t = useTranslations("inventory.correctionRecords");
  const originalDeviceRecords = originalRecords?.devices;
  const originalInboundRecords = originalRecords?.inbounds;
  const originalInventoryRecords = originalRecords?.inventory;
  const originalInspectionRecords = originalRecords?.inspections;
  const originalOrderItemRecords = originalRecords?.orderItems;
  const originalChannelOrderMatchRecords = originalRecords?.channelOrderMatches;
  const functionInspectionRecords = React.useMemo(
    () =>
      filterInspectionRecords(
        records.inspections,
        FUNCTION_INSPECTION_FIELD_KEYS,
        FUNCTION_INSPECTION_EVIDENCE_KEYS
      ),
    [records.inspections]
  );
  const originalFunctionInspectionRecords = React.useMemo(
    () =>
      originalInspectionRecords
        ? filterInspectionRecords(
            originalInspectionRecords,
            FUNCTION_INSPECTION_FIELD_KEYS,
            FUNCTION_INSPECTION_EVIDENCE_KEYS
          )
        : undefined,
    [originalInspectionRecords]
  );
  const appearanceInspectionRecords = React.useMemo(
    () =>
      filterInspectionRecords(
        records.inspections,
        APPEARANCE_INSPECTION_FIELD_KEYS,
        APPEARANCE_INSPECTION_EVIDENCE_KEYS
      ),
    [records.inspections]
  );
  const originalAppearanceInspectionRecords = React.useMemo(
    () =>
      originalInspectionRecords
        ? filterInspectionRecords(
            originalInspectionRecords,
            APPEARANCE_INSPECTION_FIELD_KEYS,
            APPEARANCE_INSPECTION_EVIDENCE_KEYS
          )
        : undefined,
    [originalInspectionRecords]
  );
  const originalFieldValues = React.useMemo(
    () => ({
      devices: buildOriginalDetailValueMap(originalDeviceRecords),
      inbounds: buildOriginalDetailValueMap(originalInboundRecords),
      inventory: buildOriginalDetailValueMap(originalInventoryRecords),
      functionInspections: buildOriginalDetailValueMap(
        originalFunctionInspectionRecords
      ),
      appearanceInspections: buildOriginalDetailValueMap(
        originalAppearanceInspectionRecords
      ),
      orderItems: buildOriginalDetailValueMap(originalOrderItemRecords),
      channelOrderMatches: buildOriginalDetailValueMap(
        originalChannelOrderMatchRecords
      ),
    }),
    [
      originalAppearanceInspectionRecords,
      originalChannelOrderMatchRecords,
      originalDeviceRecords,
      originalFunctionInspectionRecords,
      originalInboundRecords,
      originalInventoryRecords,
      originalOrderItemRecords,
    ]
  );
  const handleDeviceFieldChange = React.useCallback(
    (recordId: string, fieldKey: string, value: string) =>
      onFieldChange("devices", recordId, fieldKey, value),
    [onFieldChange]
  );
  const handleInboundFieldChange = React.useCallback(
    (recordId: string, fieldKey: string, value: string) =>
      onFieldChange("inbounds", recordId, fieldKey, value),
    [onFieldChange]
  );
  const handleInventoryFieldChange = React.useCallback(
    (recordId: string, fieldKey: string, value: string) =>
      onFieldChange("inventory", recordId, fieldKey, value),
    [onFieldChange]
  );
  const handleInspectionFieldChange = React.useCallback(
    (recordId: string, fieldKey: string, value: string) =>
      onFieldChange("inspections", recordId, fieldKey, value),
    [onFieldChange]
  );
  const handleOrderItemFieldChange = React.useCallback(
    (recordId: string, fieldKey: string, value: string) =>
      onFieldChange("orderItems", recordId, fieldKey, value),
    [onFieldChange]
  );
  const handleChannelOrderMatchFieldChange = React.useCallback(
    (recordId: string, fieldKey: string, value: string) =>
      onFieldChange("channelOrderMatches", recordId, fieldKey, value),
    [onFieldChange]
  );

  return (
    <>
      <InventoryEditableRecordFields
        group="devices"
        title={t("sections.device")}
        empty={t("empty.device")}
        records={records.devices}
        originalFieldValues={originalFieldValues.devices}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleDeviceFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
      <InventoryEditableRecordFields
        group="inbounds"
        title={t("sections.inbound")}
        empty={t("empty.inbound")}
        records={records.inbounds}
        originalFieldValues={originalFieldValues.inbounds}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleInboundFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
      <InventoryEditableRecordFields
        group="inventory"
        title={t("sections.inventory")}
        empty={t("empty.inventory")}
        records={records.inventory}
        originalFieldValues={originalFieldValues.inventory}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleInventoryFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
      <InventoryEditableRecordFields
        group="inspections"
        title={t("sections.functionInspection")}
        empty={t("empty.functionInspection")}
        records={functionInspectionRecords}
        originalFieldValues={originalFieldValues.functionInspections}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleInspectionFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
      <InventoryEditableRecordFields
        group="inspections"
        title={t("sections.appearanceInspection")}
        empty={t("empty.appearanceInspection")}
        records={appearanceInspectionRecords}
        originalFieldValues={originalFieldValues.appearanceInspections}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleInspectionFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
      <InventoryEditableRecordFields
        group={null}
        title={t("sections.order")}
        empty={t("empty.order")}
        records={records.orderItems}
        originalFieldValues={originalFieldValues.orderItems}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleOrderItemFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
      <InventoryEditableRecordFields
        group={null}
        title={t("sections.channelMatch")}
        empty={t("empty.channelMatch")}
        records={records.channelOrderMatches}
        originalFieldValues={originalFieldValues.channelOrderMatches}
        changedFieldKeys={changedFieldKeys}
        criteria={criteria}
        optionSets={optionSets}
        onFieldChange={handleChannelOrderMatchFieldChange}
        onDraftFieldChange={onDraftFieldChange}
      />
    </>
  );
}
