// QuickHack note: 비품 재고 수량 이력, 소요예측, 재구매 추천 계산을 담당합니다.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  OUTBOUND_SUPPLY_CONSUMPTION_POLICY,
  SUPPLY_CONSUMPTION_TRIGGER,
  SUPPLY_CONSUMPTION_RULE_FILTER,
  SUPPLY_MOVEMENT_TYPE,
  SUPPLY_REORDER_STATUS,
  normalizeSupplyConsumptionQuantity,
  supplyConsumptionTriggerSupportsFilter,
  type SupplyConsumptionTrigger,
  type SupplyConsumptionRuleFilter,
  type SupplyMovementType,
  type OutboundSupplyConsumptionPolicy,
  type SupplyReorderStatus,
} from "@/quickhack_shared/supplies/supplies";
import {
  formatKstDate,
  nowKstSqlDateTime,
  parseKstSqlDateTime as parseSharedKstDateTime,
  quickHackClock,
  type DateTimeInput,
} from "@/quickhack_shared/core/time";
import {
  activityLogChangeData,
  supplyMasterAuditSnapshot,
  supplyMovementAuditSnapshot,
} from "@/quickhack_server/audit/structured-log-values";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  KeysetCursorError,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  insertOrObserve,
  lockAggregateKey,
} from "@/quickhack_server/core/database/aggregate-command";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS,
  isOutboundSupplyConsumptionTrigger,
  outboundSupplyConsumptionRulesOverlap,
} from "@/quickhack_server/supplies/supply-consumption-rule-matching";
import { warrantyGroupLabel } from "@/quickhack_shared/sales-channel/sales-matching";

const DEFAULT_LOOKBACK_DAYS = 30;
const REORDER_HISTORY_CURSOR_CONTRACT = "supply-reorder-history-v1";
const REORDER_HISTORY_DEFAULT_LIMIT = 80;
const REORDER_HISTORY_MAX_LIMIT = 100;
const PACKING_COMPLETED_SOURCE_TYPE = "INVENTORY_AUDIT_PACKING_COMPLETED";
const SHIPMENT_TRIGGER_ALLOCATION_STATUSES = ["SHIPMENT_LIST_PRINTED"] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OPEN_REORDER_STATUSES: SupplyReorderStatus[] = [
  SUPPLY_REORDER_STATUS.suggested,
  SUPPLY_REORDER_STATUS.requested,
  SUPPLY_REORDER_STATUS.approved,
  SUPPLY_REORDER_STATUS.ordered,
];
function supplyForecastCalculationFields(calculation: Record<string, unknown>) {
  return Object.entries(calculation).map(([fieldName, value]) => ({
    field_name: fieldName,
    field_value: value === null || value === undefined ? null : String(value),
  }));
}

type SupplyInput = Record<string, unknown>;
type TransactionClient = Prisma.TransactionClient;

function isUniqueConflict(error: unknown) {
  return isPostgresqlUniqueViolation(error);
}

function supplyReorderReceiptIdempotencyKey(reorderRequestId: number) {
  return `supply:reorder:${reorderRequestId}:receipt`;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const valueText = text(value);
  return valueText || null;
}

type SupplyRuleFilters = Record<SupplyConsumptionRuleFilter, string | null>;

function validateSupplyRuleFilters(
  trigger: SupplyConsumptionTrigger,
  filters: SupplyRuleFilters
) {
  const unsupportedFilters = Object.values(SUPPLY_CONSUMPTION_RULE_FILTER).filter(
    (filter) =>
      Boolean(filters[filter]) &&
      !supplyConsumptionTriggerSupportsFilter(trigger, filter)
  );

  if (unsupportedFilters.length === 0) {
    return;
  }

  throw publicBadRequest(
    "UNSUPPORTED_SUPPLY_RULE_FILTER",
    "UNSUPPORTED_SUPPLY_RULE_FILTER",
    {
      triggerType: trigger,
      unsupportedFilters,
    }
  );
}

function integer(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0) {
  return Math.max(0, integer(value, fallback));
}

function positiveInteger(value: unknown, label: string) {
  const number = integer(value, 0);

  if (number <= 0) {
    throw publicBadRequest(
      "INVALID_SUPPLY_POSITIVE_INTEGER",
      "INVALID_SUPPLY_POSITIVE_INTEGER"
    );
  }

  return number;
}

function strictMovementInteger(value: unknown) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  ) {
    return null;
  }

  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function strictNonNegativeInteger(value: unknown, label: string) {
  const number = strictMovementInteger(value);

  if (number === null || number < 0) {
    throw publicBadRequest(
      "INVALID_SUPPLY_NON_NEGATIVE_INTEGER",
      "INVALID_SUPPLY_NON_NEGATIVE_INTEGER"
    );
  }

  return number;
}

function strictPositiveMovementInteger(value: unknown, label: string) {
  const number = strictMovementInteger(value);

  if (number === null || number <= 0) {
    throw publicBadRequest(
      "INVALID_SUPPLY_POSITIVE_INTEGER",
      "INVALID_SUPPLY_POSITIVE_INTEGER"
    );
  }

  return number;
}

function roundedPositiveInteger(value: unknown, label: string) {
  const number = normalizeSupplyConsumptionQuantity(value);

  if (number === null) {
    throw publicBadRequest(
      "INVALID_SUPPLY_POSITIVE_INTEGER",
      "INVALID_SUPPLY_POSITIVE_INTEGER"
    );
  }

  return number;
}

function idFromBody(input: SupplyInput, key: string) {
  const id = integer(input[key], 0);
  return id > 0 ? id : null;
}

function optionalMovementId(
  input: SupplyInput,
  key: string,
  label: string
) {
  const value = input[key];
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  ) {
    return null;
  }

  const id = strictMovementInteger(value);
  if (id === null || id <= 0) {
    throw publicBadRequest(
      "INVALID_SUPPLY_MOVEMENT_REFERENCE_ID",
      "INVALID_SUPPLY_MOVEMENT_REFERENCE_ID"
    );
  }

  return id;
}

function requiredExpectedRevision(input: SupplyInput, label: string) {
  const rawRevision = input.expectedRevision;
  const revision = Number(rawRevision);

  if (
    rawRevision === null ||
    rawRevision === undefined ||
    rawRevision === "" ||
    typeof rawRevision === "boolean" ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    throw publicBadRequest(
      "SUPPLY_REVISION_REQUIRED",
      "SUPPLY_REVISION_REQUIRED"
    );
  }

  return revision;
}

function supplyMasterSnapshot(
  row: Prisma.suppliesGetPayload<{ include: { inventory: true } }>
) {
  return supplyMasterAuditSnapshot({
    supplyCode: row.supply_code,
    supplyName: row.supply_name,
    category: row.category,
    baseUnit: row.base_unit,
    orderUnit: row.order_unit,
    orderUnitQuantity: row.order_unit_quantity,
    minimumOrderQuantity: row.minimum_order_quantity,
    defaultSupplierName: row.default_supplier_name,
    unitCost: row.unit_cost,
    leadTimeDays: row.lead_time_days,
    minLeadTimeDays: row.min_lead_time_days,
    maxLeadTimeDays: row.max_lead_time_days,
    lossRatePercent: Number(row.loss_rate_percent),
    safetyStockDays: row.safety_stock_days,
    targetStockDays: row.target_stock_days,
    outboundConsumptionPolicy: row.outbound_consumption_policy,
    isActive: row.is_active === 1,
    note: row.note,
    reservedQuantity: row.inventory?.reserved_quantity ?? 0,
    inventoryLocation: row.inventory?.inventory_location ?? null,
  });
}

function sqlDateDaysAfter(
  periodTo: Exclude<DateTimeInput, null | undefined>,
  days: number
) {
  return addDaysToSqlDateTime(periodTo, Math.max(0, Math.ceil(days))).slice(
    0,
    10
  );
}

function sqlDateFromDateTime(value: DateTimeInput) {
  if (value instanceof Date) {
    return formatKstDate(value);
  }

  return String(value ?? "").slice(0, 10);
}

function parseKstSqlDateTime(value: DateTimeInput) {
  const parsed = parseSharedKstDateTime(value);

  if (!parsed) {
    throw new TypeError("Expected a valid supply timestamp.");
  }

  return parsed;
}

function addDaysToSqlDateTime(value: DateTimeInput, days: number) {
  return nowKstSqlDateTime(
    new Date(parseKstSqlDateTime(value).getTime() + days * MS_PER_DAY)
  );
}

function wholeDaysBetweenSqlDateTimes(from: DateTimeInput, to: DateTimeInput) {
  return Math.max(
    0,
    Math.floor(
      (parseKstSqlDateTime(to).getTime() - parseKstSqlDateTime(from).getTime()) /
        MS_PER_DAY
    )
  );
}

function dateKeyToUtcDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function utcDateToDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDaysToDateKey(value: string, days: number) {
  const date = dateKeyToUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateToDateKey(date);
}

function compareDateKey(left: string, right: string) {
  return left.localeCompare(right);
}

function maxDateKey(left: string, right: string) {
  return compareDateKey(left, right) >= 0 ? left : right;
}

function minDateKey(left: string, right: string) {
  return compareDateKey(left, right) <= 0 ? left : right;
}

function lookbackUsageMap(
  lookbackDays: number,
  periodTo: Exclude<DateTimeInput, null | undefined>
) {
  const usageByDate = new Map<string, number>();

  for (let index = 0; index < lookbackDays; index += 1) {
    usageByDate.set(
      sqlDateFromDateTime(addDaysToSqlDateTime(periodTo, -index)),
      0
    );
  }

  return usageByDate;
}

function periodUsageMap(
  periodFrom: Exclude<DateTimeInput, null | undefined>,
  periodTo: Exclude<DateTimeInput, null | undefined>
) {
  const usageByDate = new Map<string, number>();
  const fromKey = sqlDateFromDateTime(periodFrom);
  const toKey = sqlDateFromDateTime(periodTo);

  for (
    let dateKey = fromKey;
    compareDateKey(dateKey, toKey) <= 0;
    dateKey = addDaysToDateKey(dateKey, 1)
  ) {
    usageByDate.set(dateKey, 0);
  }

  return usageByDate;
}

