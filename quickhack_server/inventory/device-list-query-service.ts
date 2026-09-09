import { prisma } from "@/quickhack_server/core/prisma";
import { publicBadRequest } from "@/quickhack_server/core/public-error";
import {
  DEVICE_LIST_CONTEXT,
  DEVICE_LIST_SORT_KEYS,
  type DeviceListColumnFilters,
  type DeviceListContext,
  type DeviceListPage,
  type DeviceListRow,
  type DeviceListSortDirection,
  type DeviceListSortKey,
} from "@/quickhack_shared/device/device-list-query";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import {
  apiDate,
  apiDateTime,
  databaseDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

type QueryClient = Pick<typeof prisma, "$queryRawUnsafe">;

type DeviceListDatabaseRow = {
  device_id: number | bigint;
  revision: number | bigint;
  pg_no: string;
  imei: string | null;
  adb_serial: string | null;
  model: string;
  model_code: string | null;
  model_seq: number | bigint | null;
  storage: string | null;
  color: string | null;
  sale_grade: string | null;
  warranty: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  inbound_id: number | bigint | null;
  inbound_revision: number | bigint | null;
  inbound_batch_id: number | bigint | null;
  batch_date: Date | string | null;
  batch_no: number | bigint | null;
  supplier_name: string | null;
  purchase_price: number | bigint | null;
  received_at: Date | string | null;
  price_agreed_at: Date | string | null;
  inbound_status: string | null;
  inbound_note: string | null;
  inventory_id: number | bigint | null;
  inventory_revision: number | bigint | null;
  inventory_status: string | null;
  inventory_location: string | null;
  stocked_at: Date | string | null;
  appearance_grade: string | null;
  appearance_defect: string | null;
  appearance_checked_at: Date | string | null;
  function_defect: string | null;
  function_checked_at: Date | string | null;
  display_status: string;
  cursor_null_rank: number | bigint;
  cursor_sort_value: string | number | bigint | null;
};

type CursorPayload = {
  version: 1;
  context: DeviceListContext;
  sort: DeviceListSortKey;
  direction: DeviceListSortDirection;
  nullRank: 0 | 1;
  value: string | number;
  deviceId: number;
};

type ParsedQuery = {
  context: DeviceListContext;
  search: string;
  model: string;
  status: string;
  inventoryOnly: boolean;
  includeFacets: boolean;
  filters: DeviceListColumnFilters;
  sort: DeviceListSortKey;
  direction: DeviceListSortDirection;
  cursor: CursorPayload | null;
  limit: number;
};

export function deviceListQueryInputFromSearchParams(
  searchParams: URLSearchParams,
  context: DeviceListContext
) {
  return {
    context,
    search: searchParams.get("q"),
    model: searchParams.get("model"),
    status: searchParams.get("status"),
    inventoryOnly: searchParams.get("inventoryOnly"),
    includeFacets: searchParams.get("includeFacets"),
    sort: searchParams.get("sort"),
    direction: searchParams.get("direction"),
    cursor: searchParams.get("cursor"),
    limit: searchParams.get("limit"),
    filters: {
      pgNo: searchParams.get("pgNo"),
      model: searchParams.get("modelText"),
      modelSeq: searchParams.get("modelSeq"),
      imei: searchParams.get("imei"),
      saleGrade: searchParams.get("saleGrade"),
      status: searchParams.get("statusText"),
      batchNo: searchParams.get("batchNo"),
      supplierName: searchParams.get("supplierName"),
      location: searchParams.get("location"),
    },
  };
}

type SortDefinition = {
  expression: string;
  nullRank: string;
  valueType: "number" | "text" | "dateTime";
};

const displayStatusExpression = `CASE
  WHEN li.inbound_status = '${INBOUND_STATUS.purchased}'
    AND inv.inventory_status IS NOT NULL
    THEN inv.inventory_status
  ELSE COALESCE(li.inbound_status, inv.inventory_status, '${INBOUND_STATUS.received}')
END`;

const sortDefinitions: Record<DeviceListSortKey, SortDefinition> = {
  pgNo: {
    expression: "LOWER(d.pg_no)",
    nullRank: "CAST(0 AS INTEGER)",
    valueType: "text",
  },
  model: {
    expression:
      "LOWER(d.model || ' ' || COALESCE(d.storage, '') || ' ' || COALESCE(d.color, ''))",
    nullRank: "CAST(0 AS INTEGER)",
    valueType: "text",
  },
  modelSeq: {
    expression: "COALESCE(d.model_seq, -1)",
    nullRank: "CASE WHEN d.model_seq IS NULL THEN 1 ELSE 0 END",
    valueType: "number",
  },
  imei: {
    expression: "LOWER(COALESCE(d.imei, ''))",
    nullRank: "CASE WHEN d.imei IS NULL OR d.imei = '' THEN 1 ELSE 0 END",
    valueType: "text",
  },
  saleGrade: {
    expression: "LOWER(COALESCE(d.sale_grade, ''))",
    nullRank:
      "CASE WHEN d.sale_grade IS NULL OR d.sale_grade = '' THEN 1 ELSE 0 END",
    valueType: "text",
  },
  status: {
    expression: `LOWER(${displayStatusExpression})`,
    nullRank: "CAST(0 AS INTEGER)",
    valueType: "text",
  },
  batchNo: {
    expression: "COALESCE(ib.batch_no, -1)",
    nullRank: "CASE WHEN ib.batch_no IS NULL THEN 1 ELSE 0 END",
    valueType: "number",
  },
  supplierName: {
    expression: "LOWER(COALESCE(li.supplier_name, ''))",
    nullRank:
      "CASE WHEN li.supplier_name IS NULL OR li.supplier_name = '' THEN 1 ELSE 0 END",
    valueType: "text",
  },
  location: {
    expression: "LOWER(COALESCE(inv.location, ''))",
    nullRank:
      "CASE WHEN inv.location IS NULL OR inv.location = '' THEN 1 ELSE 0 END",
    valueType: "text",
  },
  updatedAt: {
    expression: "d.updated_at",
    nullRank: "CAST(0 AS INTEGER)",
    valueType: "dateTime",
  },
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function parseContext(value: unknown): DeviceListContext {
  const normalized = text(value).toUpperCase() || DEVICE_LIST_CONTEXT.inventory;
  if (!Object.values(DEVICE_LIST_CONTEXT).includes(normalized as DeviceListContext)) {
    throw publicBadRequest(
      "DEVICE_LIST_CONTEXT_INVALID",
      "DEVICE_LIST_CONTEXT_INVALID"
    );
  }
  return normalized as DeviceListContext;
}

function parseSort(value: unknown): DeviceListSortKey {
  const normalized = text(value) || "updatedAt";
  if (!DEVICE_LIST_SORT_KEYS.includes(normalized as DeviceListSortKey)) {
    throw publicBadRequest(
      "DEVICE_LIST_SORT_INVALID",
      "DEVICE_LIST_SORT_INVALID"
    );
  }
  return normalized as DeviceListSortKey;
}

function parseDirection(value: unknown): DeviceListSortDirection {
  const normalized = text(value).toLowerCase() || "desc";
  if (normalized !== "asc" && normalized !== "desc") {
    throw publicBadRequest(
      "DEVICE_LIST_DIRECTION_INVALID",
      "DEVICE_LIST_DIRECTION_INVALID"
    );
  }
  return normalized;
}

function parseLimit(value: unknown) {
  if (!text(value)) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw publicBadRequest(
      "DEVICE_LIST_LIMIT_INVALID",
      "DEVICE_LIST_LIMIT_INVALID"
    );
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseBoolean(value: unknown) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return false;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw publicBadRequest(
    "DEVICE_LIST_BOOLEAN_INVALID",
    "DEVICE_LIST_BOOLEAN_INVALID"
  );
}

function encodeCursor(payload: CursorPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  value: unknown,
  expected: Pick<CursorPayload, "context" | "sort" | "direction">
) {
  const normalized = text(value);
  if (!normalized) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(normalized, "base64url").toString("utf8")
    ) as Partial<CursorPayload>;
    const validValue =
      typeof parsed.value === "string" ||
      (typeof parsed.value === "number" && Number.isFinite(parsed.value));
    const validDateTimeValue =
      expected.sort !== "updatedAt" ||
      (typeof parsed.value === "string" &&
        Number.isFinite(Date.parse(parsed.value)));

    if (
      parsed.version !== 1 ||
      parsed.context !== expected.context ||
      parsed.sort !== expected.sort ||
      parsed.direction !== expected.direction ||
      (parsed.nullRank !== 0 && parsed.nullRank !== 1) ||
      !validValue ||
      !validDateTimeValue ||
      !Number.isSafeInteger(parsed.deviceId) ||
      Number(parsed.deviceId) <= 0
    ) {
      throw new Error("invalid cursor payload");
    }

    return parsed as CursorPayload;
  } catch {
    throw publicBadRequest(
      "DEVICE_LIST_CURSOR_INVALID",
      "DEVICE_LIST_CURSOR_INVALID"
    );
  }
}

