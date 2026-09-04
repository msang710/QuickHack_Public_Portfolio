import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { buildInboundReconciliation } from "@/quickhack_server/inbound/inbound-reconciliation-service";
import { loadLatestInbounds } from "@/quickhack_server/inbound/latest-inbound-loader";
import { todayKstDate } from "@/quickhack_shared/core/time";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import type {
  InventoryLedgerAvailability,
  InventoryQuantityBalanceDto,
  InventoryQuantityMatrixPayload,
  InventoryQuantityMatrixRowDto,
  InventoryQuantityMovementPageDto,
  InventoryQuantityMovementDto,
} from "@/quickhack_shared/inventory/inventory-quantity";
import { PublicError } from "@/quickhack_server/core/public-error";
import {
  apiDateTime,
  databaseDate,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

function text(value: unknown) {
  return String(value ?? "").trim();
}

const skuInclude = {
  model_option: true,
  storage_option: true,
  color_option: true,
  sale_grade_option: true,
} satisfies Prisma.inventory_skusInclude;

const inventoryStatuses = Object.values(INVENTORY_STATUS);
const inventoryStatusSet = new Set<string>(inventoryStatuses);
const todayOrderStatuses = new Set<string>([
  INVENTORY_STATUS.reserved,
  INVENTORY_STATUS.packing,
  INVENTORY_STATUS.packed,
  INVENTORY_STATUS.departure,
]);
const prePurchaseStatuses = new Set<string>([
  INBOUND_STATUS.inspecting,
  INBOUND_STATUS.inspected,
]);

const skuMatrixInclude = {
  ...skuInclude,
  quantity_balances: {
    orderBy: { inventory_status: "asc" as const },
  },
} satisfies Prisma.inventory_skusInclude;

type InventoryLedgerAvailabilityInput = {
  inventoryCount: number;
  unclassifiedInventoryCount: number;
  unknownInventoryStatusCount: number;
  balanceCount: number;
  unknownBalanceStatusCount: number;
  movementCount: number;
  balanceQuantity: number;
};

export function resolveInventoryLedgerAvailability({
  inventoryCount,
  unclassifiedInventoryCount,
  unknownInventoryStatusCount,
  balanceCount,
  unknownBalanceStatusCount,
  movementCount,
  balanceQuantity,
}: InventoryLedgerAvailabilityInput): InventoryLedgerAvailability {
  const ledgerIsEmpty = balanceCount === 0 && movementCount === 0;
  const ledgerIsOneSided =
    (balanceCount === 0 && movementCount > 0) ||
    (balanceCount > 0 && movementCount === 0);
  const hasClassificationMismatch =
    unclassifiedInventoryCount > 0 ||
    unknownInventoryStatusCount > 0 ||
    unknownBalanceStatusCount > 0;

  if (ledgerIsEmpty) {
    if (hasClassificationMismatch) {
      return "PARTIAL";
    }

    return inventoryCount > 0 ? "PARTIAL" : "EMPTY";
  }

  if (
    ledgerIsOneSided ||
    hasClassificationMismatch ||
    balanceQuantity !== inventoryCount
  ) {
    return "PARTIAL";
  }

  return "READY";
}

function displayDimension(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || "미정";
}

function unclassifiedRowKey(input: {
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
}) {
  return `UNCLASSIFIED:${[
    input.model,
    input.storage,
    input.color,
    input.saleGrade,
  ]
    .map(encodeURIComponent)
    .join(":")}`;
}

function sumBalanceStatuses(
  balances: readonly { inventory_status: string; quantity: number }[],
  statuses: ReadonlySet<string>
) {
  return balances
    .filter((balance) => statuses.has(balance.inventory_status))
    .reduce((sum, balance) => sum + balance.quantity, 0);
}

function prePurchaseQuantity(rows: readonly InventoryQuantityMatrixRowDto[]) {
  return rows.reduce(
    (sum, row) =>
      sum +
      row.prePurchase.inspectingQuantity +
      row.prePurchase.inspectedQuantity,
    0
  );
}

function addPrePurchaseDevice(
  row: InventoryQuantityMatrixRowDto,
  inbound: InventoryQuantityMatrixRowDto["prePurchase"]["devices"][number]
) {
  row.prePurchase.devices.push(inbound);

  if (inbound.inboundStatus === INBOUND_STATUS.inspecting) {
    row.prePurchase.inspectingQuantity += 1;
  } else if (inbound.inboundStatus === INBOUND_STATUS.inspected) {
    row.prePurchase.inspectedQuantity += 1;
  }
}

function balanceDto(row: Prisma.inventory_quantity_balancesGetPayload<{
  include: { inventory_sku: { include: typeof skuInclude } };
}>): InventoryQuantityBalanceDto {
  return {
    balanceId: row.inventory_quantity_balance_id,
    inventorySkuId: row.inventory_sku_id,
    skuCode: row.inventory_sku.sku_code,
    model: row.inventory_sku.model_option.label,
    storage: row.inventory_sku.storage_option.label,
    color: row.inventory_sku.color_option.label,
    saleGrade: row.inventory_sku.sale_grade_option.option_key,
    inventoryStatus: row.inventory_status,
    quantity: row.quantity,
    version: row.version,
    skuActive: row.inventory_sku.is_active === 1,
    lastMovementAt: apiDateTime(row.last_movement_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function movementDto(row: Prisma.inventory_quantity_movementsGetPayload<{
  include: {
    balance: { include: { inventory_sku: { include: typeof skuInclude } } };
    actor_user: {
      select: {
        user_id: true;
        username: true;
        employee_profiles: { select: { display_name: true } };
      };
    };
  };
}>): InventoryQuantityMovementDto {
  const sku = row.balance.inventory_sku;

  return {
    movementId: row.inventory_quantity_movement_id,
    balanceId: row.inventory_quantity_balance_id,
    inventorySkuId: sku.inventory_sku_id,
    skuCode: sku.sku_code,
    model: sku.model_option.label,
    storage: sku.storage_option.label,
    color: sku.color_option.label,
    saleGrade: sku.sale_grade_option.option_key,
    inventoryStatus: row.balance.inventory_status,
    pgNo: row.pg_no,
    movementType: row.movement_type,
    quantityDelta: row.quantity_delta,
    beforeQuantity: row.before_quantity,
    afterQuantity: row.after_quantity,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    actorName:
      row.actor_user?.employee_profiles?.display_name ??
      row.actor_user?.username ??
      null,
    workerJobId: row.worker_job_id,
    occurredAt: requiredApiDateTime(row.occurred_at),
  };
}

async function loadInventoryQuantityMatrix(
  client: Prisma.TransactionClient
): Promise<InventoryQuantityMatrixPayload> {
  const businessDate = todayKstDate();
  const databaseBusinessDate = databaseDate(businessDate);
  const [
    skuRows,
    inventoryCount,
    unclassifiedInventoryCount,
    unknownInventoryStatusCount,
    movementCount,
    latestInbounds,
    batches,
  ] = await Promise.all([
    client.inventory_skus.findMany({
      orderBy: [
        { model_option_id: "asc" },
        { storage_option_id: "asc" },
        { color_option_id: "asc" },
        { sale_grade_option_id: "asc" },
        { inventory_sku_id: "asc" },
      ],
      include: skuMatrixInclude,
    }),
    client.inventory.count(),
    client.inventory.count({
      where: { devices: { inventory_sku_id: null } },
    }),
    client.inventory.count({
      where: { inventory_status: { notIn: inventoryStatuses } },
    }),
    client.inventory_quantity_movements.count(),
    loadLatestInbounds(client),
    client.inbound_batches.findMany({
      where: { batch_date: databaseBusinessDate },
      select: {
        inbound_batch_id: true,
        batch_date: true,
        batch_no: true,
        expected_quantity: true,
        note: true,
      },
      orderBy: { batch_no: "asc" },
    }),
  ]);
  const allBalances = skuRows.flatMap((sku) => sku.quantity_balances);
  const balanceCount = allBalances.length;
  const balanceQuantity = allBalances.reduce(
    (sum, balance) => sum + balance.quantity,
    0
  );
  const unknownBalanceStatusCount = allBalances.filter(
    (balance) => !inventoryStatusSet.has(balance.inventory_status)
  ).length;
  const availability = resolveInventoryLedgerAvailability({
    inventoryCount,
    unclassifiedInventoryCount,
    unknownInventoryStatusCount,
    balanceCount,
    unknownBalanceStatusCount,
    movementCount,
    balanceQuantity,
  });
  const exposesLedgerQuantity =
    availability === "READY" || availability === "EMPTY";
  const rows: InventoryQuantityMatrixRowDto[] = skuRows.map((sku) => {
    const balancesByStatus = new Map(
      sku.quantity_balances.map((balance) => [
        balance.inventory_status,
        balance,
      ])
    );

    return {
      rowKind: "SKU",
      rowKey: `SKU:${sku.inventory_sku_id}`,
      inventorySkuId: sku.inventory_sku_id,
      skuCode: sku.sku_code,
      model: sku.model_option.label,
      storage: sku.storage_option.label,
      color: sku.color_option.label,
      saleGrade: sku.sale_grade_option.option_key,
      skuActive: sku.is_active === 1,
      cells: inventoryStatuses.map((inventoryStatus) => {
        const balance = balancesByStatus.get(inventoryStatus);

        return {
          balanceId: balance?.inventory_quantity_balance_id ?? null,
          inventoryStatus,
          quantity: exposesLedgerQuantity ? balance?.quantity ?? 0 : null,
          version: balance?.version ?? null,
          lastMovementAt: apiDateTime(balance?.last_movement_at),
          updatedAt: apiDateTime(balance?.updated_at),
        };
      }),
      prePurchase: {
        inspectingQuantity: 0,
        inspectedQuantity: 0,
        devices: [],
      },
    };
  });
  const skuRowsById = new Map(
    rows
      .filter(
        (
          row
        ): row is InventoryQuantityMatrixRowDto & {
          inventorySkuId: number;
        } => row.inventorySkuId !== null
      )
      .map((row) => [row.inventorySkuId, row])
  );
  const unclassifiedRowsByKey = new Map<
    string,
    InventoryQuantityMatrixRowDto
  >();

  for (const inbound of latestInbounds) {
    if (!prePurchaseStatuses.has(inbound.inboundStatus)) {
      continue;
    }

    const skuRow =
      inbound.inventorySkuId === null
        ? undefined
        : skuRowsById.get(inbound.inventorySkuId);

    if (skuRow) {
      addPrePurchaseDevice(skuRow, inbound);
      continue;
    }

    const dimensions = {
      model: displayDimension(inbound.model),
      storage: displayDimension(inbound.storage),
      color: displayDimension(inbound.color),
      saleGrade: displayDimension(inbound.saleGrade),
    };
    const rowKey = unclassifiedRowKey(dimensions);
    let unclassifiedRow = unclassifiedRowsByKey.get(rowKey);

    if (!unclassifiedRow) {
      unclassifiedRow = {
        rowKind: "UNCLASSIFIED_INBOUND",
        rowKey,
        inventorySkuId: null,
        skuCode: null,
        ...dimensions,
        skuActive: null,
        cells: inventoryStatuses.map((inventoryStatus) => ({
          balanceId: null,
          inventoryStatus,
          quantity: exposesLedgerQuantity ? 0 : null,
          version: null,
          lastMovementAt: null,
          updatedAt: null,
        })),
        prePurchase: {
          inspectingQuantity: 0,
          inspectedQuantity: 0,
          devices: [],
        },
      };
      unclassifiedRowsByKey.set(rowKey, unclassifiedRow);
    }

    addPrePurchaseDevice(unclassifiedRow, inbound);
  }

  const unclassifiedRows = Array.from(
    unclassifiedRowsByKey.values()
  ).sort((left, right) =>
    [
      left.model,
      left.storage,
      left.color,
      left.saleGrade,
    ]
      .join("\u0000")
      .localeCompare(
        [
          right.model,
          right.storage,
          right.color,
          right.saleGrade,
        ].join("\u0000"),
        "ko"
      )
  );
  rows.push(...unclassifiedRows);

  const sellableQuantity = allBalances
    .filter(
      (balance) =>
        balance.inventory_status === INVENTORY_STATUS.sellable
    )
    .reduce((sum, balance) => sum + balance.quantity, 0);
  const todayOrderQuantity = sumBalanceStatuses(
    allBalances,
    todayOrderStatuses
  );
  const ledgerTotalQuantity = allBalances.reduce(
    (sum, balance) => sum + balance.quantity,
    0
  );
  const currentPrePurchaseQuantity = prePurchaseQuantity(rows);
  const reconciliation = buildInboundReconciliation({
    businessDate,
    batches,
    latestInbounds,
  });

  return {
    availability,
    summary: {
      skuCount: skuRows.length,
      unclassifiedRowCount: unclassifiedRows.length,
      sellableQuantity: exposesLedgerQuantity ? sellableQuantity : null,
      todayOrderQuantity: exposesLedgerQuantity
        ? todayOrderQuantity
        : null,
      prePurchaseQuantity: currentPrePurchaseQuantity,
      ledgerTotalQuantity: exposesLedgerQuantity
        ? ledgerTotalQuantity
        : null,
      primaryTotalQuantity: exposesLedgerQuantity
        ? sellableQuantity +
          todayOrderQuantity +
          currentPrePurchaseQuantity
        : null,
    },
    rows,
    reconciliation: {
      businessDate: reconciliation.businessDate,
      unassignedPgQuantity: reconciliation.unassignedPgQuantity,
      mismatchedBatchQuantity:
        reconciliation.mismatchedBatchQuantity,
      shortageQuantity: reconciliation.shortageQuantity,
      excessQuantity: reconciliation.excessQuantity,
    },
  };
}

export function getInventoryQuantityMatrix(
  owner: PrismaClient = prisma
): Promise<InventoryQuantityMatrixPayload> {
  return runConsistentReadSnapshot(
    owner,
    "inventory.quantity-ledger.matrix",
    loadInventoryQuantityMatrix
  );
}

export class InventoryQuantityQueryInputError extends PublicError {
  constructor(message: string) {
    super({
      status: 400,
      code: "INVENTORY_QUANTITY_QUERY_INPUT_INVALID",
      message,
    });
    this.name = "InventoryQuantityQueryInputError";
  }
}

type InventoryQuantityMovementPageInput = {
  balanceId: unknown;
  cursor?: unknown;
  limit?: unknown;
};

function positiveInteger(value: unknown, label: string) {
  const parsed = Number(text(value));

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InventoryQuantityQueryInputError(
      "INVENTORY_QUANTITY_QUERY_INPUT_INVALID"
    );
  }

  return parsed;
}

export function normalizeInventoryQuantityMovementPageInput(
  input: InventoryQuantityMovementPageInput
) {
  const balanceId = positiveInteger(input.balanceId, "balanceId");
  const cursorText = text(input.cursor);
  const limitText = text(input.limit);
  const cursor = cursorText
    ? positiveInteger(cursorText, "cursor")
    : undefined;
  const limit = limitText
    ? Math.min(positiveInteger(limitText, "limit"), 100)
    : 50;

  return { balanceId, cursor, limit };
}

export async function getInventoryQuantityMovements(
  client: PrismaClient,
  input: InventoryQuantityMovementPageInput
): Promise<InventoryQuantityMovementPageDto | null> {
  const { balanceId, cursor, limit } =
    normalizeInventoryQuantityMovementPageInput(input);
  const balance = await client.inventory_quantity_balances.findUnique({
    where: { inventory_quantity_balance_id: balanceId },
    include: { inventory_sku: { include: skuInclude } },
  });

  if (!balance) {
    return null;
  }

  const movementRows =
    await client.inventory_quantity_movements.findMany({
      where: {
        inventory_quantity_balance_id: balanceId,
        ...(cursor
          ? {
              inventory_quantity_movement_id: {
                lt: cursor,
              },
            }
          : {}),
      },
      orderBy: { inventory_quantity_movement_id: "desc" },
      take: limit + 1,
      include: {
        balance: { include: { inventory_sku: { include: skuInclude } } },
        actor_user: {
          select: {
            user_id: true,
            username: true,
            employee_profiles: { select: { display_name: true } },
          },
        },
      },
    });
  const hasNextPage = movementRows.length > limit;
  const pageRows = hasNextPage
    ? movementRows.slice(0, limit)
    : movementRows;

  return {
    balance: balanceDto(balance),
    items: pageRows.map(movementDto),
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? pageRows[pageRows.length - 1]
            .inventory_quantity_movement_id
        : null,
  };
}
