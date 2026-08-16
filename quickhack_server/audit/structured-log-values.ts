type StructuredLogField = {
  fieldName: string;
  beforeValue?: string | null;
  afterValue?: string | null;
  fieldValue?: string | null;
};

export type ExplicitActivityLogChange = {
  fieldName: string;
  beforeValue: string | null;
  afterValue: string | null;
};

const MAX_DEPTH = 3;
const MAX_FIELDS = 80;
const MAX_VALUE_LENGTH = 500;

function scalarText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH
      ? `${value.slice(0, MAX_VALUE_LENGTH)}...`
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const scalarItems = value
      .filter((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 12)
      .map((item) => String(item ?? ""));

    return scalarItems.length === value.length
      ? scalarItems.join(", ")
      : `list(${value.length})`;
  }

  if (typeof value === "object") {
    return `object(${Object.keys(value as Record<string, unknown>).length})`;
  }

  return String(value);
}

function flattenValue(
  value: unknown,
  prefix = "value",
  depth = 0,
  output: Array<{ fieldName: string; value: string | null }> = []
) {
  if (output.length >= MAX_FIELDS) {
    return output;
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    depth < MAX_DEPTH
  ) {
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length === 0) {
      output.push({ fieldName: prefix, value: "object(0)" });
      return output;
    }

    for (const [key, child] of entries) {
      flattenValue(child, prefix === "value" ? key : `${prefix}.${key}`, depth + 1, output);

      if (output.length >= MAX_FIELDS) {
        break;
      }
    }

    return output;
  }

  output.push({
    fieldName: prefix,
    value: scalarText(value),
  });

  return output;
}

function fieldMap(value: unknown) {
  const map = new Map<string, string | null>();

  for (const item of flattenValue(value)) {
    map.set(item.fieldName, item.value);
  }

  return map;
}

function summarizeValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value !== "object" || value instanceof Date) {
    return scalarText(value) ?? "";
  }

  if (Array.isArray(value)) {
    return `list(${value.length})`;
  }

  return Object.keys(value as Record<string, unknown>).slice(0, 10).join(", ");
}

function assertNoObjectArray(value: unknown, path = "value"): void {
  if (Array.isArray(value)) {
    if (
      value.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          !(item instanceof Date)
      )
    ) {
      throw new Error(
        `activityLogChangeData cannot serialize object arrays at ${path}; use explicitActivityLogChangeData or a dedicated audit ledger.`
      );
    }

    return;
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoObjectArray(child, path === "value" ? key : `${path}.${key}`);
    }
  }
}

export function activityLogChangeData(beforeValue: unknown, afterValue: unknown) {
  assertNoObjectArray(beforeValue, "before");
  assertNoObjectArray(afterValue, "after");
  const before = fieldMap(beforeValue);
  const after = fieldMap(afterValue);
  const fieldNames = Array.from(new Set([...before.keys(), ...after.keys()])).slice(
    0,
    MAX_FIELDS
  );
  const changes = fieldNames
    .map((fieldName) => ({
      field_name: fieldName,
      before_value: before.get(fieldName) ?? null,
      after_value: after.get(fieldName) ?? null,
    }))
    .filter((change) => change.before_value !== change.after_value);

  return {
    before_summary_text: summarizeValue(beforeValue),
    after_summary_text: summarizeValue(afterValue),
    changes: changes.length > 0 ? { create: changes } : undefined,
  };
}

export function explicitActivityLogChangeData(
  changes: readonly ExplicitActivityLogChange[],
  input: { beforeSummary: string; afterSummary: string }
) {
  const seen = new Set<string>();
  const rows = changes.map((change) => {
    const fieldName = change.fieldName.trim();
    if (!fieldName || seen.has(fieldName)) {
      throw new Error(`Duplicate or empty activity log field: ${fieldName}`);
    }
    seen.add(fieldName);
    return {
      field_name: fieldName,
      before_value: change.beforeValue,
      after_value: change.afterValue,
    };
  });
  return {
    before_summary_text: input.beforeSummary,
    after_summary_text: input.afterSummary,
    changes: rows.length > 0 ? { create: rows } : undefined,
  };
}

type SupplyMasterAuditInput = {
  supplyCode: string;
  supplyName: string;
  category: string;
  baseUnit: string;
  orderUnit: string;
  orderUnitQuantity: number;
  minimumOrderQuantity: number;
  defaultSupplierName: string | null;
  unitCost: number | null;
  leadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
  lossRatePercent: number;
  safetyStockDays: number;
  targetStockDays: number;
  outboundConsumptionPolicy: string;
  isActive: boolean;
  note: string | null;
  reservedQuantity: number;
  inventoryLocation: string | null;
};

