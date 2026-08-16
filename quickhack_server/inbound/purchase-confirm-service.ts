// QuickHack object: Purchase confirmation turns inspected inbound devices into sellable inventory.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import {
  PURCHASE_PRICE_ENTRY_MODE,
  type PurchasePriceEntryMode,
} from "@/quickhack_shared/inbound/purchase-price-entry-mode";
import type {
  PurchaseConfirmResultDto,
  PurchaseConfirmResultMode,
} from "@/quickhack_shared/inbound/purchase-confirm";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  explicitActivityLogChangeData,
  type ExplicitActivityLogChange,
} from "@/quickhack_server/audit/structured-log-values";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  recordInventoryCreatedWithLedger,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { claimInboundWorkflowState } from "@/quickhack_server/inbound/inbound-workflow-claim-service";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";
import { allocateNextModelSequence } from "@/quickhack_server/inbound/model-sequence-service";
import { resolveInventorySkuCriteria } from "@/quickhack_server/catalog/inventory-sku-service";
import { lockDeviceAggregateRow } from "@/quickhack_server/inventory/device-aggregate-lock";

const PURCHASE_CONFIRMED_INVENTORY_LOCATION = "상품화 대기";

type PurchaseConfirmInput = Record<string, unknown>;
type PurchaseConfirmItem = {
  pgNo: string;
  expectedInboundId: number;
  expectedInboundRevision: number;
  purchasePrice: number;
  purchasePriceRateId: number | null;
  purchasePriceRateRevision: number | null;
  purchasePriceQueryContext: {
    priceDate: string;
    note: string;
  };
};
type TransactionClient = Prisma.TransactionClient;
type PurchaseConfirmMode = PurchaseConfirmResultMode;
type PurchaseConfirmState = {
  inboundStatus?: string | null;
  purchasePrice?: number | null;
  inventoryStatus?: string | null;
  inventoryLocation?: string | null;
  modelSeq?: number | null;
};
type PurchaseConfirmResult = PurchaseConfirmResultDto & {
  auditReasonCode: string;
  purchasePrice?: number | null;
  modelSeq?: number | null;
  before?: PurchaseConfirmState;
  after?: PurchaseConfirmState;
};
type PurchaseConfirmSummary = {
  confirmedCount: number;
  recoveredCount: number;
  skippedCount: number;
  conflictCount: number;
};
type PurchaseDevice = {
  device_id: number;
  revision: number;
  pg_no: string;
  model: string;
  model_code: string | null;
  storage: string | null;
  color: string | null;
  sale_grade: string | null;
  model_seq: number | null;
  inventory_sku: {
    model_option_id: number;
    storage_option_id: number;
  } | null;
  inspections: {
    inspection_id: number;
    inbound_id: number | null;
    inspection_type: string;
    appearance_grade: string | null;
  }[];
  inventory: {
    inventory_status: string;
    location: string | null;
    stocked_at: Date | null;
  } | null;
};
type PurchaseInbound = {
  inbound_id: number;
  revision: number;
  inbound_status: string;
  purchase_price: number | null;
};
type PurchasePriceEvidence = {
  updatedAt: Date;
  entryMode: PurchasePriceEntryMode;
  referenceRateId: number | null;
  referenceAmount: number | null;
};

