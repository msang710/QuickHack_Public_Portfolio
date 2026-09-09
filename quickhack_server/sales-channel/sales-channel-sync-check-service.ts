import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  expectedCoupangInventoryQuantity,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-projection-service";
import {
  refreshCoupangInventoryVerification,
  type InventoryVerificationDependencies,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import {
  listSalesChannelWriteRequests,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-review-service";
import {
  presentSalesChannelWriteControl,
  presentSalesChannelWriteRequest,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-review-response";
import {
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REVIEW_STATUSES,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES,
  SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS,
  SALES_CHANNEL_SYNC_CHECK_KIND,
  type SalesChannelClaimIntegritySyncCheckItem,
  type SalesChannelInventoryRecheckResponseDto,
  type SalesChannelInventoryVerificationStatus,
  type SalesChannelInventoryVerificationSyncCheckItem,
  type SalesChannelSyncCheckItem,
  type SalesChannelSyncCheckListResponseDto,
  type SalesChannelSyncCheckQueryKind,
  type SalesChannelWriteSyncCheckItem,
} from "@/quickhack_shared/sales-channel/sync-checks";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 1000;
const GROUPED_STATUS_VALUES = ["ALL", "UNRESOLVED"] as const;
const WRITE_STATUS_VALUES = Object.values(SALES_CHANNEL_WRITE_REQUEST_STATUS);
const INVENTORY_STATUS_VALUES = Object.values(
  SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS
);
const QUERY_KIND_VALUES = new Set<string>(
  Object.values(SALES_CHANNEL_SYNC_CHECK_KIND)
);
const QUERY_STATUS_VALUES = new Set<string>([
  ...GROUPED_STATUS_VALUES,
  ...WRITE_STATUS_VALUES,
  ...INVENTORY_STATUS_VALUES,
  "INVALID",
]);
const INVENTORY_STATUS_SET = new Set<string>(INVENTORY_STATUS_VALUES);
const RECHECKABLE_STATUS_SET = new Set<string>(
  SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES
);

const inventoryStateRelations = {
  mapping: {
    select: {
      external_product_id: true,
      external_option_name: true,
    },
  },
  sales_offer: {
    select: {
      offer_code: true,
      storage_match_mode: true,
      color_match_mode: true,
      model_option: { select: { label: true } },
      storage_option: { select: { label: true } },
      color_option: { select: { label: true } },
      warranty_group_option: { select: { label: true } },
    },
  },
} satisfies Prisma.sales_channel_inventory_verification_statesInclude;

type InventoryVerificationStateRow =
  Prisma.sales_channel_inventory_verification_statesGetPayload<{
    include: typeof inventoryStateRelations;
  }>;

export type SalesChannelSyncCheckQuery = {
  kind: SalesChannelSyncCheckQueryKind;
  status: string;
  search: string;
  limit: number;
  cursor: {
    updatedAt: Date;
    kind: Exclude<SalesChannelSyncCheckQueryKind, "ALL">;
    id: number;
  } | null;
};

function invalidQuery(message: string): never {
  throw publicBadRequest("INVALID_SALES_CHANNEL_SYNC_CHECK_QUERY", message);
}

function normalizedUpper(value: unknown, fallback: string) {
  const text = String(value ?? "").trim().toUpperCase();
  return text || fallback;
}

function parseLimit(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_LIMIT;
  }

  const text = String(value).trim();

  if (!/^\d+$/.test(text)) {
    return invalidQuery("조회 건수는 1부터 1000 사이의 정수여야 합니다.");
  }

  const limit = Number(text);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return invalidQuery("조회 건수는 1부터 1000 사이의 정수여야 합니다.");
  }

  return limit;
}

export function parseSalesChannelSyncCheckQuery(input: {
  kind?: unknown;
  status?: unknown;
  search?: unknown;
  limit?: unknown;
  cursor?: unknown;
}): SalesChannelSyncCheckQuery {
  const kind = normalizedUpper(input.kind, SALES_CHANNEL_SYNC_CHECK_KIND.all);
  const status = normalizedUpper(input.status, "UNRESOLVED");

  if (!QUERY_KIND_VALUES.has(kind)) {
    return invalidQuery("지원하지 않는 점검 종류입니다.");
  }

  if (!QUERY_STATUS_VALUES.has(status)) {
    return invalidQuery("지원하지 않는 점검 상태입니다.");
  }

  let cursor: SalesChannelSyncCheckQuery["cursor"] = null;
  const cursorText = String(input.cursor ?? "").trim();
  if (cursorText) {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursorText, "base64url").toString("utf8")
      ) as { updatedAt?: unknown; kind?: unknown; id?: unknown };
      const updatedAt = new Date(String(parsed.updatedAt ?? ""));
      const cursorKind = String(parsed.kind ?? "").trim();
      const id = Number(parsed.id);
      if (
        Number.isNaN(updatedAt.getTime()) ||
        ![
          SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest,
          SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification,
          SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity,
        ].includes(
          cursorKind as Exclude<SalesChannelSyncCheckQueryKind, "ALL">
        ) ||
        !Number.isSafeInteger(id) ||
        id <= 0
      ) {
        return invalidQuery("조회 커서가 올바르지 않습니다.");
      }
      cursor = {
        updatedAt,
        kind: cursorKind as Exclude<SalesChannelSyncCheckQueryKind, "ALL">,
        id,
      };
    } catch {
      return invalidQuery("조회 커서가 올바르지 않습니다.");
    }
  }

  return {
    kind: kind as SalesChannelSyncCheckQueryKind,
    status,
    search: String(input.search ?? "").trim(),
    limit: parseLimit(input.limit),
    cursor,
  };
}