function normalizeFilters(value: unknown): DeviceListColumnFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: DeviceListColumnFilters = {};

  for (const key of DEVICE_LIST_SORT_KEYS) {
    if (key === "updatedAt") continue;
    const normalized = text(source[key]).slice(0, 100);
    if (normalized) result[key] = normalized;
  }
  return result;
}

export function parseDeviceListQuery(input: {
  context?: unknown;
  search?: unknown;
  model?: unknown;
  status?: unknown;
  inventoryOnly?: unknown;
  includeFacets?: unknown;
  filters?: unknown;
  sort?: unknown;
  direction?: unknown;
  cursor?: unknown;
  limit?: unknown;
}): ParsedQuery {
  const context = parseContext(input.context);
  const sort = parseSort(input.sort);
  const direction = parseDirection(input.direction);

  return {
    context,
    search: text(input.search).slice(0, 100),
    model: text(input.model).slice(0, 100),
    status: text(input.status).toUpperCase().slice(0, 100),
    inventoryOnly: parseBoolean(input.inventoryOnly),
    includeFacets: parseBoolean(input.includeFacets),
    filters: normalizeFilters(input.filters),
    sort,
    direction,
    cursor: decodeCursor(input.cursor, { context, sort, direction }),
    limit: parseLimit(input.limit),
  };
}