function addUsage(usageByDate: Map<string, number>, dateKey: string, quantity: number) {
  if (!usageByDate.has(dateKey)) {
    return;
  }

  usageByDate.set(dateKey, (usageByDate.get(dateKey) ?? 0) + quantity);
}

function distributeUsage(
  usageByDate: Map<string, number>,
  periodFrom: DateTimeInput,
  periodTo: DateTimeInput,
  quantity: number
) {
  const originalFromKey = sqlDateFromDateTime(periodFrom);
  const originalToKey = sqlDateFromDateTime(periodTo);
  const originalDateKeys = [];

  for (
    let dateKey = originalFromKey;
    compareDateKey(dateKey, originalToKey) <= 0;
    dateKey = addDaysToDateKey(dateKey, 1)
  ) {
    originalDateKeys.push(dateKey);
  }

  const sortedUsageKeys = [...usageByDate.keys()].sort();
  const fromKey = maxDateKey(originalFromKey, sortedUsageKeys[0]);
  const toKey = minDateKey(
    originalToKey,
    sortedUsageKeys.at(-1) ?? originalToKey
  );

  if (compareDateKey(fromKey, toKey) > 0) {
    return;
  }

  const dateKeys = [];
  for (let dateKey = fromKey; compareDateKey(dateKey, toKey) <= 0; dateKey = addDaysToDateKey(dateKey, 1)) {
    dateKeys.push(dateKey);
  }

  const quantityPerDay = safeDivide(quantity, originalDateKeys.length);

  for (const dateKey of dateKeys) {
    addUsage(usageByDate, dateKey, quantityPerDay);
  }
}