function cursorModeForKind(
  sourceKind: Exclude<SalesChannelSyncCheckQueryKind, "ALL">,
  cursor: NonNullable<SalesChannelSyncCheckQuery["cursor"]>
) {
  const order = sourceKind.localeCompare(cursor.kind);
  return order < 0 ? "BEFORE" : order > 0 ? "AT_OR_BEFORE" : "EXACT";
}

function encodeSyncCheckCursor(
  item: SalesChannelSyncCheckItem,
  updatedAt: Date
) {
  return Buffer.from(
    JSON.stringify({
      updatedAt: updatedAt.toISOString(),
      kind: item.kind,
      id: item.id,
    }),
    "utf8"
  ).toString("base64url");
}

function inventoryStatusWhere(
  status: string
): Prisma.sales_channel_inventory_verification_statesWhereInput | null {
  if (status === "ALL") return {};

  if (status === "UNRESOLVED") {
    return {
      verification_status: {
        in: [...SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES],
      },
    };
  }

  if (!INVENTORY_STATUS_SET.has(status)) return null;
  return { verification_status: status };
}

function inventorySearchWhere(
  search: string
): Prisma.sales_channel_inventory_verification_statesWhereInput {
  if (!search) return {};

  const contains = { contains: search };

  return {
    OR: [
      { external_vendor_item_id: contains },
      { last_error_code: contains },
      { last_error_message: contains },
      { mapping: { is: { external_product_id: contains } } },
      { mapping: { is: { external_option_name: contains } } },
      { sales_offer: { is: { offer_code: contains } } },
      { sales_offer: { is: { model_option: { is: { label: contains } } } } },
      {
        sales_offer: {
          is: { storage_option: { is: { label: contains } } },
        },
      },
      { sales_offer: { is: { color_option: { is: { label: contains } } } } },
      {
        sales_offer: {
          is: { warranty_group_option: { is: { label: contains } } },
        },
      },
    ],
  };
}

