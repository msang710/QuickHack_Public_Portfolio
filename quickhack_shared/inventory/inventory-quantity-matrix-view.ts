import { INVENTORY_STATUS, type InventoryStatusCode } from "@/quickhack_shared/inventory/inventory-status";
import type {
  InventoryQuantityMatrixRowDto,
  InventoryQuantityMovementPageDto,
} from "@/quickhack_shared/inventory/inventory-quantity";

export type InventoryQuantityMatrixPreset =
  | "SUMMARY"
  | "OUTBOUND"
  | "EXCEPTIONS"
  | "ALL";

export type InventoryQuantityMatrixColumn =
  | {
      key: "SELLABLE_SUMMARY";
      kind: "SELLABLE";
    }
  | {
      key: "TODAY_ORDER";
      kind: "TODAY_ORDER";
    }
  | {
      key: "PRE_PURCHASE";
      kind: "PRE_PURCHASE";
    }
  | {
      key: "PRIMARY_TOTAL";
      kind: "PRIMARY_TOTAL";
    }
  | {
      key: `STATUS:${string}`;
      kind: "STATUS";
      inventoryStatus: string;
    };

export type InventoryQuantityMatrixPresetDefinition = {
  columns: readonly InventoryQuantityMatrixColumn[];
};

const statusColumn = (
  inventoryStatus: InventoryStatusCode
): InventoryQuantityMatrixColumn => ({
  key: `STATUS:${inventoryStatus}`,
  kind: "STATUS",
  inventoryStatus,
});

const ALL_STATUS_COLUMNS = [
  INVENTORY_STATUS.sellable,
  INVENTORY_STATUS.reserved,
  INVENTORY_STATUS.packing,
  INVENTORY_STATUS.packed,
  INVENTORY_STATUS.departure,
  INVENTORY_STATUS.delivering,
  INVENTORY_STATUS.finalDelivery,
  INVENTORY_STATUS.noneTracking,
  INVENTORY_STATUS.hold,
  INVENTORY_STATUS.defective,
  INVENTORY_STATUS.returnRequested,
  INVENTORY_STATUS.exchangeRequested,
  INVENTORY_STATUS.returnCheck,
].map(statusColumn);

export const INVENTORY_QUANTITY_MATRIX_PRESETS: Record<
  InventoryQuantityMatrixPreset,
  InventoryQuantityMatrixPresetDefinition
> = {
  SUMMARY: {
    columns: [
      {
        key: "SELLABLE_SUMMARY",
        kind: "SELLABLE",
      },
      {
        key: "TODAY_ORDER",
        kind: "TODAY_ORDER",
      },
      {
        key: "PRE_PURCHASE",
        kind: "PRE_PURCHASE",
      },
      {
        key: "PRIMARY_TOTAL",
        kind: "PRIMARY_TOTAL",
      },
    ],
  },
  OUTBOUND: {
    columns: [
      INVENTORY_STATUS.reserved,
      INVENTORY_STATUS.packing,
      INVENTORY_STATUS.packed,
      INVENTORY_STATUS.departure,
      INVENTORY_STATUS.delivering,
      INVENTORY_STATUS.finalDelivery,
    ].map(statusColumn),
  },
  EXCEPTIONS: {
    columns: [
      INVENTORY_STATUS.hold,
      INVENTORY_STATUS.defective,
      INVENTORY_STATUS.returnRequested,
      INVENTORY_STATUS.exchangeRequested,
      INVENTORY_STATUS.returnCheck,
      INVENTORY_STATUS.noneTracking,
    ].map(statusColumn),
  },
  ALL: {
    columns: ALL_STATUS_COLUMNS,
  },
};

export const TODAY_ORDER_INVENTORY_STATUSES = [
  INVENTORY_STATUS.reserved,
  INVENTORY_STATUS.packing,
  INVENTORY_STATUS.packed,
  INVENTORY_STATUS.departure,
] as const;

export type InventoryQuantityMetric = {
  calculatedQuantity: number | null;
  displayQuantity: number | null;
  detailKind: "MOVEMENT" | "TODAY_ORDER" | "PRE_PURCHASE" | null;
  balanceId: number | null;
  inventoryStatus: string | null;
};