function safeDivide(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function stddev(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;

  return Math.sqrt(variance);
}

function roundUpToOrderUnit(quantity: number, orderUnitQuantity: number, minimum: number) {
  if (quantity <= 0) {
    return 0;
  }

  const unit = Math.max(1, orderUnitQuantity);
  const baseQuantity = Math.max(quantity, minimum || 0);

  return Math.ceil(baseQuantity / unit) * unit;
}

function movementType(value: unknown): SupplyMovementType {
  const normalized = text(value).toUpperCase();

  if (
    Object.values(SUPPLY_MOVEMENT_TYPE).includes(
      normalized as SupplyMovementType
    )
  ) {
    return normalized as SupplyMovementType;
  }

  throw publicBadRequest(
    "INVALID_SUPPLY_MOVEMENT_TYPE",
    "INVALID_SUPPLY_MOVEMENT_TYPE"
  );
}

function supplyMovementOperationId(value: unknown) {
  const operationId = typeof value === "string" ? value.trim() : "";

  if (!operationId) {
    throw publicBadRequest(
      "SUPPLY_MOVEMENT_OPERATION_ID_REQUIRED",
      "SUPPLY_MOVEMENT_OPERATION_ID_REQUIRED"
    );
  }

  if (
    operationId.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(operationId)
  ) {
    throw publicBadRequest(
      "INVALID_SUPPLY_MOVEMENT_OPERATION_ID",
      "INVALID_SUPPLY_MOVEMENT_OPERATION_ID"
    );
  }

  return operationId;
}

function triggerType(value: unknown): SupplyConsumptionTrigger {
  const normalized = text(value).toUpperCase();

  if (
    Object.values(SUPPLY_CONSUMPTION_TRIGGER).includes(
      normalized as SupplyConsumptionTrigger
    )
  ) {
    return normalized as SupplyConsumptionTrigger;
  }

  throw publicBadRequest(
    "INVALID_SUPPLY_CONSUMPTION_TRIGGER",
    "INVALID_SUPPLY_CONSUMPTION_TRIGGER"
  );
}

function outboundConsumptionPolicy(
  value: unknown
): OutboundSupplyConsumptionPolicy {
  const policy = text(value) || OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly;

  if (
    !Object.values(OUTBOUND_SUPPLY_CONSUMPTION_POLICY).includes(
      policy as OutboundSupplyConsumptionPolicy
    )
  ) {
    throw publicBadRequest(
      "INVALID_SUPPLY_CONSUMPTION_POLICY",
      "INVALID_SUPPLY_CONSUMPTION_POLICY"
    );
  }

  return policy as OutboundSupplyConsumptionPolicy;
}

function reorderStatus(value: unknown): SupplyReorderStatus {
  const normalized = text(value).toUpperCase();

  if (
    Object.values(SUPPLY_REORDER_STATUS).includes(
      normalized as SupplyReorderStatus
    )
  ) {
    return normalized as SupplyReorderStatus;
  }

  throw publicBadRequest(
    "INVALID_SUPPLY_REORDER_STATUS",
    "INVALID_SUPPLY_REORDER_STATUS"
  );
}

type SupplyReorderEditableValues = {
  requestStatus: SupplyReorderStatus;
  requestedQuantity: number | null;
  orderedQuantity: number | null;
  receivedQuantity: number | null;
  expectedUnitCost: number | null;
  supplierName: string | null;
  reason: string | null;
};

function supplyReorderEditableValuesMatch(
  row: Prisma.supply_reorder_requestsGetPayload<object>,
  values: SupplyReorderEditableValues
) {
  return (
    row.request_status === values.requestStatus &&
    row.requested_quantity === values.requestedQuantity &&
    row.ordered_quantity === values.orderedQuantity &&
    row.received_quantity === values.receivedQuantity &&
    row.expected_unit_cost === values.expectedUnitCost &&
    row.supplier_name === values.supplierName &&
    row.reason === values.reason
  );
}

function supplyReorderConcurrentStateError(
  current: Prisma.supply_reorder_requestsGetPayload<object>,
  input: {
    expectedStatus: SupplyReorderStatus;
    requestedStatus: SupplyReorderStatus;
    receivedQuantity: number | null;
  }
) {
  if (
    current.request_status === SUPPLY_REORDER_STATUS.received &&
    (input.requestedStatus !== SUPPLY_REORDER_STATUS.received ||
      input.receivedQuantity !== current.received_quantity)
  ) {
    return publicConflict(
      "SUPPLY_REORDER_RECEIPT_FINALIZED",
      "SUPPLY_REORDER_RECEIPT_FINALIZED"
    );
  }

  return publicConflict(
    "SUPPLY_REORDER_STATE_CHANGED",
    "SUPPLY_REORDER_STATE_CHANGED",
    {
      expectedStatus: input.expectedStatus,
      currentStatus: current.request_status,
      requestedStatus: input.requestedStatus,
    }
  );
}

async function writeActivityLog(
  tx: TransactionClient,
  input: {
    user: { userId: number | null };
    actionType: string;
    targetType: string;
    targetId?: string | number | null;
    beforeValue?: unknown;
    afterValue?: unknown;
    afterSummaryText?: string;
    result?: string;
  }
) {
  const changeData = activityLogChangeData(input.beforeValue, input.afterValue);
  await tx.employee_activity_logs.create({
    data: {
      user_id: input.user.userId,
      action_type: input.actionType,
      target_type: input.targetType,
      target_id:
        input.targetId === undefined || input.targetId === null
          ? null
          : String(input.targetId),
      ...changeData,
      after_summary_text:
        input.afterSummaryText ?? changeData.after_summary_text,
      result: input.result ?? "SUCCESS",
      created_at: databaseNow(),
    },
  });
}

function toSupplyDto(row: Prisma.suppliesGetPayload<{
  include: {
    inventory: true;
    rules: true;
    forecasts: true;
    reorders: true;
  };
}>) {
  const currentQuantity = row.inventory?.current_quantity ?? 0;
  const reservedQuantity = row.inventory?.reserved_quantity ?? 0;

  return {
    supplyId: row.supply_id,
    revision: row.revision,
    supplyCode: row.supply_code,
    supplyName: row.supply_name,
    category: row.category,
    baseUnit: row.base_unit,
    orderUnit: row.order_unit,
    orderUnitQuantity: row.order_unit_quantity,
    minimumOrderQuantity: row.minimum_order_quantity,
    defaultSupplierName: row.default_supplier_name ?? "",
    unitCost: row.unit_cost,
    leadTimeDays: row.lead_time_days,
    minLeadTimeDays: row.min_lead_time_days,
    maxLeadTimeDays: row.max_lead_time_days,
    lossRatePercent: Number(row.loss_rate_percent),
    safetyStockDays: row.safety_stock_days,
    targetStockDays: row.target_stock_days,
    outboundConsumptionPolicy: row.outbound_consumption_policy,
    isActive: row.is_active === 1,
    note: row.note ?? "",
    currentQuantity,
    reservedQuantity,
    availableQuantity: Math.max(0, currentQuantity - reservedQuantity),
    inventoryLocation: row.inventory?.inventory_location ?? "",
    lastCountedAt: row.inventory?.last_counted_at ?? "",
    latestForecast: row.forecasts[0] ? toForecastDto(row.forecasts[0], row) : null,
    openReorders: row.reorders.map((reorder) =>
      toReorderDto(reorder, row, row.forecasts[0] ?? null)
    ),
    rules: row.rules.map(toRuleDto),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRuleDto(row: Prisma.supply_consumption_rulesGetPayload<object>) {
  return {
    ruleId: row.rule_id,
    revision: row.revision,
    supplyId: row.supply_id,
    triggerType: row.trigger_type,
    quantityPerUnit: row.quantity_per_unit,
    channel: row.channel ?? "",
    model: row.model ?? "",
    saleGrade: row.sale_grade ?? "",
    warranty: row.warranty ?? "",
    inventoryStatus: row.inventory_status ?? "",
    isActive: row.is_active === 1,
    note: row.note ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toForecastDto(
  row: Prisma.supply_forecast_snapshotsGetPayload<object>,
  supply?: { supply_name: string; base_unit: string; order_unit: string }
) {
  return {
    forecastId: row.forecast_id,
    supplyId: row.supply_id,
    supplyName: supply?.supply_name ?? "",
    baseUnit: supply?.base_unit ?? "",
    orderUnit: supply?.order_unit ?? "",
    forecastDate: row.forecast_date,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    lookbackDays: row.lookback_days,
    demandSource: row.demand_source,
    expectedUsageQuantity: row.expected_usage_quantity,
    averageDailyUsage: row.average_daily_usage,
    usageStddev: row.usage_stddev ?? 0,
    currentQuantity: row.current_quantity,
    availableQuantity: row.available_quantity,
    safetyStockQuantity: row.safety_stock_quantity,
    reorderPointQuantity: row.reorder_point_quantity,
    targetStockQuantity: row.target_stock_quantity,
    recommendedPurchaseQuantity: row.recommended_purchase_quantity,
    economicOrderQuantity: row.economic_order_quantity,
    expectedStockoutDate: row.expected_stockout_date ?? "",
    createdAt: row.created_at,
  };
}

function toReorderDto(
  row: Prisma.supply_reorder_requestsGetPayload<object>,
  supply?: { supply_name: string; base_unit: string; order_unit: string },
  latestForecast?: {
    forecast_id: number;
    recommended_purchase_quantity: number;
  } | null
) {
  const isForecastOutdated =
    row.request_status === SUPPLY_REORDER_STATUS.suggested &&
    row.forecast_id !== null &&
    (!latestForecast ||
      latestForecast.forecast_id !== row.forecast_id ||
      latestForecast.recommended_purchase_quantity <= 0);

  return {
    reorderRequestId: row.reorder_request_id,
    revision: row.revision,
    supplyId: row.supply_id,
    supplyName: supply?.supply_name ?? "",
    baseUnit: supply?.base_unit ?? "",
    orderUnit: supply?.order_unit ?? "",
    forecastId: row.forecast_id,
    isForecastOutdated,
    latestRecommendedQuantity:
      latestForecast?.recommended_purchase_quantity ?? null,
    requestStatus: row.request_status,
    recommendedQuantity: row.recommended_quantity,
    requestedQuantity: row.requested_quantity,
    orderedQuantity: row.ordered_quantity,
    receivedQuantity: row.received_quantity,
    expectedUnitCost: row.expected_unit_cost,
    supplierName: row.supplier_name ?? "",
    reason: row.reason ?? "",
    orderedAt: row.ordered_at ?? "",
    receivedAt: row.received_at ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMovementDto(
  row: Prisma.supply_stock_movementsGetPayload<{
    include: {
      supplies: true;
      users: {
        include: {
          employee_profiles: true;
        };
      };
    };
  }>
) {
  return {
    movementId: row.movement_id,
    supplyId: row.supply_id,
    supplyName: row.supplies.supply_name,
    movementType: row.movement_type,
    quantity: row.quantity,
    beforeQuantity: row.before_quantity,
    afterQuantity: row.after_quantity,
    reason: row.reason ?? "",
    sourceType: row.source_type ?? "",
    sourceId: row.source_id ?? "",
    pgNo: row.pg_no ?? "",
    shipmentId: row.shipment_id,
    orderId: row.order_id,
    createdByDisplayName:
      row.users?.employee_profiles?.display_name ?? row.users?.username ?? "",
    createdAt: row.created_at,
  };
}

export async function getSupplyWorkspaceData(
  client: PrismaClient,
  input: { reorderCursor?: string | null; reorderLimit?: unknown } = {}
) {
  const reorderLimit = normalizeKeysetLimit(input.reorderLimit, {
    defaultLimit: REORDER_HISTORY_DEFAULT_LIMIT,
    maxLimit: REORDER_HISTORY_MAX_LIMIT,
  });
  const queryIdentity = { statuses: "CLOSED" };
  let historySnapshotAt = databaseNow();
  let historyPosition: { updatedAt: string; reorderRequestId: number } | null = null;

  if (input.reorderCursor) {
    try {
      const decoded = decodeKeysetCursor<
        { snapshotAt: string },
        { updatedAt: string; reorderRequestId: number }
      >({
        cursor: input.reorderCursor,
        contract: REORDER_HISTORY_CURSOR_CONTRACT,
        queryIdentity,
      });
      historySnapshotAt = databaseDateTime(decoded.snapshot.snapshotAt);
      historyPosition = decoded.position;
    } catch (error) {
      if (error instanceof KeysetCursorError) {
        throw publicBadRequest(
          "SUPPLY_REORDER_CURSOR_INVALID",
          "SUPPLY_REORDER_CURSOR_INVALID"
        );
      }
      throw error;
    }
  }
  const historyWhere: Prisma.supply_reorder_requestsWhereInput = {
    request_status: { notIn: OPEN_REORDER_STATUSES },
    updated_at: { lte: historySnapshotAt },
    ...(historyPosition
      ? {
          OR: [
            { updated_at: { lt: databaseDateTime(historyPosition.updatedAt) } },
            {
              updated_at: databaseDateTime(historyPosition.updatedAt),
              reorder_request_id: { lt: historyPosition.reorderRequestId },
            },
          ],
        }
      : {}),
  };
  const [
    supplies,
    recentMovements,
    forecasts,
    openReorders,
    reorderHistoryRows,
    openReorderCount,
  ] = await Promise.all([
    client.supplies.findMany({
      orderBy: [{ is_active: "desc" }, { category: "asc" }, { supply_name: "asc" }],
      include: {
        inventory: true,
        rules: {
          orderBy: [{ is_active: "desc" }, { trigger_type: "asc" }, { rule_id: "asc" }],
        },
        forecasts: {
          orderBy: [{ created_at: "desc" }, { forecast_id: "desc" }],
          take: 1,
        },
        reorders: {
          where: {
            request_status: {
              in: OPEN_REORDER_STATUSES,
            },
          },
          orderBy: [{ updated_at: "desc" }, { reorder_request_id: "desc" }],
          take: 3,
        },
      },
    }),
    client.supply_stock_movements.findMany({
      orderBy: [{ created_at: "desc" }, { movement_id: "desc" }],
      take: 80,
      include: {
        supplies: true,
        users: {
          include: {
            employee_profiles: true,
          },
        },
      },
    }),
    client.supply_forecast_snapshots.findMany({
      orderBy: [{ created_at: "desc" }, { forecast_id: "desc" }],
      take: 80,
      include: {
        supplies: true,
      },
    }),
    client.supply_reorder_requests.findMany({
      where: { request_status: { in: OPEN_REORDER_STATUSES } },
      orderBy: [{ updated_at: "desc" }, { reorder_request_id: "desc" }],
      include: { supplies: true },
    }),
    client.supply_reorder_requests.findMany({
      where: historyWhere,
      orderBy: [{ updated_at: "desc" }, { reorder_request_id: "desc" }],
      take: reorderLimit + 1,
      include: {
        supplies: true,
      },
    }),
    client.supply_reorder_requests.count({
      where: { request_status: { in: OPEN_REORDER_STATUSES } },
    }),
  ]);

  const supplyDtos = supplies.map(toSupplyDto);
  const latestForecastBySupplyId = new Map(
    supplies.map((supply) => [
      supply.supply_id,
      supply.forecasts[0] ?? null,
    ])
  );
  const forecastValidations = await buildSupplyForecastValidations(
    client,
    forecasts
  );
  const belowReorderPointCount = supplyDtos.filter((supply) => {
    const forecast = supply.latestForecast;
    return forecast && supply.availableQuantity <= forecast.reorderPointQuantity;
  }).length;
  const reorderHistoryPage = createKeysetPage({
    rows: reorderHistoryRows,
    limit: reorderLimit,
    coverage: "COMPLETE",
    cursorFor: (row) =>
      encodeKeysetCursor({
        contract: REORDER_HISTORY_CURSOR_CONTRACT,
        queryIdentity,
        snapshot: { snapshotAt: historySnapshotAt.toISOString() },
        position: {
          updatedAt: row.updated_at.toISOString(),
          reorderRequestId: row.reorder_request_id,
        },
      }),
  });
  const toWorkspaceReorder = (
    reorder: (typeof openReorders)[number]
  ) =>
    toReorderDto(
      reorder,
      reorder.supplies,
      latestForecastBySupplyId.get(reorder.supply_id) ?? null
    );

  return {
    supplies: supplyDtos,
    recentMovements: recentMovements.map(toMovementDto),
    forecasts: forecasts.map((forecast) => toForecastDto(forecast, forecast.supplies)),
    forecastValidations,
    openReorders: openReorders.map(toWorkspaceReorder),
    reorderHistory: reorderHistoryPage.items.map(toWorkspaceReorder),
    reorderHistoryPage: {
      hasMore: reorderHistoryPage.hasMore,
      nextCursor: reorderHistoryPage.nextCursor,
    },
    summary: {
      supplyCount: supplyDtos.length,
      activeSupplyCount: supplyDtos.filter((supply) => supply.isActive).length,
      belowReorderPointCount,
      openReorderCount,
    },
  };
}

function supplyData(input: SupplyInput, user: AuthUser) {
  const supplyCode = text(input.supplyCode).toUpperCase();
  const supplyName = text(input.supplyName);

  if (!supplyCode) {
    throw publicBadRequest(
      "SUPPLY_CODE_REQUIRED",
      "SUPPLY_CODE_REQUIRED"
    );
  }

  if (!supplyName) {
    throw publicBadRequest(
      "SUPPLY_NAME_REQUIRED",
      "SUPPLY_NAME_REQUIRED"
    );
  }

  const minLeadTimeDays = nonNegativeInteger(
    input.minLeadTimeDays ?? input.leadTimeDays,
    0
  );
  const maxLeadTimeDays = Math.max(
    minLeadTimeDays,
    nonNegativeInteger(input.maxLeadTimeDays ?? input.leadTimeDays, minLeadTimeDays)
  );
  const averageLeadTimeDays =
    minLeadTimeDays || maxLeadTimeDays
      ? Math.round((minLeadTimeDays + maxLeadTimeDays) / 2)
      : nonNegativeInteger(input.leadTimeDays, 0);

  return {
    supply_code: supplyCode,
    supply_name: supplyName,
    category: text(input.category),
    base_unit: text(input.baseUnit) || "개",
    order_unit: text(input.orderUnit),
    order_unit_quantity: positiveInteger(
      input.orderUnitQuantity ?? 1,
      "주문단위 수량"
    ),
    minimum_order_quantity: nonNegativeInteger(input.minimumOrderQuantity, 0),
    default_supplier_name: nullableText(input.defaultSupplierName),
    unit_cost: input.unitCost === "" ? null : nonNegativeInteger(input.unitCost, 0),
    lead_time_days: averageLeadTimeDays,
    min_lead_time_days: minLeadTimeDays,
    max_lead_time_days: maxLeadTimeDays,
    loss_rate_percent: Math.max(0, Number(input.lossRatePercent ?? 0) || 0),
    safety_stock_days: nonNegativeInteger(input.safetyStockDays, 3),
    target_stock_days: Math.max(1, nonNegativeInteger(input.targetStockDays, 14)),
    outbound_consumption_policy: outboundConsumptionPolicy(
      input.outboundConsumptionPolicy
    ),
    is_active: input.isActive === false ? 0 : 1,
    note: nullableText(input.note),
    updated_by_user_id: user.userId,
    updated_at: databaseNow(),
  };
}

export async function saveSupply(
  client: PrismaClient,
  input: SupplyInput,
  user: AuthUser
) {
  const supplyId = idFromBody(input, "supplyId");
  const expectedRevision = supplyId
    ? requiredExpectedRevision(input, "비품 정보")
    : null;
  const inventoryLocation = nullableText(input.inventoryLocation);
  const reservedQuantity = nonNegativeInteger(input.reservedQuantity, 0);
  const data = supplyData(input, user);
  const timestamp = databaseNow();

  return client.$transaction(async (tx) => {
    if (supplyId) {
      await tx.$queryRaw`
        SELECT supply_id
        FROM supplies
        WHERE supply_id = ${supplyId}
        FOR UPDATE
      `;
    }
    const before = supplyId
      ? await tx.supplies.findUnique({
          where: { supply_id: supplyId },
          include: { inventory: true },
        })
      : null;

    if (supplyId && !before) {
      throw publicConflict(
        "SUPPLY_MASTER_NOT_FOUND",
        "SUPPLY_MASTER_NOT_FOUND"
      );
    }
    if (before && before.revision !== expectedRevision) {
      throw publicConflict(
        "SUPPLY_MASTER_STALE_STATE",
        "SUPPLY_MASTER_STALE_STATE",
        { currentRevision: before.revision }
      );
    }

    const desiredSnapshot = supplyMasterAuditSnapshot({
      supplyCode: data.supply_code,
      supplyName: data.supply_name,
      category: data.category,
      baseUnit: data.base_unit,
      orderUnit: data.order_unit,
      orderUnitQuantity: data.order_unit_quantity,
      minimumOrderQuantity: data.minimum_order_quantity,
      defaultSupplierName: data.default_supplier_name,
      unitCost: data.unit_cost,
      leadTimeDays: data.lead_time_days,
      minLeadTimeDays: data.min_lead_time_days,
      maxLeadTimeDays: data.max_lead_time_days,
      lossRatePercent: Number(data.loss_rate_percent),
      safetyStockDays: data.safety_stock_days,
      targetStockDays: data.target_stock_days,
      outboundConsumptionPolicy: data.outbound_consumption_policy,
      isActive: data.is_active === 1,
      note: data.note,
      reservedQuantity,
      inventoryLocation,
    });
    const beforeSnapshot = before ? supplyMasterSnapshot(before) : null;

    if (
      beforeSnapshot &&
      JSON.stringify(beforeSnapshot) === JSON.stringify(desiredSnapshot)
    ) {
      return before;
    }

    let supply;
    if (before) {
      const changed = await tx.supplies.updateMany({
        where: {
          supply_id: before.supply_id,
          revision: expectedRevision as number,
        },
        data: { ...data, revision: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw publicConflict(
          "SUPPLY_MASTER_STALE_STATE",
          "SUPPLY_MASTER_STALE_STATE"
        );
      }
      supply = await tx.supplies.findUniqueOrThrow({
        where: { supply_id: before.supply_id },
      });
    } else {
      supply = await tx.supplies.create({
          data: { ...data, created_at: timestamp },
        });
    }
    await tx.supply_inventory.upsert({
      where: { supply_id: supply.supply_id },
      create: {
        supply_id: supply.supply_id,
        current_quantity: 0,
        reserved_quantity: reservedQuantity,
        inventory_location: inventoryLocation,
        created_at: timestamp,
        updated_at: timestamp,
      },
      update: {
        reserved_quantity: reservedQuantity,
        inventory_location: inventoryLocation,
        updated_at: timestamp,
      },
    });

    await writeActivityLog(tx, {
      user,
      actionType: supplyId ? "SUPPLY_UPDATE" : "SUPPLY_CREATE",
      targetType: "SUPPLY",
      targetId: supply.supply_id,
      beforeValue: beforeSnapshot,
      afterValue: desiredSnapshot,
    });

    return supply;
  });
}

async function ensureSupplyInventory(tx: TransactionClient, supplyId: number) {
  const timestamp = databaseNow();

  return tx.supply_inventory.upsert({
    where: { supply_id: supplyId },
    create: {
      supply_id: supplyId,
      current_quantity: 0,
      reserved_quantity: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
    update: {},
  });
}

export async function recordSupplyMovementInTransaction(
  tx: TransactionClient,
  input: SupplyInput,
  user: { userId: number | null }
) {
  const supplyId = positiveInteger(input.supplyId, "비품 ID");
  const type = movementType(input.movementType);
  const quantity =
    type === SUPPLY_MOVEMENT_TYPE.adjustment
      ? strictNonNegativeInteger(input.quantity, "조정 후 수량")
      : strictPositiveMovementInteger(input.quantity, "수량");
  const operationId = supplyMovementOperationId(input.idempotencyKey);
  const reason = nullableText(input.reason);
  const sourceType = nullableText(input.sourceType);
  const sourceId = nullableText(input.sourceId);
  const pgNo = nullableText(input.pgNo);
  const shipmentId = optionalMovementId(input, "shipmentId", "출고 ID");
  const orderId = optionalMovementId(input, "orderId", "주문 ID");
  const allocationId = optionalMovementId(input, "allocationId", "배정 ID");
  const coupangReturnAllocationId = optionalMovementId(
    input,
    "coupangReturnAllocationId",
    "반품 배정 ID"
  );
  const reversalOfConsumptionEventId = optionalMovementId(
    input,
    "reversalOfConsumptionEventId",
    "소모 취소 이벤트 ID"
  );

  await lockAggregateKey(tx, {
    namespace: "supply-stock-movement",
    key: operationId,
  });
  const existingMovement = await tx.supply_stock_movements.findUnique({
    where: { idempotency_key: operationId },
  });

  if (existingMovement) {
    const quantityMatches =
      type === SUPPLY_MOVEMENT_TYPE.adjustment
        ? existingMovement.after_quantity === quantity
        : existingMovement.quantity === quantity;
    if (
      existingMovement.supply_id !== supplyId ||
      existingMovement.movement_type !== type ||
      !quantityMatches ||
      existingMovement.reason !== reason ||
      existingMovement.source_type !== sourceType ||
      existingMovement.source_id !== sourceId ||
      existingMovement.pg_no !== pgNo ||
      existingMovement.shipment_id !== shipmentId ||
      existingMovement.order_id !== orderId ||
      existingMovement.allocation_id !== allocationId ||
      existingMovement.coupang_return_allocation_id !==
        coupangReturnAllocationId ||
      existingMovement.reversal_of_consumption_event_id !==
        reversalOfConsumptionEventId ||
      existingMovement.created_by_user_id !== user.userId
    ) {
      throw publicConflict(
        "SUPPLY_MOVEMENT_IDEMPOTENCY_CONFLICT",
        "SUPPLY_MOVEMENT_IDEMPOTENCY_CONFLICT"
      );
    }

    return { movement: existingMovement, observed: true, operationId } as const;
  }

  const inventory = await ensureSupplyInventory(tx, supplyId);
  const beforeQuantity = inventory.current_quantity;
  let afterQuantity = beforeQuantity;

  if (type === SUPPLY_MOVEMENT_TYPE.inbound || type === SUPPLY_MOVEMENT_TYPE.returned) {
    afterQuantity = beforeQuantity + quantity;
  } else if (
    type === SUPPLY_MOVEMENT_TYPE.consumed ||
    type === SUPPLY_MOVEMENT_TYPE.discarded
  ) {
    afterQuantity = beforeQuantity - quantity;
  } else if (type === SUPPLY_MOVEMENT_TYPE.adjustment) {
    afterQuantity = quantity;
  }

  if (afterQuantity < 0) {
    throw publicConflict(
      "SUPPLY_STOCK_NEGATIVE",
      "SUPPLY_STOCK_NEGATIVE"
    );
  }

  const timestamp = databaseNow();

  const updatedInventory = await tx.supply_inventory.updateMany({
    where: {
      supply_id: supplyId,
      version: inventory.version,
      current_quantity: beforeQuantity,
    },
    data: {
      current_quantity: afterQuantity,
      version: { increment: 1 },
      last_counted_at:
        type === SUPPLY_MOVEMENT_TYPE.adjustment
          ? timestamp
          : inventory.last_counted_at,
      updated_at: timestamp,
    },
  });

  if (updatedInventory.count !== 1) {
    throw publicConflict(
      "SUPPLY_STOCK_STALE_STATE",
      "SUPPLY_STOCK_STALE_STATE"
    );
  }

  const movement = await tx.supply_stock_movements.create({
    data: {
      supply_id: supplyId,
      movement_type: type,
      quantity:
        type === SUPPLY_MOVEMENT_TYPE.adjustment
          ? Math.abs(afterQuantity - beforeQuantity)
          : quantity,
      before_quantity: beforeQuantity,
      after_quantity: afterQuantity,
      reason,
      source_type: sourceType,
      source_id: sourceId,
      pg_no: pgNo,
      shipment_id: shipmentId,
      order_id: orderId,
      allocation_id: allocationId,
      coupang_return_allocation_id: coupangReturnAllocationId,
      reversal_of_consumption_event_id: reversalOfConsumptionEventId,
      idempotency_key: operationId,
      created_by_user_id: user.userId,
      created_at: timestamp,
    },
  });

  await writeActivityLog(tx, {
    user,
    actionType: "SUPPLY_STOCK_MOVEMENT",
    targetType: "SUPPLY",
    targetId: supplyId,
    beforeValue: supplyMovementAuditSnapshot(beforeQuantity),
    afterValue: supplyMovementAuditSnapshot(afterQuantity),
    afterSummaryText: [
      `movementId=${movement.movement_id}`,
      `movementType=${type}`,
      `quantity=${movement.quantity}`,
      `sourceType=${movement.source_type ?? ""}`,
      `sourceId=${movement.source_id ?? ""}`,
      `reason=${movement.reason ?? ""}`,
    ].join(" / "),
  });

  return { movement, observed: false, operationId } as const;
}

export async function recordSupplyMovement(
  client: PrismaClient,
  input: SupplyInput,
  user: AuthUser
) {
  return client.$transaction((tx) =>
    recordSupplyMovementInTransaction(tx, input, user)
  );
}

export async function saveSupplyConsumptionRule(
  client: PrismaClient,
  input: SupplyInput,
  user: AuthUser
) {
  const ruleId = idFromBody(input, "ruleId");
  const expectedRevision = ruleId
    ? requiredExpectedRevision(input, "비품 소모 규칙")
    : null;
  const supplyId = positiveInteger(input.supplyId, "비품 ID");
  const timestamp = databaseNow();
  const normalizedTrigger = triggerType(input.triggerType);
  const filters: SupplyRuleFilters = {
    channel: nullableText(input.channel),
    model: nullableText(input.model),
    saleGrade: nullableText(input.saleGrade),
    warranty: nullableText(input.warranty),
    inventoryStatus: nullableText(input.inventoryStatus),
  };

  validateSupplyRuleFilters(normalizedTrigger, filters);

  const data = {
    supply_id: supplyId,
    trigger_type: normalizedTrigger,
    quantity_per_unit: roundedPositiveInteger(
      input.quantityPerUnit ?? 1,
      "소요 수량"
    ),
    channel: filters.channel,
    model: filters.model,
    sale_grade: filters.saleGrade,
    warranty: filters.warranty,
    inventory_status: filters.inventoryStatus,
    is_active: input.isActive === false ? 0 : 1,
    note: nullableText(input.note),
    updated_by_user_id: user.userId,
    updated_at: timestamp,
  };

  return client.$transaction(async (tx) => {
    const observedBefore = ruleId
      ? await tx.supply_consumption_rules.findUnique({
          where: { rule_id: ruleId },
        })
      : null;
    const lockedSupplyIds = [
      ...new Set([
        supplyId,
        ...(observedBefore ? [observedBefore.supply_id] : []),
      ]),
    ].sort((left, right) => left - right);
    await tx.$queryRaw`
      SELECT supply_id
      FROM supplies
      WHERE supply_id IN (${Prisma.join(lockedSupplyIds)})
      ORDER BY supply_id
      FOR UPDATE
    `;
    const before = ruleId
      ? await tx.supply_consumption_rules.findUnique({
          where: { rule_id: ruleId },
        })
      : null;

    if (ruleId && !before) {
      throw publicConflict(
        "SUPPLY_CONSUMPTION_RULE_NOT_FOUND",
        "SUPPLY_CONSUMPTION_RULE_NOT_FOUND"
      );
    }
    if (before && before.revision !== expectedRevision) {
      throw publicConflict(
        "SUPPLY_CONSUMPTION_RULE_STALE_STATE",
        "SUPPLY_CONSUMPTION_RULE_STALE_STATE",
        { currentRevision: before.revision }
      );
    }

    if (
      data.is_active === 1 &&
      isOutboundSupplyConsumptionTrigger(data.trigger_type)
    ) {
      const activeRules = await tx.supply_consumption_rules.findMany({
        where: {
          supply_id: supplyId,
          is_active: 1,
          trigger_type: {
            in: [...OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS],
          },
          ...(ruleId ? { rule_id: { not: ruleId } } : {}),
        },
        select: {
          rule_id: true,
          trigger_type: true,
          channel: true,
          model: true,
          sale_grade: true,
          warranty: true,
          inventory_status: true,
        },
      });
      const overlappingRule = activeRules.find((rule) =>
        outboundSupplyConsumptionRulesOverlap(data, rule)
      );

      if (overlappingRule) {
        throw publicConflict(
          "SUPPLY_CONSUMPTION_RULE_OVERLAP",
          "SUPPLY_CONSUMPTION_RULE_OVERLAP",
          {
            supplyId,
            ruleId,
            conflictingRuleId: overlappingRule.rule_id,
          }
        );
      }
    }

    const unchanged =
      before &&
      before.supply_id === data.supply_id &&
      before.trigger_type === data.trigger_type &&
      before.quantity_per_unit === data.quantity_per_unit &&
      before.channel === data.channel &&
      before.model === data.model &&
      before.sale_grade === data.sale_grade &&
      before.warranty === data.warranty &&
      before.inventory_status === data.inventory_status &&
      before.is_active === data.is_active &&
      before.note === data.note;

    if (unchanged) {
      return before;
    }

    let rule;
    if (before) {
      const changed = await tx.supply_consumption_rules.updateMany({
        where: {
          rule_id: before.rule_id,
          revision: expectedRevision as number,
        },
        data: { ...data, revision: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw publicConflict(
          "SUPPLY_CONSUMPTION_RULE_STALE_STATE",
          "SUPPLY_CONSUMPTION_RULE_STALE_STATE"
        );
      }
      rule = await tx.supply_consumption_rules.findUniqueOrThrow({
        where: { rule_id: before.rule_id },
      });
    } else {
      rule = await tx.supply_consumption_rules.create({
          data: {
            ...data,
            created_at: timestamp,
          },
        });
    }

    await writeActivityLog(tx, {
      user,
      actionType: ruleId
        ? "SUPPLY_CONSUMPTION_RULE_UPDATE"
        : "SUPPLY_CONSUMPTION_RULE_CREATE",
      targetType: "SUPPLY_CONSUMPTION_RULE",
      targetId: rule.rule_id,
      beforeValue: before,
      afterValue: rule,
    });

    return rule;
  });
}

function ruleMatchesDevice(
  rule: {
    model: string | null;
    sale_grade: string | null;
    warranty: string | null;
    inventory_status: string | null;
  },
  device: {
    model?: string | null;
    sale_grade?: string | null;
    warranty?: string | null;
    inventory?: { inventory_status?: string | null } | null;
  }
) {
  if (rule.model && rule.model !== device.model) {
    return false;
  }

  if (rule.sale_grade && rule.sale_grade !== device.sale_grade) {
    return false;
  }

  if (rule.warranty && rule.warranty !== device.warranty) {
    return false;
  }

  if (
    rule.inventory_status &&
    rule.inventory_status !== device.inventory?.inventory_status
  ) {
    return false;
  }

  return true;
}

function ruleTextMatches(
  expected: string | null,
  ...candidates: Array<string | null | undefined>
) {
  return !expected || candidates.some((candidate) => candidate === expected);
}

function ruleChannelMatches(
  expected: string | null,
  actual: string | null | undefined
) {
  return !expected || text(expected).toUpperCase() === text(actual).toUpperCase();
}

function legacyOrderItemMatchesRule(
  rule: Prisma.supply_consumption_rulesGetPayload<object>,
  row: {
    matched_model: string | null;
    orders: { platform: string };
    devices: { model: string | null; warranty: string | null } | null;
  }
) {
  return (
    ruleChannelMatches(rule.channel, row.orders.platform) &&
    ruleTextMatches(rule.model, row.matched_model, row.devices?.model) &&
    ruleTextMatches(rule.warranty, row.devices?.warranty)
  );
}

function channelOrderItemMatchesRule(
  rule: Prisma.supply_consumption_rulesGetPayload<object>,
  row: {
    channel: string;
    required_model_label: string | null;
    required_warranty_group: string | null;
  }
) {
  return (
    ruleChannelMatches(rule.channel, row.channel) &&
    ruleTextMatches(rule.model, row.required_model_label) &&
    ruleTextMatches(
      rule.warranty,
      warrantyGroupLabel(row.required_warranty_group),
      row.required_warranty_group
    )
  );
}

async function businessRuleExpectedUsage(
  client: TransactionClient,
  rules: Prisma.supply_consumption_rulesGetPayload<object>[],
  periodFrom: Exclude<DateTimeInput, null | undefined>,
  periodTo: Exclude<DateTimeInput, null | undefined>,
  lookbackDays: number
) {
  const breakdown = [];
  const usageByDate = lookbackUsageMap(lookbackDays, periodTo);

  for (const rule of rules) {
    let units = 0;
    const ruleUsageByDate = lookbackUsageMap(lookbackDays, periodTo);
    const normalizedTrigger = triggerType(rule.trigger_type);

    validateSupplyRuleFilters(normalizedTrigger, {
      channel: rule.channel,
      model: rule.model,
      saleGrade: rule.sale_grade,
      warranty: rule.warranty,
      inventoryStatus: rule.inventory_status,
    });

    if (normalizedTrigger === SUPPLY_CONSUMPTION_TRIGGER.purchasedDevice) {
      const incompletePurchasedCount = await client.inbounds.count({
        where: { inbound_status: "PURCHASED", price_agreed_at: null },
      });
      if (incompletePurchasedCount > 0) {
        throw publicConflict(
          "SUPPLY_FORECAST_SOURCE_INCOMPLETE",
          "SUPPLY_FORECAST_SOURCE_INCOMPLETE",
          { source: "PURCHASED_DEVICE", incompleteCount: incompletePurchasedCount }
        );
      }
      const rows = await client.inbounds.findMany({
        where: {
          inbound_status: "PURCHASED",
          price_agreed_at: {
            gte: periodFrom,
            lte: periodTo,
          },
        },
        select: {
          price_agreed_at: true,
          devices: {
            select: {
              model: true,
              sale_grade: true,
              warranty: true,
              inventory: {
                select: {
                  inventory_status: true,
                },
              },
            },
          },
        },
      });

      for (const row of rows) {
        if (!ruleMatchesDevice(rule, row.devices)) {
          continue;
        }

        units += 1;
        if (!row.price_agreed_at) continue;
        addUsage(
          ruleUsageByDate,
          sqlDateFromDateTime(row.price_agreed_at),
          rule.quantity_per_unit
        );
      }
    } else if (normalizedTrigger === SUPPLY_CONSUMPTION_TRIGGER.shipmentCreated) {
      const rows = await client.match_worker_allocation.findMany({
        where: {
          allocation_status: {
            in: [...SHIPMENT_TRIGGER_ALLOCATION_STATUSES],
          },
          shipment_list_printed_at: {
            gte: periodFrom,
            lte: periodTo,
          },
        },
        select: {
          shipment_list_printed_at: true,
          device: {
            select: {
              model: true,
              sale_grade: true,
              warranty: true,
              inventory: {
                select: {
                  inventory_status: true,
                },
              },
            },
          },
        },
      });

      for (const row of rows) {
        if (!ruleMatchesDevice(rule, row.device)) {
          continue;
        }

        if (!row.shipment_list_printed_at) {
          continue;
        }

        units += 1;
        addUsage(
          ruleUsageByDate,
          sqlDateFromDateTime(row.shipment_list_printed_at),
          rule.quantity_per_unit
        );
      }
    } else if (normalizedTrigger === SUPPLY_CONSUMPTION_TRIGGER.orderItem) {
      const [incompleteLegacyCount, incompleteChannelCount] = await Promise.all([
        client.order_items.count({ where: { orders: { ordered_at: null } } }),
        client.order_matching_work_queue.count({
          where: { canceled: { not: 1 }, ordered_at: null },
        }),
      ]);
      if (incompleteLegacyCount + incompleteChannelCount > 0) {
        throw publicConflict(
          "SUPPLY_FORECAST_SOURCE_INCOMPLETE",
          "SUPPLY_FORECAST_SOURCE_INCOMPLETE",
          {
            source: "ORDER_ITEM",
            incompleteCount: incompleteLegacyCount + incompleteChannelCount,
          }
        );
      }
      const [legacyItems, channelItems] = await Promise.all([
        client.order_items.findMany({
          where: {
            orders: {
              ordered_at: {
                gte: periodFrom,
                lte: periodTo,
              },
            },
          },
          select: {
            quantity: true,
            matched_model: true,
            orders: {
              select: {
                platform: true,
                ordered_at: true,
              },
            },
            devices: {
              select: {
                model: true,
                warranty: true,
              },
            },
          },
        }),
        client.order_matching_work_queue.findMany({
          where: {
            canceled: { not: 1 },
            ordered_at: {
              gte: periodFrom,
              lte: periodTo,
            },
          },
          select: {
            matchable_quantity: true,
            ordered_at: true,
            channel: true,
            required_model_label: true,
            required_warranty_group: true,
          },
        }),
      ]);

      for (const row of legacyItems) {
        if (!legacyOrderItemMatchesRule(rule, row)) {
          continue;
        }
        if (!row.orders.ordered_at) continue;

        units += row.quantity;
        addUsage(
          ruleUsageByDate,
          sqlDateFromDateTime(row.orders.ordered_at),
          row.quantity * rule.quantity_per_unit
        );
      }

      for (const row of channelItems) {
        if (!channelOrderItemMatchesRule(rule, row)) {
          continue;
        }
        if (!row.ordered_at) continue;

        const effectiveQuantity = Math.max(0, row.matchable_quantity);

        units += effectiveQuantity;
        addUsage(
          ruleUsageByDate,
          sqlDateFromDateTime(row.ordered_at),
          effectiveQuantity * rule.quantity_per_unit
        );
      }
    } else if (normalizedTrigger === SUPPLY_CONSUMPTION_TRIGGER.packingCompleted) {
      const events = await client.supply_consumption_events.findMany({
        where: {
          supply_id: rule.supply_id,
          rule_id: rule.rule_id,
          trigger_type: SUPPLY_CONSUMPTION_TRIGGER.packingCompleted,
          OR: [
            {
              effective_period_from: null,
              consumed_at: {
                gte: periodFrom,
                lte: periodTo,
              },
            },
            {
              effective_period_from: {
                lte: periodTo,
              },
              effective_period_to: {
                gte: periodFrom,
              },
            },
          ],
        },
        select: {
          quantity: true,
          effective_period_from: true,
          effective_period_to: true,
          consumed_at: true,
        },
      });

      for (const event of events) {
        const quantity = Number(event.quantity || 0);
        units += 1;

        if (event.effective_period_from && event.effective_period_to) {
          distributeUsage(
            ruleUsageByDate,
            event.effective_period_from,
            event.effective_period_to,
            quantity
          );
        } else {
          addUsage(ruleUsageByDate, sqlDateFromDateTime(event.consumed_at), quantity);
        }
      }
    } else if (normalizedTrigger === SUPPLY_CONSUMPTION_TRIGGER.returnReceived) {
      const incompleteReturnCount = await client.sales_channel_write_requests.count({
        where: {
          channel: "COUPANG",
          request_type: "RETURN_RECEIVE_CONFIRMATION",
          request_status: "COMPLETED",
          local_finalized_at: null,
        },
      });
      if (incompleteReturnCount > 0) {
        throw publicConflict(
          "SUPPLY_FORECAST_SOURCE_INCOMPLETE",
          "SUPPLY_FORECAST_SOURCE_INCOMPLETE",
          { source: "RETURN_RECEIVED", incompleteCount: incompleteReturnCount }
        );
      }
      const rows = await client.sales_channel_write_requests.findMany({
        where: {
          channel: "COUPANG",
          request_type: "RETURN_RECEIVE_CONFIRMATION",
          request_status: "COMPLETED",
          local_finalized_at: {
            gte: periodFrom,
            lte: periodTo,
          },
        },
        select: {
          local_finalized_at: true,
        },
      });

      for (const row of rows) {
        if (!row.local_finalized_at) continue;
        units += 1;
        addUsage(
          ruleUsageByDate,
          sqlDateFromDateTime(row.local_finalized_at),
          rule.quantity_per_unit
        );
      }
    }

    const usage = [...ruleUsageByDate.values()].reduce((sum, value) => sum + value, 0);
    for (const [dateKey, quantity] of ruleUsageByDate.entries()) {
      addUsage(usageByDate, dateKey, quantity);
    }

    breakdown.push({
      ruleId: rule.rule_id,
      triggerType: rule.trigger_type,
      units,
      quantityPerUnit: rule.quantity_per_unit,
      usage,
    });
  }

  const dailyValues = [...usageByDate.values()];
  const expectedUsage = dailyValues.reduce((sum, value) => sum + value, 0);

  return {
    expectedUsage,
    dailyValues,
    maximumDailyUsage: dailyValues.length > 0 ? Math.max(...dailyValues) : 0,
    breakdown,
  };
}

async function actualConsumedUsage(
  client: TransactionClient,
  supplyId: number,
  periodFrom: Exclude<DateTimeInput, null | undefined>,
  periodTo: Exclude<DateTimeInput, null | undefined>,
  lookbackDays: number
) {
  const movements = await client.supply_stock_movements.findMany({
    where: {
      supply_id: supplyId,
      movement_type: SUPPLY_MOVEMENT_TYPE.consumed,
      NOT: {
        source_type: PACKING_COMPLETED_SOURCE_TYPE,
      },
      created_at: {
        gte: periodFrom,
        lte: periodTo,
      },
    },
    select: {
      quantity: true,
      created_at: true,
    },
  });
  const usageByDate = lookbackUsageMap(lookbackDays, periodTo);

  for (const movement of movements) {
    const date = sqlDateFromDateTime(movement.created_at);
    usageByDate.set(date, (usageByDate.get(date) ?? 0) + movement.quantity);
  }

  const dailyValues = [...usageByDate.values()];

  return {
    consumedQuantity: movements.reduce(
      (sum, movement) => sum + movement.quantity,
      0
    ),
    dailyValues,
    maximumDailyUsage: dailyValues.length > 0 ? Math.max(...dailyValues) : 0,
    dailyStddev: stddev(dailyValues),
  };
}

async function measuredSupplyUsage(
  client: PrismaClient,
  supplyId: number,
  periodFrom: Exclude<DateTimeInput, null | undefined>,
  periodTo: Exclude<DateTimeInput, null | undefined>
) {
  const usageByDate = periodUsageMap(periodFrom, periodTo);
  const [manualMovements, consumptionEvents] = await Promise.all([
    client.supply_stock_movements.findMany({
      where: {
        supply_id: supplyId,
        movement_type: SUPPLY_MOVEMENT_TYPE.consumed,
        NOT: {
          source_type: PACKING_COMPLETED_SOURCE_TYPE,
        },
        consumption_event: {
          is: null,
        },
        created_at: {
          gte: periodFrom,
          lte: periodTo,
        },
      },
      select: {
        quantity: true,
        created_at: true,
      },
    }),
    client.supply_consumption_events.findMany({
      where: {
        supply_id: supplyId,
        OR: [
          {
            effective_period_from: null,
            consumed_at: {
              gte: periodFrom,
              lte: periodTo,
            },
          },
          {
            effective_period_from: {
              lte: periodTo,
            },
            effective_period_to: {
              gte: periodFrom,
            },
          },
        ],
      },
      select: {
        quantity: true,
        effective_period_from: true,
        effective_period_to: true,
        consumed_at: true,
      },
    }),
  ]);

  for (const movement of manualMovements) {
    addUsage(usageByDate, sqlDateFromDateTime(movement.created_at), movement.quantity);
  }

  for (const event of consumptionEvents) {
    const quantity = Number(event.quantity || 0);

    if (event.effective_period_from && event.effective_period_to) {
      distributeUsage(
        usageByDate,
        event.effective_period_from,
        event.effective_period_to,
        quantity
      );
    } else {
      addUsage(usageByDate, sqlDateFromDateTime(event.consumed_at), quantity);
    }
  }

  const dailyValues = [...usageByDate.values()];

  return {
    quantity: dailyValues.reduce((sum, value) => sum + value, 0),
    dailyValues,
    dailyStddev: stddev(dailyValues),
  };
}

function forecastValidationStatus(
  elapsedDays: number,
  predictedUsage: number,
  actualUsage: number,
  errorRatePercent: number | null
) {
  if (elapsedDays <= 0) {
    return "PENDING" as const;
  }

  if (predictedUsage === 0 && actualUsage === 0) {
    return "NO_USAGE" as const;
  }

  if (errorRatePercent !== null && errorRatePercent <= 20) {
    return "GOOD" as const;
  }

  if (errorRatePercent !== null && errorRatePercent <= 40) {
    return "WARNING" as const;
  }

  return "HIGH_ERROR" as const;
}

async function buildSupplyForecastValidations(
  client: PrismaClient,
  forecasts: Prisma.supply_forecast_snapshotsGetPayload<{
    include: {
      supplies: true;
    };
  }>[]
) {
  const now = databaseNow();
  const rows = [];

  for (const forecast of forecasts) {
    const elapsedDays = Math.min(
      forecast.lookback_days,
      wholeDaysBetweenSqlDateTimes(forecast.created_at, now)
    );
    const validationFrom = forecast.created_at;
    const validationTo =
      elapsedDays >= forecast.lookback_days
        ? addDaysToSqlDateTime(forecast.created_at, forecast.lookback_days)
        : now;
    const predictedUsage = forecast.average_daily_usage * elapsedDays;
    const actual = elapsedDays > 0
      ? await measuredSupplyUsage(
          client,
          forecast.supply_id,
          validationFrom,
          validationTo
        )
      : { quantity: 0, dailyValues: [], dailyStddev: 0 };
    const difference = actual.quantity - predictedUsage;
    const errorRatePercent =
      elapsedDays > 0
        ? (Math.abs(difference) / Math.max(actual.quantity, 1)) * 100
        : null;

    rows.push({
      forecastId: forecast.forecast_id,
      supplyId: forecast.supply_id,
      supplyName: forecast.supplies.supply_name,
      forecastDate: forecast.forecast_date,
      validationFrom,
      validationTo,
      elapsedDays,
      lookbackDays: forecast.lookback_days,
      predictedUsageQuantity: predictedUsage,
      actualUsageQuantity: actual.quantity,
      differenceQuantity: difference,
      errorRatePercent,
      status: forecastValidationStatus(
        elapsedDays,
        predictedUsage,
        actual.quantity,
        errorRatePercent
      ),
    });
  }

  return rows;
}

export async function calculateSupplyForecasts(
  client: PrismaClient,
  input: SupplyInput,
  user: AuthUser
) {
  const lookbackDays = Math.max(
    1,
    Math.min(365, nonNegativeInteger(input.lookbackDays, DEFAULT_LOOKBACK_DAYS))
  );
  const supplyId = idFromBody(input, "supplyId");
  return runMeasuredTransaction(
    client,
    "supply.forecast.calculate",
    async (tx) => {
      const calculatedAt = quickHackClock.nowDate();
      const periodTo = calculatedAt;
      const periodFrom = new Date(
        calculatedAt.getTime() - lookbackDays * MS_PER_DAY
      );
      const forecastDate = databaseDateTime(
        `${formatKstDate(calculatedAt)}T00:00:00.000Z`
      );
      const supplies = await tx.supplies.findMany({
        where: {
          is_active: 1,
          ...(supplyId ? { supply_id: supplyId } : {}),
        },
        include: {
          inventory: true,
          rules: {
            where: {
              is_active: 1,
            },
          },
        },
        orderBy: [{ category: "asc" }, { supply_name: "asc" }],
      });
      const forecastDrafts: Prisma.supply_forecast_snapshotsCreateArgs["data"][] =
        [];

      for (const supply of supplies) {
        const actual = await actualConsumedUsage(
          tx,
          supply.supply_id,
          periodFrom,
          periodTo,
          lookbackDays
        );
        const ruleExpected = await businessRuleExpectedUsage(
          tx,
          supply.rules,
          periodFrom,
          periodTo,
          lookbackDays
        );
        const actualAverage = safeDivide(
          actual.consumedQuantity,
          lookbackDays
        );
        const ruleAverage = safeDivide(
          ruleExpected.expectedUsage,
          lookbackDays
        );
        const baseAverageDailyUsage = Math.max(actualAverage, ruleAverage);
        const baseMaximumDailyUsage = Math.max(
          actual.maximumDailyUsage,
          ruleExpected.maximumDailyUsage
        );
        const lossRatePercent = Number(supply.loss_rate_percent);
        const lossMultiplier = 1 + Math.max(0, lossRatePercent) / 100;
        const averageDailyUsage = baseAverageDailyUsage * lossMultiplier;
        const maximumDailyUsage = baseMaximumDailyUsage * lossMultiplier;
        const minLeadTimeDays =
          supply.min_lead_time_days || supply.lead_time_days || 0;
        const maxLeadTimeDays =
          Math.max(supply.max_lead_time_days, minLeadTimeDays) ||
          supply.lead_time_days ||
          0;
        const averageLeadTimeDays =
          minLeadTimeDays || maxLeadTimeDays
            ? (minLeadTimeDays + maxLeadTimeDays) / 2
            : supply.lead_time_days;
        const demandSource =
          actual.consumedQuantity > 0 && ruleExpected.expectedUsage > 0
            ? "ACTUAL_AND_RULE_MAX"
            : actual.consumedQuantity > 0
              ? "ACTUAL_MOVEMENT"
              : ruleExpected.expectedUsage > 0
                ? "BUSINESS_RULE"
                : "NO_USAGE";
        const currentQuantity = supply.inventory?.current_quantity ?? 0;
        const reservedQuantity = supply.inventory?.reserved_quantity ?? 0;
        const availableQuantity = Math.max(
          0,
          currentQuantity - reservedQuantity
        );
        const safetyStockQuantity = Math.max(
          0,
          maximumDailyUsage * maxLeadTimeDays -
            averageDailyUsage * averageLeadTimeDays
        );
        const reorderPointQuantity =
          averageDailyUsage * averageLeadTimeDays + safetyStockQuantity;
        const targetStockQuantity =
          averageDailyUsage * supply.target_stock_days + safetyStockQuantity;
        const shortage = Math.max(0, targetStockQuantity - availableQuantity);
        const recommendedPurchaseQuantity = roundUpToOrderUnit(
          shortage,
          supply.order_unit_quantity,
          supply.minimum_order_quantity
        );
        const expectedStockoutDate =
          averageDailyUsage > 0
            ? databaseDateTime(
                `${sqlDateDaysAfter(
                  periodTo,
                  safeDivide(availableQuantity, averageDailyUsage)
                )}T00:00:00.000Z`
              )
            : null;
        const calculation = {
          actualConsumedQuantity: actual.consumedQuantity,
          actualAverageDailyUsage: actualAverage,
          actualMaximumDailyUsage: actual.maximumDailyUsage,
          ruleExpectedUsage: ruleExpected.expectedUsage,
          ruleAverageDailyUsage: ruleAverage,
          ruleMaximumDailyUsage: ruleExpected.maximumDailyUsage,
          rules: ruleExpected.breakdown,
          lossRatePercent,
          baseAverageDailyUsage,
          baseMaximumDailyUsage,
          selectedAverageDailyUsage: averageDailyUsage,
          selectedMaximumDailyUsage: maximumDailyUsage,
          minLeadTimeDays,
          maxLeadTimeDays,
          averageLeadTimeDays,
          formula:
            "safetyStock=max(0, maxDailyUsage*maxLeadTime-averageDailyUsage*averageLeadTime); reorderPoint=averageDailyUsage*averageLeadTime+safetyStock; recommended=max(0, ceil((averageDailyUsage*targetStockDays+safetyStock-availableQuantity)/orderUnitQuantity)*orderUnitQuantity)",
        };

        forecastDrafts.push({
          supply_id: supply.supply_id,
          forecast_date: forecastDate,
          period_from: periodFrom,
          period_to: periodTo,
          lookback_days: lookbackDays,
          demand_source: demandSource,
          expected_usage_quantity:
            Math.max(actual.consumedQuantity, ruleExpected.expectedUsage) *
            lossMultiplier,
          average_daily_usage: averageDailyUsage,
          usage_stddev: actual.dailyStddev,
          current_quantity: currentQuantity,
          available_quantity: availableQuantity,
          safety_stock_quantity: safetyStockQuantity,
          reorder_point_quantity: reorderPointQuantity,
          target_stock_quantity: targetStockQuantity,
          recommended_purchase_quantity: recommendedPurchaseQuantity,
          economic_order_quantity: null,
          expected_stockout_date: expectedStockoutDate,
          calculation_fields: {
            create: supplyForecastCalculationFields(calculation),
          },
          created_by_user_id: user.userId,
          created_at: periodTo,
        });
      }

      const created = [];

      for (const data of forecastDrafts) {
        created.push(
          await tx.supply_forecast_snapshots.create({
            data,
          })
        );
      }

      await writeActivityLog(tx, {
        user,
        actionType: "SUPPLY_FORECAST_CALCULATE",
        targetType: "SUPPLY_FORECAST",
        targetId: supplyId || "ALL",
        afterValue: {
          lookbackDays,
          createdCount: created.length,
        },
      });

      return created;
    },
    {
      maxWait: 10_000,
      timeout: 120_000,
    }
  );
}

export async function createSuggestedReordersFromForecasts(
  client: PrismaClient,
  input: SupplyInput,
  user: AuthUser
) {
  const forecastDateText = text(input.forecastDate);
  const forecastDate = forecastDateText
    ? databaseDateTime(`${forecastDateText}T00:00:00.000Z`)
    : null;
  return client.$transaction(async (tx) => {
    const suppliesWithLatestForecast = await tx.supplies.findMany({
      where: {
        is_active: 1,
      },
      select: {
        supply_id: true,
        unit_cost: true,
        default_supplier_name: true,
        forecasts: {
          ...(forecastDate
            ? {
                where: {
                  forecast_date: forecastDate,
                },
              }
            : {}),
          orderBy: [{ created_at: "desc" }, { forecast_id: "desc" }],
          take: 1,
          select: {
            forecast_id: true,
            recommended_purchase_quantity: true,
            reorder_point_quantity: true,
            available_quantity: true,
          },
        },
      },
    });
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const supply of suppliesWithLatestForecast) {
      const forecast = supply.forecasts[0];
      if (!forecast || forecast.recommended_purchase_quantity <= 0) {
        continue;
      }

      const timestamp = databaseNow();
      const suggestion = {
        forecast_id: forecast.forecast_id,
        recommended_quantity: forecast.recommended_purchase_quantity,
        requested_quantity: forecast.recommended_purchase_quantity,
        expected_unit_cost: supply.unit_cost,
        supplier_name: supply.default_supplier_name,
        reason: `재주문점 ${Math.ceil(
          forecast.reorder_point_quantity
        ).toLocaleString()} / 현재 사용가능 ${forecast.available_quantity.toLocaleString()}`,
        updated_at: timestamp,
      };
      const existing = await tx.supply_reorder_requests.findFirst({
        where: {
          supply_id: supply.supply_id,
          request_status: {
            in: OPEN_REORDER_STATUSES,
          },
        },
        select: {
          reorder_request_id: true,
          request_status: true,
          revision: true,
        },
      });

      if (existing) {
        if (existing.request_status !== SUPPLY_REORDER_STATUS.suggested) {
          skippedCount += 1;
          continue;
        }

        const refreshed = await tx.supply_reorder_requests.updateMany({
          where: {
            reorder_request_id: existing.reorder_request_id,
            request_status: SUPPLY_REORDER_STATUS.suggested,
            revision: existing.revision,
          },
          data: { ...suggestion, revision: { increment: 1 } },
        });

        if (refreshed.count === 1) {
          updatedCount += 1;
        } else {
          skippedCount += 1;
        }
        continue;
      }

      const resolved = await insertOrObserve({
        name: "supply_reorder_requests.open_supply",
        insert: () => tx.$queryRaw<Array<{ reorder_request_id: number }>>(
          Prisma.sql`
          INSERT INTO supply_reorder_requests (
            supply_id,
            forecast_id,
            request_status,
            recommended_quantity,
            requested_quantity,
            expected_unit_cost,
            supplier_name,
            reason,
            created_by_user_id,
            created_at,
            updated_at
          ) VALUES (
            ${supply.supply_id},
            ${suggestion.forecast_id},
            ${SUPPLY_REORDER_STATUS.suggested},
            ${suggestion.recommended_quantity},
            ${suggestion.requested_quantity},
            ${suggestion.expected_unit_cost},
            ${suggestion.supplier_name},
            ${suggestion.reason},
            ${user.userId},
            ${timestamp},
            ${timestamp}
          )
          ON CONFLICT (supply_id)
          WHERE request_status IN ('SUGGESTED', 'REQUESTED', 'APPROVED', 'ORDERED')
          DO NOTHING
          RETURNING reorder_request_id
          `
        ),
        observe: () => tx.supply_reorder_requests.findFirst({
          where: {
            supply_id: supply.supply_id,
            request_status: { in: OPEN_REORDER_STATUSES },
          },
          select: { reorder_request_id: true },
        }),
      });

      if (resolved.inserted) {
        createdCount += 1;
      } else {
        skippedCount += 1;
      }
    }

    await writeActivityLog(tx, {
      user,
      actionType: "SUPPLY_REORDER_SUGGESTIONS_CREATE",
      targetType: "SUPPLY_REORDER",
      targetId: `${createdCount} items`,
      afterValue: {
        createdCount,
        updatedCount,
        skippedCount,
      },
    });

    return {
      createdCount,
      updatedCount,
      skippedCount,
    };
  });
}

export async function updateSupplyReorderRequest(
  client: PrismaClient,
  input: SupplyInput,
  user: AuthUser
) {
  const reorderRequestId = positiveInteger(input.reorderRequestId, "재구매 요청 ID");
  const status = reorderStatus(input.requestStatus);
  const expectedStatus = reorderStatus(input.expectedRequestStatus);
  const expectedRevision = requiredExpectedRevision(input, "비품 재구매 요청");
  const requestedQuantity =
    input.requestedQuantity === ""
      ? null
      : idFromBody(input, "requestedQuantity");
  const orderedQuantity =
    input.orderedQuantity === ""
      ? null
      : idFromBody(input, "orderedQuantity");
  const receivedQuantity =
    input.receivedQuantity === ""
      ? null
      : idFromBody(input, "receivedQuantity");
  const expectedUnitCost =
    input.expectedUnitCost === ""
      ? null
      : idFromBody(input, "expectedUnitCost");
  const supplierName = nullableText(input.supplierName);
  const reason = nullableText(input.reason);
  const editableValues: SupplyReorderEditableValues = {
    requestStatus: status,
    requestedQuantity,
    orderedQuantity,
    receivedQuantity,
    expectedUnitCost,
    supplierName,
    reason,
  };
  const timestamp = databaseNow();

  return client.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT reorder_request_id
      FROM supply_reorder_requests
      WHERE reorder_request_id = ${reorderRequestId}
      FOR UPDATE
    `;
    const before = await tx.supply_reorder_requests.findUniqueOrThrow({
      where: { reorder_request_id: reorderRequestId },
    });

    if (status === SUPPLY_REORDER_STATUS.received && !receivedQuantity) {
      throw publicBadRequest(
        "SUPPLY_REORDER_RECEIVED_QUANTITY_REQUIRED",
        "SUPPLY_REORDER_RECEIVED_QUANTITY_REQUIRED"
      );
    }

    if (
      before.request_status === SUPPLY_REORDER_STATUS.received &&
      (status !== SUPPLY_REORDER_STATUS.received ||
        receivedQuantity !== before.received_quantity)
    ) {
      throw publicConflict(
        "SUPPLY_REORDER_RECEIPT_FINALIZED",
        "SUPPLY_REORDER_RECEIPT_FINALIZED"
      );
    }

    if (before.revision !== expectedRevision) {
      if (supplyReorderEditableValuesMatch(before, editableValues)) {
        return before;
      }

      throw publicConflict(
        "SUPPLY_REORDER_STALE_STATE",
        "SUPPLY_REORDER_STALE_STATE",
        {
          expectedRevision,
          currentRevision: before.revision,
          expectedStatus,
          currentStatus: before.request_status,
        }
      );
    }

    if (before.request_status !== expectedStatus) {
      throw supplyReorderConcurrentStateError(before, {
        expectedStatus,
        requestedStatus: status,
        receivedQuantity,
      });
    }

    if (supplyReorderEditableValuesMatch(before, editableValues)) {
      return before;
    }

    const updateData = {
      request_status: status,
      requested_quantity: requestedQuantity,
      ordered_quantity: orderedQuantity,
      received_quantity: receivedQuantity,
      expected_unit_cost: expectedUnitCost,
      supplier_name: supplierName,
      reason,
      approved_by_user_id:
        status === SUPPLY_REORDER_STATUS.approved
          ? user.userId
          : before.approved_by_user_id,
      ordered_at:
        status === SUPPLY_REORDER_STATUS.ordered && !before.ordered_at
          ? timestamp
          : before.ordered_at,
      received_at:
        status === SUPPLY_REORDER_STATUS.received && !before.received_at
          ? timestamp
          : before.received_at,
      updated_at: timestamp,
      revision: { increment: 1 },
    } satisfies Prisma.supply_reorder_requestsUncheckedUpdateManyInput;

    const updateResult = await tx.supply_reorder_requests
      .updateMany({
        where: {
          reorder_request_id: reorderRequestId,
          request_status: expectedStatus,
          revision: expectedRevision,
        },
        data: updateData,
      })
      .catch((error: unknown) => {
        if (isUniqueConflict(error)) {
          throw publicConflict(
            "SUPPLY_REORDER_OPEN_CONFLICT",
            "SUPPLY_REORDER_OPEN_CONFLICT"
          );
        }

        throw error;
      });

    if (updateResult.count !== 1) {
      const current = await tx.supply_reorder_requests.findUniqueOrThrow({
        where: { reorder_request_id: reorderRequestId },
      });
      if (supplyReorderEditableValuesMatch(current, editableValues)) {
        return current;
      }

      throw supplyReorderConcurrentStateError(current, {
        expectedStatus,
        requestedStatus: status,
        receivedQuantity,
      });
    }

    const updated = await tx.supply_reorder_requests.findUniqueOrThrow({
      where: { reorder_request_id: reorderRequestId },
    });

    if (
      status === SUPPLY_REORDER_STATUS.received &&
      receivedQuantity &&
      before.request_status !== SUPPLY_REORDER_STATUS.received
    ) {
      await recordSupplyMovementInTransaction(
        tx,
        {
          supplyId: updated.supply_id,
          movementType: SUPPLY_MOVEMENT_TYPE.inbound,
          quantity: receivedQuantity,
          reason: "재구매 입고",
          sourceType: "SUPPLY_REORDER",
          sourceId: String(reorderRequestId),
          idempotencyKey: supplyReorderReceiptIdempotencyKey(reorderRequestId),
        },
        user
      );
    }

    await writeActivityLog(tx, {
      user,
      actionType: "SUPPLY_REORDER_UPDATE",
      targetType: "SUPPLY_REORDER",
      targetId: reorderRequestId,
      beforeValue: before,
      afterValue: updated,
    });

    return updated;
  });
}