export function presentSalesChannelInventoryVerification(
  row: InventoryVerificationStateRow
): SalesChannelInventoryVerificationSyncCheckItem {
  const verificationStatus =
    row.verification_status as SalesChannelInventoryVerificationStatus;
  const expectedChannelQuantity = expectedCoupangInventoryQuantity(
    row.ledger_quantity,
    row.pending_order_quantity
  );
  const channelQuantity = row.channel_quantity;

  return {
    kind: SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification,
    id: row.verification_state_id,
    verificationStateId: row.verification_state_id,
    mappingId: row.mapping_id,
    channel: row.channel,
    status: verificationStatus,
    verificationStatus,
    updatedAt: requiredApiDateTime(row.updated_at),
    externalProductId: row.mapping.external_product_id ?? "",
    externalVendorItemId: row.external_vendor_item_id,
    externalOptionName: row.mapping.external_option_name ?? "",
    salesOfferId: row.sales_offer_id,
    offerCode: row.sales_offer?.offer_code ?? "",
    model: row.sales_offer?.model_option.label ?? "",
    storageMatchMode: row.sales_offer?.storage_match_mode ?? "",
    storage: row.sales_offer?.storage_option?.label ?? "",
    colorMatchMode: row.sales_offer?.color_match_mode ?? "",
    color: row.sales_offer?.color_option?.label ?? "",
    warranty: row.sales_offer?.warranty_group_option.label ?? "",
    desiredVersion: row.desired_version,
    processingVersion: row.processing_version,
    ledgerQuantity: row.ledger_quantity,
    pendingOrderQuantity: row.pending_order_quantity,
    expectedChannelQuantity,
    channelQuantity,
    difference:
      channelQuantity === null
        ? null
        : channelQuantity - expectedChannelQuantity,
    retryCount: row.retry_count,
    mismatchSince: apiDateTime(row.mismatch_since) ?? "",
    lastCheckedAt: apiDateTime(row.last_checked_at) ?? "",
    resolvedAt: apiDateTime(row.resolved_at) ?? "",
    lastErrorCode: row.last_error_code ?? "",
    lastErrorMessage: row.last_error_message ?? "",
    lastApiCallLogId: row.last_api_call_log_id,
    lastWorkerJobId: row.last_worker_job_id,
  };
}