async function loadPurchaseDevice(tx: TransactionClient, pgNo: string) {
  return tx.devices.findUnique({
    where: { pg_no: pgNo },
    include: {
      inbounds: {
        orderBy: { inbound_id: "desc" as const },
        take: 1,
      },
      inspections: {
        orderBy: { inspection_id: "desc" as const },
        select: {
          inspection_id: true,
          inbound_id: true,
          inspection_type: true,
          appearance_grade: true,
        },
      },
      inventory: true,
      inventory_sku: {
        select: {
          model_option_id: true,
          storage_option_id: true,
        },
      },
    },
  });
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parsePurchasePrice(value: unknown) {
  const normalized = text(value).replace(/,/g, "");

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseOptionalPositiveId(
  value: unknown,
  label: string,
  errorCode = "PURCHASE_CONFIRM_RATE_EVIDENCE_INVALID"
) {
  const normalized = text(value);

  if (!normalized) {
    return null;
  }

  const parsed = /^\d+$/.test(normalized)
    ? Number.parseInt(normalized, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw publicBadRequest(
      errorCode,
      `${label}이(가) 올바르지 않습니다.`
    );
  }

  return parsed;
}

function parseOptionalRevision(value: unknown) {
  const normalized = text(value);

  if (!normalized) return null;
  const parsed = /^\d+$/.test(normalized)
    ? Number.parseInt(normalized, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw publicBadRequest(
      "PURCHASE_CONFIRM_RATE_EVIDENCE_INVALID",
      "매입가 기준 revision이 올바르지 않습니다."
    );
  }

  return parsed;
}

function parseExpectedInboundRevision(value: unknown) {
  const normalized = text(value);
  const parsed = /^\d+$/.test(normalized)
    ? Number.parseInt(normalized, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw publicBadRequest(
      "PURCHASE_CONFIRM_TARGET_INVALID",
      "입고 회차 revision이 올바르지 않습니다."
    );
  }
  return parsed;
}

function parseItems(input: PurchaseConfirmInput): PurchaseConfirmItem[] {
  const rows = Array.isArray(input.items) ? input.items : [];
  const items = rows
    .map((row) => {
      if (!row || typeof row !== "object") {
        return null;
      }

      const source = row as Record<string, unknown>;
      const pgNo = text(source.pgNo).toUpperCase();
      const purchasePrice = parsePurchasePrice(source.purchasePrice);
      const expectedInboundId = parseOptionalPositiveId(
        source.expectedInboundId,
        "입고 회차 ID",
        "PURCHASE_CONFIRM_TARGET_INVALID"
      );
      const expectedInboundRevision = parseExpectedInboundRevision(
        source.expectedInboundRevision
      );

      if (!pgNo || purchasePrice === null) {
        return null;
      }
      if (expectedInboundId === null) {
        throw publicBadRequest(
          "PURCHASE_CONFIRM_TARGET_INVALID",
          "매입 확정 대상의 입고 회차 ID와 revision이 필요합니다. 목록을 새로 고쳐 주세요."
        );
      }

      return {
        pgNo,
        expectedInboundId,
        expectedInboundRevision,
        purchasePrice,
        purchasePriceRateId: parseOptionalPositiveId(
          source.purchasePriceRateId ?? source.rateId,
          "매입가 기준 ID"
        ),
        purchasePriceRateRevision: parseOptionalRevision(
          source.purchasePriceRateRevision ?? source.rateRevision
        ),
        purchasePriceQueryContext: {
          priceDate: text(
            (source.purchasePriceQueryContext as Record<string, unknown> | null)
              ?.priceDate
          ),
          note: text(
            (source.purchasePriceQueryContext as Record<string, unknown> | null)
              ?.note
          ),
        },
      };
    })
    .filter((item): item is PurchaseConfirmItem => Boolean(item));

  for (const item of items) {
    if (
      (item.purchasePriceRateId === null) !==
      (item.purchasePriceRateRevision === null)
    ) {
      throw publicBadRequest(
        "PURCHASE_CONFIRM_RATE_EVIDENCE_INVALID",
        "매입가 기준 ID와 revision은 함께 제출해야 합니다."
      );
    }
  }

  return [...new Map(items.map((item) => [item.pgNo, item])).values()];
}

async function assignModelSeqIfMissing(
  tx: TransactionClient,
  device: {
    device_id: number;
    revision: number;
    pg_no: string;
    model: string;
    model_seq: number | null;
  },
  timestamp: Date
) {
  if (device.model_seq !== null) {
    return device.model_seq;
  }

  const nextSeq = await allocateNextModelSequence(tx, {
    model: device.model,
    timestamp,
  });
  const updated = await tx.devices.updateMany({
    where: {
      device_id: device.device_id,
      revision: device.revision,
      model_seq: null,
    },
    data: {
      model_seq: nextSeq,
      revision: { increment: 1 },
      updated_at: timestamp,
    },
  });

  if (updated.count !== 1) {
    throw publicConflict(
      "MODEL_SEQUENCE_ASSIGNMENT_CONFLICT",
      `PG ${device.pg_no}의 고유번호가 동시에 변경되어 매입 확정을 중단했습니다.`
    );
  }

  return nextSeq;
}

function buildBeforeState(
  device: PurchaseDevice,
  inbound: PurchaseInbound
): PurchaseConfirmState {
  return {
    inboundStatus: inbound.inbound_status,
    purchasePrice: inbound.purchase_price,
    inventoryStatus: device.inventory?.inventory_status ?? null,
    inventoryLocation: device.inventory?.location ?? null,
    modelSeq: device.model_seq,
  };
}

function inspectionsForInbound(
  inspections: PurchaseDevice["inspections"],
  inboundId: number
) {
  return inspections.filter(
    (inspection) => inspection.inbound_id === inboundId
  );
}

function latestAppearanceGrade(device: PurchaseDevice) {
  return (
    device.inspections.find(
      (inspection) =>
        inspection.inspection_type === INSPECTION_TYPE.appearance &&
        inspection.appearance_grade
    )?.appearance_grade ?? null
  );
}

async function resolvePurchasePriceEvidence(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  timestamp: Date
): Promise<PurchasePriceEvidence> {
  const manualEvidence: PurchasePriceEvidence = {
    updatedAt: timestamp,
    entryMode: PURCHASE_PRICE_ENTRY_MODE.manual,
    referenceRateId: null,
    referenceAmount: null,
  };

  if (item.purchasePriceRateId === null) {
    return manualEvidence;
  }

  const rate = await tx.purchase_price_rates.findUnique({
    where: { purchase_price_rate_id: item.purchasePriceRateId },
    select: {
      revision: true,
      model_option_id: true,
      storage_option_id: true,
      appearance_grade_option_id: true,
      price_date: true,
      note: true,
      purchase_price: true,
      updated_at: true,
    },
  });
  const resolvedDeviceCriteria = device.inventory_sku
    ? null
    : await resolveInventorySkuCriteria(tx, {
        modelOptionKey: device.model_code || device.model,
        storage: device.storage,
        color: device.color,
        saleGrade: device.sale_grade,
      });
  const modelOptionId =
    device.inventory_sku?.model_option_id ??
    resolvedDeviceCriteria?.modelOption.option_id;
  const storageOptionId =
    device.inventory_sku?.storage_option_id ??
    resolvedDeviceCriteria?.storageOption.option_id;
  const appearanceGrade = latestAppearanceGrade(device);
  const appearanceGradeOptions = appearanceGrade
    ? await tx.product_criteria_options.findMany({
        where: {
          category: "APPEARANCE_GRADE",
          is_active: 1,
          OR: [
            { option_key: appearanceGrade },
            { label: appearanceGrade },
          ],
        },
        select: { option_id: true },
        orderBy: { option_id: "asc" },
        take: 2,
      })
    : [];
  const queryDate = item.purchasePriceQueryContext.priceDate;
  const queryNote = item.purchasePriceQueryContext.note;

  if (
    !rate ||
    item.purchasePriceRateRevision !== rate.revision ||
    rate.model_option_id !== modelOptionId ||
    rate.storage_option_id !== storageOptionId ||
    appearanceGradeOptions.length !== 1 ||
    rate.appearance_grade_option_id !== appearanceGradeOptions[0].option_id ||
    !/^\d{4}-\d{2}-\d{2}$/.test(queryDate) ||
    rate.price_date.toISOString().slice(0, 10) !== queryDate ||
    rate.note !== queryNote
  ) {
    throw publicConflict(
      "PURCHASE_PRICE_RATE_STALE",
      `PG ${item.pgNo}의 매입가 기준이 변경되었습니다. 매입가 목록을 새로 고친 뒤 다시 확정해 주세요.`
    );
  }

  return {
    updatedAt:
      rate.purchase_price === item.purchasePrice ? rate.updated_at : timestamp,
    entryMode:
      rate.purchase_price === item.purchasePrice
        ? PURCHASE_PRICE_ENTRY_MODE.rate
        : PURCHASE_PRICE_ENTRY_MODE.override,
    referenceRateId: item.purchasePriceRateId,
    referenceAmount: rate.purchase_price,
  };
}

async function createSellableInventory(
  tx: TransactionClient,
  pgNo: string,
  timestamp: Date,
  context: { sourceId: string; actorUserId: number | null }
) {
  await tx.inventory.create({
    data: {
      pg_no: pgNo,
      inventory_status: INVENTORY_STATUS.sellable,
      location: PURCHASE_CONFIRMED_INVENTORY_LOCATION,
      stocked_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await recordInventoryCreatedWithLedger(tx, {
    pgNo,
    inventoryStatus: INVENTORY_STATUS.sellable,
    operationKey: `PURCHASE_CONFIRM:${context.sourceId}:${pgNo}:CREATE`,
    movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated,
    sourceType: "PURCHASE_CONFIRM",
    sourceId: context.sourceId,
    actorUserId: context.actorUserId,
    occurredAt: timestamp,
  });
}

async function setSellableInventoryForNewPurchase(
  tx: TransactionClient,
  device: PurchaseDevice,
  timestamp: Date,
  context: { sourceId: string; actorUserId: number | null }
) {
  if (!device.inventory) {
    await createSellableInventory(tx, device.pg_no, timestamp, context);
    return;
  }

  await transitionInventoryStatusWithLedger(tx, {
    pgNo: device.pg_no,
    toStatus: INVENTORY_STATUS.sellable,
    transitionPolicy: INVENTORY_TRANSITION_POLICY.purchaseConfirmation,
    operationKey: `PURCHASE_CONFIRM:${context.sourceId}:${device.pg_no}:STATUS`,
    movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
    sourceType: "PURCHASE_CONFIRM",
    sourceId: context.sourceId,
    actorUserId: context.actorUserId,
    occurredAt: timestamp,
    inventoryUpdate: {
      location: PURCHASE_CONFIRMED_INVENTORY_LOCATION,
      stockedAt: device.inventory.stocked_at ?? timestamp,
    },
  });
}

function conflictResult(
  item: PurchaseConfirmItem,
  reason: string,
  auditReasonCode: string,
  before?: PurchaseConfirmState
): PurchaseConfirmResult {
  return {
    mode: "CONFLICT",
    auditReasonCode,
    pgNo: item.pgNo,
    reason,
    purchasePrice: item.purchasePrice,
    before,
  };
}

async function claimAndReloadPurchaseSnapshot(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  inbound: PurchaseInbound,
  expectedStatus: string
): Promise<
  | {
      ok: true;
      device: PurchaseDevice;
      inbound: PurchaseInbound;
    }
  | {
      ok: false;
      result: PurchaseConfirmResult;
    }
> {
  const before = buildBeforeState(device, inbound);
  const claim = await claimInboundWorkflowState(tx, {
    inboundId: inbound.inbound_id,
    pgNo: item.pgNo,
    expectedStatus,
    expectedRevision: inbound.revision,
  });

  if (!claim.claimed) {
    return {
      ok: false,
      result: conflictResult(
        item,
        claim.currentStatus
          ? `입고 상태가 ${claim.currentStatus}(으)로 변경되어 현재 요청을 처리하지 않았습니다.`
          : "입고 정보가 변경되거나 삭제되어 현재 요청을 처리하지 않았습니다.",
        "PURCHASE_WORKFLOW_CLAIM_REJECTED",
        before
      ),
    };
  }

  const currentDevice = await loadPurchaseDevice(tx, item.pgNo);
  const currentInbound = currentDevice?.inbounds[0] ?? null;
  if (
    !currentDevice ||
    !currentInbound ||
    currentInbound.inbound_id !== inbound.inbound_id ||
    currentInbound.inbound_status !== expectedStatus ||
    currentInbound.revision !== inbound.revision
  ) {
    return {
      ok: false,
      result: conflictResult(
        item,
        "입고 회차 또는 상태가 변경되어 현재 요청을 처리하지 않았습니다.",
        "PURCHASE_WORKFLOW_SNAPSHOT_CHANGED",
        before
      ),
    };
  }

  return {
    ok: true,
    device: {
      ...currentDevice,
      inspections: inspectionsForInbound(
        currentDevice.inspections,
        currentInbound.inbound_id
      ),
    },
    inbound: currentInbound,
  };
}

async function confirmInspectedPurchase(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  inbound: PurchaseInbound,
  user: AuthUser,
  timestamp: Date
): Promise<PurchaseConfirmResult> {
  const before = buildBeforeState(device, inbound);
  const purchasePriceEvidence = await resolvePurchasePriceEvidence(
    tx,
    item,
    device,
    timestamp
  );

  const updatedInbound = await tx.inbounds.updateMany({
    where: {
      inbound_id: inbound.inbound_id,
      inbound_status: INBOUND_STATUS.inspected,
      revision: inbound.revision,
    },
    data: {
      purchase_price: item.purchasePrice,
      purchase_price_reference_rate_id:
        purchasePriceEvidence.referenceRateId,
      purchase_price_reference_amount:
        purchasePriceEvidence.referenceAmount,
      purchase_price_entry_mode: purchasePriceEvidence.entryMode,
      price_agreed_at: timestamp,
      inbound_status: INBOUND_STATUS.purchased,
      purchase_price_updated_by_user_id: user.userId,
      purchase_price_updated_at: purchasePriceEvidence.updatedAt,
      revision: { increment: 1 },
      updated_at: timestamp,
    },
  });
  if (updatedInbound.count !== 1) {
    throw publicConflict(
      "INBOUND_WORKFLOW_STATE_CONFLICT",
      `PG ${item.pgNo}의 입고 회차가 동시에 변경되어 매입 확정을 중단했습니다.`
    );
  }
  await setSellableInventoryForNewPurchase(tx, device, timestamp, {
    sourceId: String(inbound.inbound_id),
    actorUserId: user.userId,
  });
  const modelSeq = await assignModelSeqIfMissing(tx, device, timestamp);

  return {
    mode: "CONFIRMED",
    auditReasonCode: "PURCHASE_CONFIRMED",
    pgNo: item.pgNo,
    purchasePrice: item.purchasePrice,
    modelSeq,
    before,
    after: {
      inboundStatus: INBOUND_STATUS.purchased,
      purchasePrice: item.purchasePrice,
      inventoryStatus: INVENTORY_STATUS.sellable,
      inventoryLocation: PURCHASE_CONFIRMED_INVENTORY_LOCATION,
      modelSeq,
    },
  };
}

async function recoverPurchasedInventory(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  inbound: PurchaseInbound,
  user: AuthUser,
  timestamp: Date
): Promise<PurchaseConfirmResult> {
  const before = buildBeforeState(device, inbound);

  await createSellableInventory(tx, item.pgNo, timestamp, {
    sourceId: String(inbound.inbound_id),
    actorUserId: user.userId,
  });
  const modelSeq = await assignModelSeqIfMissing(tx, device, timestamp);

  return {
    mode: "RECOVERED",
    auditReasonCode: "PURCHASE_INVENTORY_RECOVERED",
    pgNo: item.pgNo,
    reason: "이미 매입된 기기에 재고 정보가 없어 판매가능 재고로 복구했습니다.",
    purchasePrice: inbound.purchase_price,
    modelSeq,
    before,
    after: {
      inboundStatus: INBOUND_STATUS.purchased,
      purchasePrice: inbound.purchase_price,
      inventoryStatus: INVENTORY_STATUS.sellable,
      inventoryLocation: PURCHASE_CONFIRMED_INVENTORY_LOCATION,
      modelSeq,
    },
  };
}

async function recoverPurchasedModelSeq(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  inbound: PurchaseInbound,
  timestamp: Date
): Promise<PurchaseConfirmResult> {
  const before = buildBeforeState(device, inbound);
  const modelSeq = await assignModelSeqIfMissing(tx, device, timestamp);

  return {
    mode: "RECOVERED",
    auditReasonCode: "PURCHASE_MODEL_SEQUENCE_RECOVERED",
    pgNo: item.pgNo,
    reason: "이미 매입된 기기에 고유번호가 없어 새로 부여했습니다.",
    purchasePrice: inbound.purchase_price,
    modelSeq,
    before,
    after: {
      inboundStatus: INBOUND_STATUS.purchased,
      purchasePrice: inbound.purchase_price,
      inventoryStatus: device.inventory?.inventory_status ?? null,
      modelSeq,
    },
  };
}

function skippedPurchasedResult(
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  inbound: PurchaseInbound
): PurchaseConfirmResult {
  const before = buildBeforeState(device, inbound);

  return {
    mode: "SKIPPED",
    auditReasonCode: "PURCHASE_ALREADY_CONFIRMED",
    pgNo: item.pgNo,
    reason: "이미 매입 확정된 판매가능 재고입니다.",
    purchasePrice: inbound.purchase_price,
    modelSeq: device.model_seq,
    before,
    after: before,
  };
}

async function recoverOrSkipClaimedPurchase(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  device: PurchaseDevice,
  inbound: PurchaseInbound,
  user: AuthUser,
  timestamp: Date
): Promise<PurchaseConfirmResult> {
  if (!device.inventory) {
    return recoverPurchasedInventory(
      tx,
      item,
      device,
      inbound,
      user,
      timestamp
    );
  }

  if (device.inventory.inventory_status !== INVENTORY_STATUS.sellable) {
    return conflictResult(
      item,
      "이미 매입된 기기가 판매가능 상태가 아니므로 자동으로 되돌리지 않았습니다.",
      "PURCHASE_INVENTORY_STATUS_CONFLICT",
      buildBeforeState(device, inbound)
    );
  }

  if (device.model_seq === null) {
    return recoverPurchasedModelSeq(tx, item, device, inbound, timestamp);
  }

  return skippedPurchasedResult(item, device, inbound);
}

async function confirmOnePurchase(
  tx: TransactionClient,
  item: PurchaseConfirmItem,
  user: AuthUser,
  timestamp: Date
): Promise<PurchaseConfirmResult> {
  const device = await loadPurchaseDevice(tx, item.pgNo);

  if (!device) {
    return conflictResult(
      item,
      "기기를 찾을 수 없습니다.",
      "PURCHASE_DEVICE_NOT_FOUND"
    );
  }

  const inbound = device.inbounds[0] ?? null;

  if (!inbound) {
    return conflictResult(
      item,
      "입고 정보를 찾을 수 없습니다.",
      "PURCHASE_INBOUND_NOT_FOUND"
    );
  }

  if (inbound.inbound_id !== item.expectedInboundId) {
    return conflictResult(
      item,
      "입고 회차가 변경되어 현재 요청을 처리하지 않았습니다. 목록을 새로 고쳐 주세요.",
      "PURCHASE_INBOUND_ID_MISMATCH"
    );
  }

  if (
    inbound.inbound_status === INBOUND_STATUS.inspected &&
    inbound.revision !== item.expectedInboundRevision
  ) {
    return conflictResult(
      item,
      "입고 정보가 변경되어 현재 요청을 처리하지 않았습니다. 목록을 새로 고쳐 주세요.",
      "PURCHASE_INBOUND_REVISION_MISMATCH"
    );
  }

  const before = buildBeforeState(device, inbound);

  if (inbound.inbound_status === INBOUND_STATUS.supplierReturn) {
    return conflictResult(
      item,
      "매입처 반품 대상은 매입 확정할 수 없습니다.",
      "PURCHASE_SUPPLIER_RETURN_CONFLICT",
      before
    );
  }

  if (inbound.inbound_status === INBOUND_STATUS.inspected) {
    const claimed = await claimAndReloadPurchaseSnapshot(
      tx,
      item,
      device,
      inbound,
      INBOUND_STATUS.inspected
    );
    if (!claimed.ok) {
      return claimed.result;
    }

    return confirmInspectedPurchase(
      tx,
      item,
      claimed.device,
      claimed.inbound,
      user,
      timestamp
    );
  }

  if (inbound.inbound_status !== INBOUND_STATUS.purchased) {
    return conflictResult(
      item,
      "검수 완료 상태가 아닙니다.",
      "PURCHASE_INBOUND_STATUS_CONFLICT",
      before
    );
  }

  if (inbound.purchase_price !== item.purchasePrice) {
    return conflictResult(
      item,
      "이미 확정된 매입가가 현재 요청과 달라 자동으로 덮지 않았습니다.",
      "PURCHASE_PRICE_MISMATCH",
      before
    );
  }

  if (
    device.inventory &&
    device.inventory.inventory_status !== INVENTORY_STATUS.sellable
  ) {
    return conflictResult(
      item,
      "이미 매입된 기기가 판매가능 상태가 아니므로 자동으로 되돌리지 않았습니다.",
      "PURCHASE_INVENTORY_STATUS_CONFLICT",
      before
    );
  }

  if (!device.inventory || device.model_seq === null) {
    const claimed = await claimAndReloadPurchaseSnapshot(
      tx,
      item,
      device,
      inbound,
      INBOUND_STATUS.purchased
    );
    if (!claimed.ok) {
      return claimed.result;
    }

    return recoverOrSkipClaimedPurchase(
      tx,
      item,
      claimed.device,
      claimed.inbound,
      user,
      timestamp
    );
  }

  return skippedPurchasedResult(item, device, inbound);
}

function summarizePurchaseResults(
  results: PurchaseConfirmResult[]
): PurchaseConfirmSummary {
  const countByMode = (mode: PurchaseConfirmMode) =>
    results.filter((item) => item.mode === mode).length;

  return {
    confirmedCount: countByMode("CONFIRMED"),
    recoveredCount: countByMode("RECOVERED"),
    skippedCount: countByMode("SKIPPED"),
    conflictCount: countByMode("CONFLICT"),
  };
}

function purchaseConfirmMessage(summary: PurchaseConfirmSummary) {
  const parts = [
    summary.confirmedCount > 0 ? `확정 ${summary.confirmedCount}건` : null,
    summary.recoveredCount > 0 ? `복구 ${summary.recoveredCount}건` : null,
    summary.skippedCount > 0
      ? `이미 처리 ${summary.skippedCount}건`
      : null,
    summary.conflictCount > 0 ? `제외 ${summary.conflictCount}건` : null,
  ].filter(Boolean);

  return parts.length > 0
    ? `매입 확정 처리 결과: ${parts.join(", ")}`
    : "매입 확정 처리 대상이 없습니다.";
}

function purchaseLogResult(summary: PurchaseConfirmSummary) {
  const handledCount =
    summary.confirmedCount + summary.recoveredCount + summary.skippedCount;

  if (summary.conflictCount === 0) {
    return "SUCCESS";
  }

  return handledCount > 0 ? "PARTIAL_SUCCESS" : "CONFLICT";
}

export function purchaseConfirmActivityChangeData(
  results: PurchaseConfirmResult[],
  summary: PurchaseConfirmSummary
) {
  const stateFields: Array<keyof PurchaseConfirmState> = [
    "inboundStatus",
    "purchasePrice",
    "inventoryStatus",
    "inventoryLocation",
    "modelSeq",
  ];
  const changes: ExplicitActivityLogChange[] = [];

  for (const item of results) {
    const targetKey = encodeURIComponent(item.pgNo);
    changes.push(
      {
        fieldName: `targets.${targetKey}.outcome`,
        beforeValue: null,
        afterValue: item.mode,
      },
      {
        fieldName: `targets.${targetKey}.reasonCode`,
        beforeValue: null,
        afterValue: item.auditReasonCode,
      }
    );
    for (const fieldName of stateFields) {
      const beforeValue = item.before?.[fieldName];
      const afterValue = item.after?.[fieldName];
      if (beforeValue === afterValue) continue;
      changes.push({
        fieldName: `targets.${targetKey}.${fieldName}`,
        beforeValue: beforeValue === null || beforeValue === undefined ? null : String(beforeValue),
        afterValue: afterValue === null || afterValue === undefined ? null : String(afterValue),
      });
    }
  }

  return explicitActivityLogChangeData(changes, {
    beforeSummary: `targets=${results.length}`,
    afterSummary: [
      `confirmed=${summary.confirmedCount}`,
      `recovered=${summary.recoveredCount}`,
      `skipped=${summary.skippedCount}`,
      `conflict=${summary.conflictCount}`,
    ].join(" / "),
  });
}

async function writePurchaseConfirmLog(
  tx: TransactionClient,
  user: AuthUser,
  timestamp: Date,
  results: PurchaseConfirmResult[],
  summary: PurchaseConfirmSummary
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: user.userId,
      action_type: "PURCHASE_CONFIRM",
      target_type: "INBOUND",
      target_id: `${results.length} items`,
      ...purchaseConfirmActivityChangeData(results, summary),
      result: purchaseLogResult(summary),
      created_at: timestamp,
    },
  });
}

export async function confirmInboundPurchases(
  client: PrismaClient,
  input: PurchaseConfirmInput,
  user: AuthUser
) {
  const items = parseItems(input);

  if (items.length === 0) {
    throw publicBadRequest(
      "PURCHASE_CONFIRM_INPUT_INVALID",
      "매입 확정할 기기가 없습니다."
    );
  }

  const timestamp = databaseNow();

  return runMeasuredTransaction(client, "inbound.purchase.confirm", async (tx) => {
    const pgNos = [...new Set(items.map((item) => item.pgNo))].sort();
    for (const pgNo of pgNos) {
      await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
    }
    for (const pgNo of pgNos) {
      await lockDeviceAggregateRow(tx, pgNo);
    }
    const models = await tx.devices.findMany({
      where: { pg_no: { in: pgNos }, model_seq: null },
      select: { model: true },
    });
    for (const model of [...new Set(models.map((item) => item.model.trim()))]
      .filter(Boolean)
      .sort()) {
      await lockAggregateKey(tx, { namespace: "model-sequence", key: model });
    }
    const results: PurchaseConfirmResult[] = [];

    for (const item of items) {
      results.push(await confirmOnePurchase(tx, item, user, timestamp));
    }

    const summary = summarizePurchaseResults(results);
    await writePurchaseConfirmLog(tx, user, timestamp, results, summary);

    return {
      ...summary,
      message: purchaseConfirmMessage(summary),
      results: results.map(({ auditReasonCode, ...result }) => {
        void auditReasonCode;
        return result;
      }),
    };
  });
}