export function supplyMasterAuditSnapshot(input: SupplyMasterAuditInput) {
  return {
    supply: {
      supplyCode: input.supplyCode,
      supplyName: input.supplyName,
      category: input.category,
      baseUnit: input.baseUnit,
      orderUnit: input.orderUnit,
      orderUnitQuantity: input.orderUnitQuantity,
      minimumOrderQuantity: input.minimumOrderQuantity,
      defaultSupplierName: input.defaultSupplierName,
      unitCost: input.unitCost,
      leadTimeDays: input.leadTimeDays,
      minLeadTimeDays: input.minLeadTimeDays,
      maxLeadTimeDays: input.maxLeadTimeDays,
      lossRatePercent: input.lossRatePercent,
      safetyStockDays: input.safetyStockDays,
      targetStockDays: input.targetStockDays,
      outboundConsumptionPolicy: input.outboundConsumptionPolicy,
      isActive: input.isActive,
      note: input.note,
    },
    inventorySettings: {
      reservedQuantity: input.reservedQuantity,
      inventoryLocation: input.inventoryLocation,
    },
  };
}

export function supplyMovementAuditSnapshot(currentQuantity: number) {
  return { currentQuantity };
}

export function structuredLogFields(
  groupName: string,
  value: unknown
): StructuredLogField[] {
  return flattenValue(value).map((field) => ({
    fieldName: `${groupName}.${field.fieldName}`,
    fieldValue: field.value,
  }));
}

function countByKeys(value: unknown, keys: readonly string[], depth = 0): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > MAX_DEPTH) {
    return null;
  }

  const record = value as Record<string, unknown>;
  let total = 0;
  let found = false;

  for (const key of keys) {
    const raw = Number(record[key]);

    if (Number.isFinite(raw) && raw >= 0) {
      total += Math.trunc(raw);
      found = true;
    }
  }

  for (const child of Object.values(record)) {
    const count = countByKeys(child, keys, depth + 1);

    if (count !== null) {
      total += count;
      found = true;
    }
  }

  return found ? total : null;
}

export function serverJobLogSummaryData(input: {
  summary?: unknown;
  summaryText?: string;
  rawContext?: unknown;
}) {
  const processed = countByKeys(input.summary, [
    "processedCount",
    "processedItemCount",
    "scanned",
    "orders",
    "returns",
    "exchanges",
  ]);
  const succeeded = countByKeys(input.summary, [
    "succeededCount",
    "successCount",
    "matchedDeviceCount",
    "fullyMatchedItemCount",
  ]);
  const failed = countByKeys(input.summary, [
    "failedCount",
    "failureCount",
    "errorCount",
  ]);
  const skipped = countByKeys(input.summary, ["skippedCount"]);
  const created = countByKeys(input.summary, ["createdCount"]);
  const updated = countByKeys(input.summary, ["updated", "updatedCount"]);
  const warning = countByKeys(input.summary, [
    "warningCount",
    "conflictCount",
    "addressRefreshFailedCount",
  ]);
  const parts = [
    processed !== null ? `processed=${processed}` : null,
    succeeded !== null ? `succeeded=${succeeded}` : null,
    failed !== null ? `failed=${failed}` : null,
    skipped !== null ? `skipped=${skipped}` : null,
    created !== null ? `created=${created}` : null,
    updated !== null ? `updated=${updated}` : null,
    warning !== null ? `warning=${warning}` : null,
  ].filter((part): part is string => Boolean(part));
  const detailFields = [
    ...structuredLogFields("summary", input.summary),
    ...structuredLogFields("context", input.rawContext),
  ].slice(0, MAX_FIELDS);

  return {
    summary_text:
      input.summaryText?.trim() ||
      (parts.length > 0 ? parts.join(" / ") : summarizeValue(input.summary)),
    summary_processed_count: processed,
    summary_succeeded_count: succeeded,
    summary_failed_count: failed,
    summary_skipped_count: skipped,
    summary_created_count: created,
    summary_updated_count: updated,
    summary_warning_count: warning,
    fields:
      detailFields.length > 0
        ? {
            create: detailFields.map((field) => ({
              field_name: field.fieldName,
              field_value: field.fieldValue ?? null,
            })),
          }
        : undefined,
  };
}