function presentWriteSyncCheckItem(
  row: Parameters<typeof presentSalesChannelWriteRequest>[0]
): SalesChannelWriteSyncCheckItem {
  const item = presentSalesChannelWriteRequest(row);

  return {
    ...item,
    kind: SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest,
    status: item.requestStatus,
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function compareSyncCheckItems(
  left: SalesChannelSyncCheckItem,
  right: SalesChannelSyncCheckItem
) {
  const updatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAt !== 0) return updatedAt;

  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;

  return right.id - left.id;
}

export async function listSalesChannelSyncChecks(
  query: SalesChannelSyncCheckQuery
): Promise<SalesChannelSyncCheckListResponseDto> {
  const includeWrite =
    query.kind !== SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification &&
    query.kind !== SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity;
  const includeInventory =
    query.kind !== SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest &&
    query.kind !== SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity;
  const includeClaimIntegrity =
    query.kind === SALES_CHANNEL_SYNC_CHECK_KIND.all ||
    query.kind === SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity;
  const claimStatusAllowed =
    query.status === "ALL" ||
    query.status === "UNRESOLVED" ||
    query.status === "INVALID";
  const inventoryWhere = includeInventory
    ? inventoryStatusWhere(query.status)
    : null;
  const pageSize = query.limit + 1;

  const writeResultPromise = includeWrite
    ? listSalesChannelWriteRequests({
        status: query.status,
        search: query.search,
        limit: pageSize,
        sortBy: "UPDATED_AT",
        updatedCursor: query.cursor
          ? {
              updatedAt: query.cursor.updatedAt,
              id: query.cursor.id,
              mode: cursorModeForKind(
                SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest,
                query.cursor
              ),
            }
          : undefined,
      })
    : Promise.resolve(null);
  const fallbackWriteUnresolvedCountPromise = includeWrite
    ? Promise.resolve(null)
    : prisma.sales_channel_write_requests.count({
        where: {
          request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
        },
      });
  const inventoryBaseWhere = inventoryWhere
    ? { AND: [inventoryWhere, inventorySearchWhere(query.search)] }
    : null;
  const inventoryPageWhere = inventoryBaseWhere
    ? query.cursor
      ? {
          AND: [
            inventoryBaseWhere,
            cursorModeForKind(
              SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification,
              query.cursor
            ) === "BEFORE"
              ? { updated_at: { lt: query.cursor.updatedAt } }
              : cursorModeForKind(
                    SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification,
                    query.cursor
                  ) === "AT_OR_BEFORE"
                ? { updated_at: { lte: query.cursor.updatedAt } }
                : {
                    OR: [
                      { updated_at: { lt: query.cursor.updatedAt } },
                      {
                        updated_at: query.cursor.updatedAt,
                        verification_state_id: { lt: query.cursor.id },
                      },
                    ],
                  },
          ],
        }
      : inventoryBaseWhere
    : null;
  const inventoryRowsPromise = inventoryPageWhere
    ? prisma.sales_channel_inventory_verification_states.findMany({
        where: inventoryPageWhere,
        orderBy: [
          { updated_at: "desc" },
          { verification_state_id: "desc" },
        ],
        take: pageSize,
        include: inventoryStateRelations,
      })
    : Promise.resolve([] as InventoryVerificationStateRow[]);
  const inventoryFilteredCountPromise = inventoryBaseWhere
    ? prisma.sales_channel_inventory_verification_states.count({
        where: inventoryBaseWhere,
      })
    : Promise.resolve(0);
  const inventoryUnresolvedCountPromise =
    prisma.sales_channel_inventory_verification_states.count({
      where: {
        verification_status: {
          in: [...SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES],
        },
      },
    });
  const claimSearch = query.search ? { contains: query.search } : null;
  const returnIntegrityBaseWhere: Prisma.coupang_return_rawWhereInput | null =
    includeClaimIntegrity && claimStatusAllowed
      ? {
          item_integrity_status: { not: "VALID" },
          ...(claimSearch
            ? {
                OR: [
                  { external_receipt_id: claimSearch },
                  { external_order_id: claimSearch },
                  { external_shipment_id: claimSearch },
                ],
              }
            : {}),
        }
      : null;
  const exchangeIntegrityBaseWhere: Prisma.coupang_exchange_rawWhereInput | null =
    includeClaimIntegrity && claimStatusAllowed
      ? {
          scope_integrity_status: { not: "VALID" },
          ...(claimSearch
            ? {
                OR: [
                  { external_exchange_id: claimSearch },
                  { external_order_id: claimSearch },
                  { external_shipment_id: claimSearch },
                ],
              }
            : {}),
        }
      : null;
  const returnIntegrityRowsPromise = returnIntegrityBaseWhere
    ? prisma.coupang_return_raw.findMany({
        where: {
          AND: [returnIntegrityBaseWhere, returnIntegrityCursorWhere(query)],
        },
        orderBy: [
          { updated_at: "desc" },
          { coupang_return_raw_id: "desc" },
        ],
        take: pageSize,
      })
    : Promise.resolve([]);
  const exchangeIntegrityRowsPromise = exchangeIntegrityBaseWhere
    ? prisma.coupang_exchange_raw.findMany({
        where: {
          AND: [exchangeIntegrityBaseWhere, exchangeIntegrityCursorWhere(query)],
        },
        orderBy: [
          { updated_at: "desc" },
          { coupang_exchange_raw_id: "desc" },
        ],
        take: pageSize,
      })
    : Promise.resolve([]);
  const returnIntegrityFilteredCountPromise = returnIntegrityBaseWhere
    ? prisma.coupang_return_raw.count({ where: returnIntegrityBaseWhere })
    : Promise.resolve(0);
  const exchangeIntegrityFilteredCountPromise = exchangeIntegrityBaseWhere
    ? prisma.coupang_exchange_raw.count({ where: exchangeIntegrityBaseWhere })
    : Promise.resolve(0);
  const claimIntegrityUnresolvedCountPromise = Promise.all([
    prisma.coupang_return_raw.count({
      where: { item_integrity_status: { not: "VALID" } },
    }),
    prisma.coupang_exchange_raw.count({
      where: { scope_integrity_status: { not: "VALID" } },
    }),
  ]).then(([returns, exchanges]) => returns + exchanges);
  const [
    writeResult,
    fallbackWriteUnresolvedCount,
    inventoryRows,
    inventoryFilteredCount,
    inventoryVerificationUnresolvedCount,
    returnIntegrityRows,
    exchangeIntegrityRows,
    returnIntegrityFilteredCount,
    exchangeIntegrityFilteredCount,
    claimIntegrityUnresolvedCount,
  ] = await Promise.all([
    writeResultPromise,
    fallbackWriteUnresolvedCountPromise,
    inventoryRowsPromise,
    inventoryFilteredCountPromise,
    inventoryUnresolvedCountPromise,
    returnIntegrityRowsPromise,
    exchangeIntegrityRowsPromise,
    returnIntegrityFilteredCountPromise,
    exchangeIntegrityFilteredCountPromise,
    claimIntegrityUnresolvedCountPromise,
  ]);
  const writeRequestUnresolvedCount =
    writeResult?.unresolvedCount ?? fallbackWriteUnresolvedCount ?? 0;
  const writeItems = (writeResult?.rows ?? []).map(presentWriteSyncCheckItem);
  const inventoryItems = inventoryRows.map(
    presentSalesChannelInventoryVerification
  );
  const claimIntegrityItems = [
    ...returnIntegrityRows.map(presentReturnIntegrity),
    ...exchangeIntegrityRows.map(presentExchangeIntegrity),
  ];
  const cursorUpdatedAtByItem = new Map<string, Date>([
    ...(writeResult?.rows ?? []).map(
      (row) =>
        [
          `${SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest}:${row.sales_channel_write_request_id}`,
          row.updated_at,
        ] as const
    ),
    ...inventoryRows.map(
      (row) =>
        [
          `${SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification}:${row.verification_state_id}`,
          row.updated_at,
        ] as const
    ),
    ...returnIntegrityRows.map(
      (row) =>
        [
          `${SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity}:${row.coupang_return_raw_id * 2}`,
          row.updated_at,
        ] as const
    ),
    ...exchangeIntegrityRows.map(
      (row) =>
        [
          `${SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity}:${row.coupang_exchange_raw_id * 2 + 1}`,
          row.updated_at,
        ] as const
    ),
  ]);
  const candidates: SalesChannelSyncCheckItem[] = [
    ...writeItems,
    ...inventoryItems,
    ...claimIntegrityItems,
  ].sort(compareSyncCheckItems);
  const hasMore = candidates.length > query.limit;
  const items = candidates.slice(0, query.limit);
  const lastItem = items.at(-1) ?? null;
  const lastItemUpdatedAt = lastItem
    ? cursorUpdatedAtByItem.get(`${lastItem.kind}:${lastItem.id}`) ?? null
    : null;

  return {
    ok: true,
    count: items.length,
    totalCount:
      (writeResult?.filteredCount ?? 0) +
      inventoryFilteredCount +
      returnIntegrityFilteredCount +
      exchangeIntegrityFilteredCount,
    limit: query.limit,
    unresolvedCount:
      writeRequestUnresolvedCount +
      inventoryVerificationUnresolvedCount +
      claimIntegrityUnresolvedCount,
    unresolvedCounts: {
      writeRequest: writeRequestUnresolvedCount,
      inventoryVerification: inventoryVerificationUnresolvedCount,
      claimIntegrity: claimIntegrityUnresolvedCount,
    },
    controls: (writeResult?.controls ?? []).map(
      presentSalesChannelWriteControl
    ),
    items,
    hasMore,
    nextCursor:
      hasMore && lastItem && lastItemUpdatedAt
        ? encodeSyncCheckCursor(lastItem, lastItemUpdatedAt)
        : null,
    coverage: "COMPLETE",
  };
}

function claimCursorMode(query: SalesChannelSyncCheckQuery) {
  return query.cursor
    ? cursorModeForKind(SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity, query.cursor)
    : null;
}

function returnIntegrityCursorWhere(
  query: SalesChannelSyncCheckQuery
): Prisma.coupang_return_rawWhereInput {
  if (!query.cursor) return {};
  const mode = claimCursorMode(query);
  if (mode === "BEFORE") return { updated_at: { lt: query.cursor.updatedAt } };
  if (mode === "AT_OR_BEFORE") {
    return { updated_at: { lte: query.cursor.updatedAt } };
  }
  const maximumRawId = Math.floor((query.cursor.id - 1) / 2);
  return {
    OR: [
      { updated_at: { lt: query.cursor.updatedAt } },
      ...(maximumRawId > 0
        ? [
            {
              updated_at: query.cursor.updatedAt,
              coupang_return_raw_id: { lte: maximumRawId },
            },
          ]
        : []),
    ],
  };
}

function exchangeIntegrityCursorWhere(
  query: SalesChannelSyncCheckQuery
): Prisma.coupang_exchange_rawWhereInput {
  if (!query.cursor) return {};
  const mode = claimCursorMode(query);
  if (mode === "BEFORE") return { updated_at: { lt: query.cursor.updatedAt } };
  if (mode === "AT_OR_BEFORE") {
    return { updated_at: { lte: query.cursor.updatedAt } };
  }
  const maximumRawId = Math.floor((query.cursor.id - 2) / 2);
  return {
    OR: [
      { updated_at: { lt: query.cursor.updatedAt } },
      ...(maximumRawId > 0
        ? [
            {
              updated_at: query.cursor.updatedAt,
              coupang_exchange_raw_id: { lte: maximumRawId },
            },
          ]
        : []),
    ],
  };
}

function presentReturnIntegrity(row: {
  coupang_return_raw_id: number;
  external_receipt_id: string;
  external_order_id: string;
  external_shipment_id: string | null;
  item_integrity_status: string;
  updated_at: Date;
}): SalesChannelClaimIntegritySyncCheckItem {
  return {
    kind: SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity,
    id: row.coupang_return_raw_id * 2,
    status: "INVALID",
    updatedAt: requiredApiDateTime(row.updated_at),
    claimType: "RETURN",
    externalClaimId: row.external_receipt_id,
    externalOrderId: row.external_order_id,
    externalShipmentId: row.external_shipment_id ?? "",
    integrityStatus: row.item_integrity_status,
    messageCode: "RETURN_ITEM_QUANTITY_MISMATCH",
  };
}

function presentExchangeIntegrity(row: {
  coupang_exchange_raw_id: number;
  external_exchange_id: string;
  external_order_id: string;
  external_shipment_id: string | null;
  scope_integrity_status: string;
  updated_at: Date;
}): SalesChannelClaimIntegritySyncCheckItem {
  return {
    kind: SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity,
    id: row.coupang_exchange_raw_id * 2 + 1,
    status: "INVALID",
    updatedAt: requiredApiDateTime(row.updated_at),
    claimType: "EXCHANGE",
    externalClaimId: row.external_exchange_id,
    externalOrderId: row.external_order_id,
    externalShipmentId: row.external_shipment_id ?? "",
    integrityStatus: row.scope_integrity_status,
    messageCode: "EXCHANGE_ORIGINAL_SHIPMENT_UNKNOWN",
  };
}

export async function findSalesChannelInventoryVerificationState(
  verificationStateId: number
) {
  return prisma.sales_channel_inventory_verification_states.findUnique({
    where: { verification_state_id: verificationStateId },
    include: inventoryStateRelations,
  });
}

export async function getSalesChannelInventoryVerificationItem(
  verificationStateId: number
) {
  const state = await findSalesChannelInventoryVerificationState(
    verificationStateId
  );

  if (!state) {
    throw publicNotFound(
      "INVENTORY_VERIFICATION_NOT_FOUND",
      "INVENTORY_VERIFICATION_NOT_FOUND"
    );
  }

  return presentSalesChannelInventoryVerification(state);
}

export async function recheckSalesChannelInventoryVerification(input: {
  verificationStateId: number;
  dependencies?: InventoryVerificationDependencies;
}): Promise<Omit<SalesChannelInventoryRecheckResponseDto, "ok">> {
  const state = await prisma.sales_channel_inventory_verification_states.findUnique({
    where: { verification_state_id: input.verificationStateId },
    select: {
      mapping_id: true,
      verification_status: true,
    },
  });

  if (!state) {
    throw publicNotFound(
      "INVENTORY_VERIFICATION_NOT_FOUND",
      "INVENTORY_VERIFICATION_NOT_FOUND"
    );
  }

  if (!RECHECKABLE_STATUS_SET.has(state.verification_status)) {
    throw publicConflict(
      "INVENTORY_VERIFICATION_NOT_RECHECKABLE",
      "INVENTORY_VERIFICATION_NOT_RECHECKABLE",
      {
        verificationStateId: input.verificationStateId,
        verificationStatus: state.verification_status,
      }
    );
  }

  const result = await refreshCoupangInventoryVerification({
    mappingId: state.mapping_id,
    dependencies: input.dependencies,
  });
  const latest = await findSalesChannelInventoryVerificationState(
    input.verificationStateId
  );

  if (!latest) {
    throw publicNotFound(
      "INVENTORY_VERIFICATION_NOT_FOUND",
      "INVENTORY_VERIFICATION_NOT_FOUND"
    );
  }

  return {
    outcome: result.outcome,
    item: presentSalesChannelInventoryVerification(latest),
  };
}