function likePattern(value: string) {
  return `%${value.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

function integer(value: number | bigint | null) {
  return value === null ? null : Number(value);
}

function latestInspectionCompletedAt(row: DeviceListDatabaseRow) {
  return [row.appearance_checked_at, row.function_checked_at]
    .map(apiDateTime)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

function mapRow(row: DeviceListDatabaseRow): DeviceListRow {
  return {
    deviceId: Number(row.device_id),
    revision: Number(row.revision),
    pgNo: row.pg_no,
    imei: row.imei,
    adbSerial: row.adb_serial,
    model: row.model,
    modelCode: row.model_code,
    modelSeq: integer(row.model_seq),
    storage: row.storage,
    color: row.color,
    appearanceGrade: row.appearance_grade,
    appearanceDefect: row.appearance_defect,
    functionDefect: row.function_defect,
    saleGrade: row.sale_grade,
    warranty: row.warranty,
    displayStatus: row.display_status,
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
    appearanceCheckedAt: apiDateTime(row.appearance_checked_at),
    functionCheckedAt: apiDateTime(row.function_checked_at),
    inspectionCompletedAt: latestInspectionCompletedAt(row),
    inbound: row.inbound_status
      ? {
          id: Number(row.inbound_id),
          revision: Number(row.inbound_revision),
          batchId: integer(row.inbound_batch_id),
          batchDate: apiDate(row.batch_date),
          batchNo: integer(row.batch_no),
          supplierName: row.supplier_name,
          purchasePrice: integer(row.purchase_price),
          receivedAt: apiDateTime(row.received_at),
          priceAgreedAt: apiDateTime(row.price_agreed_at),
          status: row.inbound_status,
          note: row.inbound_note,
        }
      : null,
    inventory: row.inventory_status
      ? {
          id: Number(row.inventory_id),
          revision: Number(row.inventory_revision),
          status: row.inventory_status,
          location: row.inventory_location,
          stockedAt: apiDateTime(row.stocked_at),
        }
      : null,
  };
}

function appendContains(
  where: string[],
  parameters: unknown[],
  expression: string,
  value: string
) {
  if (!value) return;
  where.push(
    `LOWER(COALESCE(${expression}, '')) LIKE ${pushParameter(
      parameters,
      likePattern(value)
    )} ESCAPE '\\'`
  );
}

function pushParameter(parameters: unknown[], value: unknown) {
  parameters.push(value);
  return `$${parameters.length}`;
}

export async function queryDeviceListPage(
  input: Parameters<typeof parseDeviceListQuery>[0],
  client: QueryClient = prisma
): Promise<DeviceListPage> {
  const parsed = parseDeviceListQuery(input);
  const sort = sortDefinitions[parsed.sort];
  const where: string[] = [];
  const parameters: unknown[] = [
    INSPECTION_TYPE.appearance,
    INSPECTION_TYPE.function,
  ];

  if (parsed.context === DEVICE_LIST_CONTEXT.audit) {
    where.push(
      `inv.inventory_status = ${pushParameter(
        parameters,
        INVENTORY_STATUS.sellable
      )}`
    );
  } else if (parsed.context === DEVICE_LIST_CONTEXT.purchasePending) {
    where.push(
      `li.inbound_status = ${pushParameter(
        parameters,
        INBOUND_STATUS.inspected
      )}`
    );
    where.push(`NOT EXISTS (
      SELECT 1
      FROM inbounds newer_inbound
      WHERE newer_inbound.pg_no = li.pg_no
        AND newer_inbound.inbound_id > li.inbound_id
    )`);
  }

  if (parsed.inventoryOnly) {
    where.push("inv.inventory_id IS NOT NULL");
  }
  if (parsed.model) {
    where.push(`d.model = ${pushParameter(parameters, parsed.model)}`);
  }
  if (parsed.status) {
    where.push(
      `${displayStatusExpression} = ${pushParameter(parameters, parsed.status)}`
    );
  }

  if (parsed.search) {
    const pattern = likePattern(parsed.search);
    const searchableExpressions = [
      "d.pg_no",
      "d.imei",
      "d.model",
      "CAST(d.model_seq AS TEXT)",
      "d.storage",
      "d.color",
      "ai.appearance_grade",
      "ai.appearance_defect",
      "fi.function_defect",
      "d.sale_grade",
      "d.warranty",
      "li.supplier_name",
      "inv.location",
    ];
    where.push(
      `(${searchableExpressions
        .map(
          (expression) =>
            `LOWER(COALESCE(${expression}, '')) LIKE ${pushParameter(
              parameters,
              pattern
            )} ESCAPE '\\'`
        )
        .join(" OR ")})`
    );
  }

  appendContains(where, parameters, "d.pg_no", parsed.filters.pgNo ?? "");
  appendContains(
    where,
    parameters,
    "d.model || ' ' || COALESCE(d.storage, '') || ' ' || COALESCE(d.color, '')",
    parsed.filters.model ?? ""
  );
  appendContains(
    where,
    parameters,
    "CAST(d.model_seq AS TEXT)",
    parsed.filters.modelSeq ?? ""
  );
  appendContains(where, parameters, "d.imei", parsed.filters.imei ?? "");
  appendContains(
    where,
    parameters,
    "d.sale_grade",
    parsed.filters.saleGrade ?? ""
  );
  appendContains(
    where,
    parameters,
    displayStatusExpression,
    parsed.filters.status ?? ""
  );
  appendContains(
    where,
    parameters,
    "CAST(ib.batch_no AS TEXT)",
    parsed.filters.batchNo ?? ""
  );
  appendContains(
    where,
    parameters,
    "li.supplier_name",
    parsed.filters.supplierName ?? ""
  );
  appendContains(
    where,
    parameters,
    "inv.location",
    parsed.filters.location ?? ""
  );

  if (parsed.cursor) {
    const comparison = parsed.direction === "asc" ? ">" : "<";
    const cursorNullRankAfter = pushParameter(
      parameters,
      parsed.cursor.nullRank
    );
    const cursorNullRankEqual = pushParameter(
      parameters,
      parsed.cursor.nullRank
    );
    const cursorValue =
      sort.valueType === "dateTime"
        ? databaseDateTime(String(parsed.cursor.value))
        : parsed.cursor.value;
    const cursorValueAfter = pushParameter(parameters, cursorValue);
    const cursorValueEqual = pushParameter(parameters, cursorValue);
    const cursorDeviceId = pushParameter(parameters, parsed.cursor.deviceId);
    where.push(`(
      ${sort.nullRank} > ${cursorNullRankAfter}
      OR (
        ${sort.nullRank} = ${cursorNullRankEqual}
        AND (
          ${sort.expression} ${comparison} ${cursorValueAfter}
          OR (${sort.expression} = ${cursorValueEqual} AND d.device_id < ${cursorDeviceId})
        )
      )
    )`);
  }

  const latestInboundJoin = `LEFT JOIN inbounds li ON li.inbound_id = (
    SELECT latest_inbound.inbound_id
    FROM inbounds latest_inbound
    WHERE latest_inbound.pg_no = d.pg_no
    ORDER BY latest_inbound.inbound_id DESC
    LIMIT 1
  )`;
  const fromClause =
    parsed.context === DEVICE_LIST_CONTEXT.purchasePending
      ? `FROM inbounds li
         JOIN devices d ON d.pg_no = li.pg_no
         LEFT JOIN inventory inv ON inv.pg_no = d.pg_no`
      : parsed.context === DEVICE_LIST_CONTEXT.audit
        ? `FROM inventory inv
           JOIN devices d ON d.pg_no = inv.pg_no
           ${latestInboundJoin}`
        : `FROM devices d
           ${latestInboundJoin}
           LEFT JOIN inventory inv ON inv.pg_no = d.pg_no`;

  const sql = `
    SELECT
      d.device_id,
      d.revision,
      d.pg_no,
      d.imei,
      d.adb_serial,
      d.model,
      d.model_code,
      d.model_seq,
      d.storage,
      d.color,
      d.sale_grade,
      d.warranty,
      d.created_at,
      d.updated_at,
      li.inbound_id,
      li.revision AS inbound_revision,
      li.inbound_batch_id,
      ib.batch_date,
      ib.batch_no,
      li.supplier_name,
      li.purchase_price,
      li.received_at,
      li.price_agreed_at,
      li.inbound_status,
      li.note AS inbound_note,
      inv.inventory_id,
      inv.revision AS inventory_revision,
      inv.inventory_status,
      inv.location AS inventory_location,
      inv.stocked_at,
      ai.appearance_grade,
      ai.appearance_defect,
      ai.appearance_checked_at,
      fi.function_defect,
      fi.function_checked_at,
      ${displayStatusExpression} AS display_status,
      ${sort.nullRank} AS cursor_null_rank,
      ${sort.expression} AS cursor_sort_value
    ${fromClause}
    LEFT JOIN inbound_batches ib
      ON ib.inbound_batch_id = li.inbound_batch_id
    LEFT JOIN inspections ai ON ai.inspection_id = (
      SELECT latest_appearance.inspection_id
      FROM inspections latest_appearance
      WHERE latest_appearance.pg_no = d.pg_no
        AND latest_appearance.inspection_type = $1
      ORDER BY latest_appearance.inspection_id DESC
      LIMIT 1
    )
    LEFT JOIN inspections fi ON fi.inspection_id = (
      SELECT latest_function.inspection_id
      FROM inspections latest_function
      WHERE latest_function.pg_no = d.pg_no
        AND latest_function.inspection_type = $2
      ORDER BY latest_function.inspection_id DESC
      LIMIT 1
    )
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${sort.nullRank} ASC, ${sort.expression} ${parsed.direction.toUpperCase()}, d.device_id DESC
    LIMIT ${pushParameter(parameters, parsed.limit + 1)}
  `;

  const rows = await client.$queryRawUnsafe<DeviceListDatabaseRow[]>(
    sql,
    ...parameters
  );
  const hasMore = rows.length > parsed.limit;
  const pageRows = hasMore ? rows.slice(0, parsed.limit) : rows;
  const last = pageRows.at(-1) ?? null;
  const cursorValue = last?.cursor_sort_value;
  const normalizedCursorValue =
    !last
      ? ""
      : sort.valueType === "number"
      ? Number(cursorValue ?? -1)
      : sort.valueType === "dateTime"
        ? requiredApiDateTime(last.updated_at)
        : String(cursorValue ?? "");
  const facets = parsed.includeFacets
    ? {
        models: (
          await client.$queryRawUnsafe<Array<{ model: string }>>(
            "SELECT DISTINCT model FROM devices WHERE model <> '' ORDER BY model ASC"
          )
        ).map((row) => row.model),
      }
    : undefined;

  return {
    items: pageRows.map(mapRow),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            version: 1,
            context: parsed.context,
            sort: parsed.sort,
            direction: parsed.direction,
            nullRank: Number(last.cursor_null_rank) === 1 ? 1 : 0,
            value: normalizedCursorValue,
            deviceId: Number(last.device_id),
          })
        : null,
    ...(facets ? { facets } : {}),
  };
}