export type InventoryQuantityModelGroup = {
  groupKey: string;
  model: string;
  rows: InventoryQuantityMatrixRowDto[];
  activeSkuCount: number;
  inactiveSkuCount: number;
  unclassifiedRowCount: number;
};

export type FilteredInventoryQuantityModelGroups = {
  groups: InventoryQuantityModelGroup[];
  autoExpandedGroupKeys: string[];
};

function normalizedSearchText(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("ko-KR");
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, "ko-KR", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareRows(
  left: InventoryQuantityMatrixRowDto,
  right: InventoryQuantityMatrixRowDto
) {
  return (
    naturalCompare(left.storage, right.storage) ||
    naturalCompare(left.color, right.color) ||
    naturalCompare(left.saleGrade, right.saleGrade) ||
    naturalCompare(left.rowKey, right.rowKey)
  );
}

function groupKey(model: string) {
  return `MODEL:${encodeURIComponent(model)}`;
}

function createGroup(
  model: string,
  rows: InventoryQuantityMatrixRowDto[]
): InventoryQuantityModelGroup {
  return {
    groupKey: groupKey(model),
    model,
    rows: [...rows].sort(compareRows),
    activeSkuCount: rows.filter(
      (row) => row.rowKind === "SKU" && row.skuActive
    ).length,
    inactiveSkuCount: rows.filter(
      (row) => row.rowKind === "SKU" && !row.skuActive
    ).length,
    unclassifiedRowCount: rows.filter(
      (row) => row.rowKind === "UNCLASSIFIED_INBOUND"
    ).length,
  };
}

export function buildInventoryQuantityModelGroups(
  rows: readonly InventoryQuantityMatrixRowDto[]
) {
  const rowsByModel = new Map<string, InventoryQuantityMatrixRowDto[]>();

  for (const row of rows) {
    const model = row.model.trim() || "미정";
    const currentRows = rowsByModel.get(model) ?? [];
    currentRows.push(row);
    rowsByModel.set(model, currentRows);
  }

  return Array.from(rowsByModel.entries())
    .sort(([left], [right]) => naturalCompare(left, right))
    .map(([model, modelRows]) => createGroup(model, modelRows));
}

function rowMatchesSearch(
  row: InventoryQuantityMatrixRowDto,
  normalizedQuery: string
) {
  const fields = [
    row.model,
    row.skuCode,
    row.storage,
    row.color,
    row.saleGrade,
    ...row.prePurchase.devices.map((device) => device.pgNo),
  ];

  return fields.some((field) =>
    normalizedSearchText(field).includes(normalizedQuery)
  );
}

export function filterInventoryQuantityModelGroups(
  groups: readonly InventoryQuantityModelGroup[],
  query: string
): FilteredInventoryQuantityModelGroups {
  const normalizedQuery = normalizedSearchText(query);

  if (!normalizedQuery) {
    return {
      groups: [...groups],
      autoExpandedGroupKeys: [],
    };
  }

  const filteredGroups: InventoryQuantityModelGroup[] = [];

  for (const group of groups) {
    const groupMatches = normalizedSearchText(group.model).includes(
      normalizedQuery
    );
    const matchingRows = groupMatches
      ? group.rows
      : group.rows.filter((row) => rowMatchesSearch(row, normalizedQuery));

    if (matchingRows.length === 0) {
      continue;
    }

    filteredGroups.push(createGroup(group.model, matchingRows));
  }

  return {
    groups: filteredGroups,
    autoExpandedGroupKeys: filteredGroups.map((group) => group.groupKey),
  };
}

function cellForStatus(
  row: InventoryQuantityMatrixRowDto,
  inventoryStatus: string
) {
  return row.cells.find(
    (candidate) => candidate.inventoryStatus === inventoryStatus
  );
}

function statusMetric(
  row: InventoryQuantityMatrixRowDto,
  inventoryStatus: string
): InventoryQuantityMetric {
  const cell = cellForStatus(row, inventoryStatus);
  const quantity = cell?.quantity ?? null;
  const balanceId = cell?.balanceId ?? null;

  return {
    calculatedQuantity: quantity,
    displayQuantity: balanceId === null ? null : quantity,
    detailKind: balanceId === null ? null : "MOVEMENT",
    balanceId,
    inventoryStatus,
  };
}

function summedStatusMetric(
  row: InventoryQuantityMatrixRowDto,
  inventoryStatuses: readonly string[]
): InventoryQuantityMetric {
  const cells = inventoryStatuses.map((inventoryStatus) =>
    cellForStatus(row, inventoryStatus)
  );

  if (cells.some((cell) => cell?.quantity === null || cell === undefined)) {
    return {
      calculatedQuantity: null,
      displayQuantity: null,
      detailKind: null,
      balanceId: null,
      inventoryStatus: null,
    };
  }

  const calculatedQuantity = cells.reduce(
    (sum, cell) => sum + (cell?.quantity ?? 0),
    0
  );
  const hasBalance = cells.some((cell) => cell?.balanceId !== null);

  return {
    calculatedQuantity,
    displayQuantity: hasBalance ? calculatedQuantity : null,
    detailKind: hasBalance ? "TODAY_ORDER" : null,
    balanceId: null,
    inventoryStatus: null,
  };
}

export function inventoryQuantityMetricForRow(
  row: InventoryQuantityMatrixRowDto,
  column: InventoryQuantityMatrixColumn
): InventoryQuantityMetric {
  if (column.kind === "STATUS") {
    return statusMetric(row, column.inventoryStatus);
  }

  if (column.kind === "SELLABLE") {
    return statusMetric(row, INVENTORY_STATUS.sellable);
  }

  if (column.kind === "TODAY_ORDER") {
    return summedStatusMetric(row, TODAY_ORDER_INVENTORY_STATUSES);
  }

  if (column.kind === "PRE_PURCHASE") {
    const quantity =
      row.prePurchase.inspectingQuantity +
      row.prePurchase.inspectedQuantity;

    return {
      calculatedQuantity: quantity,
      displayQuantity: quantity,
      detailKind:
        row.prePurchase.devices.length > 0 ? "PRE_PURCHASE" : null,
      balanceId: null,
      inventoryStatus: null,
    };
  }

  const sellable = statusMetric(row, INVENTORY_STATUS.sellable);
  const todayOrder = summedStatusMetric(
    row,
    TODAY_ORDER_INVENTORY_STATUSES
  );

  if (
    sellable.calculatedQuantity === null ||
    todayOrder.calculatedQuantity === null
  ) {
    return {
      calculatedQuantity: null,
      displayQuantity: null,
      detailKind: null,
      balanceId: null,
      inventoryStatus: null,
    };
  }

  const quantity =
    sellable.calculatedQuantity +
    todayOrder.calculatedQuantity +
    row.prePurchase.inspectingQuantity +
    row.prePurchase.inspectedQuantity;

  return {
    calculatedQuantity: quantity,
    displayQuantity: quantity,
    detailKind: null,
    balanceId: null,
    inventoryStatus: null,
  };
}

export function inventoryQuantityMetricForGroup(
  group: InventoryQuantityModelGroup,
  column: InventoryQuantityMatrixColumn
): InventoryQuantityMetric {
  const rowMetrics = group.rows.map((row) =>
    inventoryQuantityMetricForRow(row, column)
  );

  if (
    rowMetrics.some((metric) => metric.calculatedQuantity === null)
  ) {
    return {
      calculatedQuantity: null,
      displayQuantity: null,
      detailKind: null,
      balanceId: null,
      inventoryStatus:
        column.kind === "STATUS" ? column.inventoryStatus : null,
    };
  }

  const quantity = rowMetrics.reduce(
    (sum, metric) => sum + (metric.calculatedQuantity ?? 0),
    0
  );

  return {
    calculatedQuantity: quantity,
    displayQuantity: quantity,
    detailKind: null,
    balanceId: null,
    inventoryStatus:
      column.kind === "STATUS" ? column.inventoryStatus : null,
  };
}

export function mergeInventoryQuantityMovementPages(
  current: InventoryQuantityMovementPageDto | null,
  next: InventoryQuantityMovementPageDto
): InventoryQuantityMovementPageDto {
  if (!current || current.balance.balanceId !== next.balance.balanceId) {
    return next;
  }

  const movementIds = new Set<number>();
  const items = [...current.items, ...next.items].filter((movement) => {
    if (movementIds.has(movement.movementId)) {
      return false;
    }

    movementIds.add(movement.movementId);
    return true;
  });

  return {
    balance: next.balance,
    items,
    nextCursor: next.nextCursor,
  };
}
