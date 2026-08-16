import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { DEVICE_WARRANTY_OPTIONS } from "@/quickhack_shared/device/types";
import { normalizeOptionalImei } from "@/quickhack_shared/device/device-identifiers";
import { INBOUND_STATUS, inboundStatusFromInspectionLifecycle } from "@/quickhack_shared/inbound/inbound-status";
import { PURCHASE_PRICE_ENTRY_MODE } from "@/quickhack_shared/inbound/purchase-price-entry-mode";
import {
  INVENTORY_CORRECTION_RECORD_KINDS,
  type InventoryCorrectionPatch,
  type InventoryCorrectionRecordKind,
  type InventoryCorrectionScalar,
  type InventoryCorrectionRevision,
} from "@/quickhack_shared/inventory/inventory-correction";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import {
  assertInventorySkuEditAllowed,
  INVENTORY_TRANSITION_POLICY,
} from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  INSPECTION_RESULT,
  INSPECTION_SOURCE_TYPE,
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";
import {
  appendDomainAuditEvent,
  defineDomainAuditEvent,
  type DomainAuditScalar,
} from "@/quickhack_server/audit/domain-audit-service";
import { explicitActivityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  apiDate,
  apiDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  strictOptionalDatabaseDate,
  strictOptionalKstDateTime,
} from "@/quickhack_server/core/database/strict-business-time";
import { resolveInboundBatchId } from "@/quickhack_server/inbound/inbound-batch-reference";
import { raiseModelSequenceFloor } from "@/quickhack_server/inbound/model-sequence-service";
import { inferStoredDeviceStatus } from "@/quickhack_server/inspection/device-status";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  reclassifyInventorySkuWithLedger,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { lockDeviceAggregateRow } from "@/quickhack_server/inventory/device-aggregate-lock";

type TransactionClient = Prisma.TransactionClient;
type CommandInput = Record<string, unknown>;

type AppliedChange = {
  recordKind: InventoryCorrectionRecordKind;
  recordId: number;
  fieldKey: string;
  before: InventoryCorrectionScalar;
  after: InventoryCorrectionScalar;
};

export type InventoryBulkCorrectionCommandItem = {
  pgNo: string;
  patches?: unknown;
};

const RECORD_KIND_VALUES = new Set<string>(INVENTORY_CORRECTION_RECORD_KINDS);
const DEVICE_FIELDS = new Set([
  "model",
  "model_code",
  "model_seq",
  "imei",
  "storage",
  "color",
  "sale_grade",
  "warranty",
]);
const INBOUND_FIELDS = new Set([
  "batch_no",
  "supplier_name",
  "purchase_price",
  "received_at",
  "price_agreed_at",
  "note",
]);
const INVENTORY_FIELDS = new Set(["inventory_status", "location", "stocked_at"]);
const INSPECTION_FIELDS = new Set([
  "inspection_type",
  "inspection_round",
  "inspection_result",
  "checked_at",
  "appearance_grade",
  "appearance_defect",
  "function_defect",
  "return_yn",
  "csc",
  "first_call_date",
  "appearance_worker",
  "function_worker",
  "appearance_checked_at",
  "function_checked_at",
  "note",
]);
const ALLOWED_FIELDS = {
  device: DEVICE_FIELDS,
  inbound: INBOUND_FIELDS,
  inventory: INVENTORY_FIELDS,
  inspection: INSPECTION_FIELDS,
} satisfies Record<InventoryCorrectionRecordKind, Set<string>>;
const FINANCIAL_INBOUND_FIELDS = new Set([
  "supplier_name",
  "purchase_price",
  "price_agreed_at",
]);
const SKU_DEVICE_FIELDS = new Set([
  "model",
  "model_code",
  "storage",
  "color",
  "sale_grade",
]);
const SALE_GRADES = new Set(["A", "A-", "B+", "B"]);
const WARRANTY_VALUES = new Set<string>(DEVICE_WARRANTY_OPTIONS);
const INVENTORY_STATUSES = new Set<string>(Object.values(INVENTORY_STATUS));
const INSPECTION_TYPES = new Set<string>(Object.values(INSPECTION_TYPE));
const INSPECTION_RESULTS = new Set<string>(Object.values(INSPECTION_RESULT));
const SENSITIVE_AUDIT_FIELDS = new Set(["imei", "adb_serial", "note"]);

const AUDIT_FIELD_PATHS = {
  device: {
    model: "device.model",
    model_code: "device.modelCode",
    model_seq: "device.modelSeq",
    imei: "device.imei",
    storage: "device.storage",
    color: "device.color",
    sale_grade: "device.saleGrade",
    warranty: "device.warranty",
  },
  inbound: {
    batch_no: "inbound.batchNo",
    supplier_name: "inbound.supplierName",
    purchase_price: "inbound.purchasePrice",
    received_at: "inbound.receivedAt",
    price_agreed_at: "inbound.priceAgreedAt",
    note: "inbound.note",
    inbound_status: "inbound.status",
  },
  inventory: {
    inventory_status: "inventory.status",
    location: "inventory.location",
    stocked_at: "inventory.stockedAt",
  },
  inspection: {
    inspection_type: "inspection.type",
    inspection_round: "inspection.round",
    inspection_result: "inspection.result",
    checked_at: "inspection.checkedAt",
    appearance_grade: "inspection.appearanceGrade",
    appearance_defect: "inspection.appearanceDefect",
    function_defect: "inspection.functionDefect",
    return_yn: "inspection.returnYn",
    csc: "inspection.csc",
    first_call_date: "inspection.firstCallDate",
    appearance_worker: "inspection.appearanceWorker",
    function_worker: "inspection.functionWorker",
    appearance_checked_at: "inspection.appearanceCheckedAt",
    function_checked_at: "inspection.functionCheckedAt",
    note: "inspection.note",
  },
} as const;

const INVENTORY_CORRECTION_AUDIT = defineDomainAuditEvent({
  eventType: "INVENTORY_CORRECTION",
  allowedFieldPaths: [
    ...Object.values(AUDIT_FIELD_PATHS.device),
    ...Object.values(AUDIT_FIELD_PATHS.inbound),
    ...Object.values(AUDIT_FIELD_PATHS.inventory),
    ...Object.values(AUDIT_FIELD_PATHS.inspection),
  ],
});

function inputError(message: string) {
  return publicBadRequest("INVENTORY_CORRECTION_INPUT_INVALID", message);
}

function scalar(value: unknown): InventoryCorrectionScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  throw inputError("보정 값은 문자열, 숫자 또는 null이어야 합니다.");
}

function nullableText(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requiredText(value: unknown, label: string) {
  const normalized = nullableText(value);
  if (!normalized) throw inputError(`${label} 값이 필요합니다.`);
  return normalized;
}

function nullableInteger(value: unknown, label: string, minimum = 0) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) throw inputError(`${label}은 정수로 입력해야 합니다.`);
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw inputError(`${label} 값이 올바르지 않습니다.`);
  }
  return parsed;
}

function requiredInteger(value: unknown, label: string, minimum = 0) {
  const parsed = nullableInteger(value, label, minimum);
  if (parsed === null) throw inputError(`${label} 값이 필요합니다.`);
  return parsed;
}

function strictDateTime(value: unknown, label: string) {
  try {
    return strictOptionalKstDateTime(value);
  } catch {
    throw inputError(`${label}은 실제 존재하는 YYYY-MM-DD HH:mm:ss 형식이어야 합니다.`);
  }
}

function strictDate(value: unknown, label: string) {
  try {
    return strictOptionalDatabaseDate(value);
  } catch {
    throw inputError(`${label}은 실제 존재하는 YYYY-MM-DD 형식이어야 합니다.`);
  }
}

function comparable(value: InventoryCorrectionScalar) {
  return value === null || value === "" ? null : String(value);
}

function sameValue(left: InventoryCorrectionScalar, right: InventoryCorrectionScalar) {
  return comparable(left) === comparable(right);
}

function parsePatches(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw inputError("저장할 필드 변경사항이 없습니다.");
  }
  if (value.length > 500) throw inputError("한 번에 수정할 수 있는 필드 수를 초과했습니다.");
  const seen = new Set<string>();
  return value.map((raw): InventoryCorrectionPatch => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw inputError("필드 변경사항 형식이 올바르지 않습니다.");
    }
    const row = raw as Record<string, unknown>;
    const recordKind = String(row.recordKind ?? "") as InventoryCorrectionRecordKind;
    const recordId = Number(row.recordId);
    const expectedRevision = Number(row.expectedRevision);
    const fieldKey = String(row.fieldKey ?? "").trim();
    if (
      !RECORD_KIND_VALUES.has(recordKind) ||
      !Number.isSafeInteger(recordId) ||
      recordId <= 0 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !fieldKey
    ) {
      throw inputError("필드 변경 대상의 ID 또는 revision이 올바르지 않습니다.");
    }
    if (!ALLOWED_FIELDS[recordKind].has(fieldKey)) {
      throw publicConflict(
        "INVENTORY_CORRECTION_FIELD_NOT_ALLOWED",
        `${recordKind}.${fieldKey} 필드는 일반 재고 보정으로 수정할 수 없습니다.`
      );
    }
    const key = `${recordKind}:${recordId}:${fieldKey}`;
    if (seen.has(key)) throw inputError(`같은 필드가 중복 제출되었습니다: ${key}`);
    seen.add(key);
    return {
      recordKind,
      recordId,
      expectedRevision,
      fieldKey,
      expectedValue: scalar(row.expectedValue),
      nextValue: scalar(row.nextValue),
    };
  });
}

function groupPatches(patches: readonly InventoryCorrectionPatch[]) {
  const groups = new Map<string, InventoryCorrectionPatch[]>();
  for (const patch of patches) {
    const key = `${patch.recordKind}:${patch.recordId}`;
    const current = groups.get(key) ?? [];
    if (current.length > 0 && current[0].expectedRevision !== patch.expectedRevision) {
      throw inputError(`같은 레코드에 서로 다른 revision이 제출되었습니다: ${key}`);
    }
    current.push(patch);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function assertExpectedValues(
  patches: readonly InventoryCorrectionPatch[],
  values: Record<string, InventoryCorrectionScalar>
) {
  for (const patch of patches) {
    if (!sameValue(values[patch.fieldKey] ?? null, patch.expectedValue)) {
      throw publicConflict(
        "INVENTORY_CORRECTION_STALE_FIELD",
        `${patch.recordKind}.${patch.fieldKey} 값이 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.`
      );
    }
  }
}

function applied(
  patch: InventoryCorrectionPatch,
  before: InventoryCorrectionScalar,
  after: InventoryCorrectionScalar
): AppliedChange | null {
  return sameValue(before, after)
    ? null
    : {
        recordKind: patch.recordKind,
        recordId: patch.recordId,
        fieldKey: patch.fieldKey,
        before,
        after,
      };
}

function dateTimeScalar(value: Date | null) {
  return apiDateTime(value);
}

function dateScalar(value: Date | null) {
  return apiDate(value);
}

async function applyDevicePatches(
  tx: TransactionClient,
  pgNo: string,
  patches: readonly InventoryCorrectionPatch[],
  context: { timestamp: Date; user: AuthUser; reason: string; operationKey: string }
) {
  const device = await tx.devices.findFirst({
    where: { device_id: patches[0].recordId, pg_no: pgNo },
    include: { inventory: true },
  });
  if (!device) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "기기 정보가 변경되거나 삭제되었습니다.");
  if (device.revision !== patches[0].expectedRevision) {
    throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "기기 정보가 변경되었습니다. 최신 내용을 다시 확인해 주세요.");
  }
  const current = {
    model: device.model,
    model_code: device.model_code,
    model_seq: device.model_seq,
    imei: device.imei,
    storage: device.storage,
    color: device.color,
    sale_grade: device.sale_grade,
    warranty: device.warranty,
  } satisfies Record<string, InventoryCorrectionScalar>;
  assertExpectedValues(patches, current);
  if (device.inventory && patches.some((patch) => SKU_DEVICE_FIELDS.has(patch.fieldKey))) {
    try {
      assertInventorySkuEditAllowed(device.inventory.inventory_status);
    } catch (error) {
      throw publicConflict(
        "INVENTORY_CORRECTION_COMPLETED_WORK_EXISTS",
        error instanceof Error ? error.message : "현재 업무 상태에서는 SKU 조합을 수정할 수 없습니다."
      );
    }
  }

  const data: Prisma.devicesUncheckedUpdateManyInput = {
    revision: { increment: 1 },
    updated_at: context.timestamp,
  };
  const changes: AppliedChange[] = [];
  for (const patch of patches) {
    let next: InventoryCorrectionScalar;
    switch (patch.fieldKey) {
      case "model": next = requiredText(patch.nextValue, "모델"); data.model = next; break;
      case "model_code": next = nullableText(patch.nextValue); data.model_code = next; break;
      case "model_seq": next = nullableInteger(patch.nextValue, "고유번호", 1); data.model_seq = next; break;
      case "imei": {
        try { next = normalizeOptionalImei(patch.nextValue); }
        catch (error) { throw inputError(error instanceof Error ? error.message : "IMEI가 올바르지 않습니다."); }
        data.imei = next;
        break;
      }
      case "storage": next = nullableText(patch.nextValue); data.storage = next; break;
      case "color": next = nullableText(patch.nextValue); data.color = next; break;
      case "sale_grade": {
        next = nullableText(patch.nextValue)?.toUpperCase() ?? null;
        if (next && !SALE_GRADES.has(next)) throw inputError("판매등급 값이 올바르지 않습니다.");
        data.sale_grade = next;
        break;
      }
      case "warranty": {
        next = nullableText(patch.nextValue);
        if (next && !WARRANTY_VALUES.has(next)) throw inputError("보증서 값이 올바르지 않습니다.");
        data.warranty = next;
        break;
      }
      default: throw inputError(`지원하지 않는 기기 필드입니다: ${patch.fieldKey}`);
    }
    const change = applied(patch, current[patch.fieldKey], next);
    if (change) changes.push(change);
  }
  if (changes.length === 0) return { changes, revision: device.revision };
  const updated = await tx.devices.updateMany({
    where: { device_id: device.device_id, pg_no: pgNo, revision: device.revision },
    data,
  });
  if (updated.count !== 1) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "기기 정보가 동시에 변경되었습니다.");

  const modelPatch = patches.find((patch) => patch.fieldKey === "model");
  const modelSeqPatch = patches.find((patch) => patch.fieldKey === "model_seq");
  if (modelPatch || modelSeqPatch) {
    const effectiveModel = modelPatch
      ? requiredText(modelPatch.nextValue, "모델")
      : device.model;
    const effectiveModelSeq = modelSeqPatch
      ? nullableInteger(modelSeqPatch.nextValue, "고유번호", 1)
      : device.model_seq;
    await raiseModelSequenceFloor(tx, {
      model: effectiveModel,
      floor: effectiveModelSeq,
      timestamp: context.timestamp,
    });
  }
  if (device.inventory && changes.some((change) => SKU_DEVICE_FIELDS.has(change.fieldKey))) {
    await reclassifyInventorySkuWithLedger(tx, {
      pgNo,
      previousInventorySkuId: device.inventory_sku_id,
      operationKey: `${context.operationKey}:DEVICE:${device.device_id}`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification,
      sourceType: "INVENTORY_CORRECTION",
      sourceId: String(device.device_id),
      reason: context.reason,
      actorUserId: context.user.userId,
      occurredAt: context.timestamp,
      changedCriteria: {
        modelLabel: changes.some((change) => change.fieldKey === "model"),
        modelOptionKey: changes.some((change) => change.fieldKey === "model_code"),
        storage: changes.some((change) => change.fieldKey === "storage"),
        color: changes.some((change) => change.fieldKey === "color"),
        saleGrade: changes.some((change) => change.fieldKey === "sale_grade"),
      },
    });
  }
  return { changes, revision: device.revision + 1 };
}

async function applyInboundPatches(
  tx: TransactionClient,
  pgNo: string,
  patches: readonly InventoryCorrectionPatch[],
  context: { timestamp: Date; user: AuthUser }
) {
  const inbound = await tx.inbounds.findFirst({
    where: { inbound_id: patches[0].recordId, pg_no: pgNo },
    include: { inbound_batch: true, _count: { select: { sales_records: true } } },
  });
  if (!inbound) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "입고 정보가 변경되거나 삭제되었습니다.");
  if (inbound.revision !== patches[0].expectedRevision) {
    throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "입고 정보가 변경되었습니다. 최신 내용을 다시 확인해 주세요.");
  }
  const current = {
    batch_no: inbound.inbound_batch?.batch_no ?? null,
    supplier_name: inbound.supplier_name,
    purchase_price: inbound.purchase_price,
    received_at: dateTimeScalar(inbound.received_at),
    price_agreed_at: dateTimeScalar(inbound.price_agreed_at),
    note: inbound.note,
  } satisfies Record<string, InventoryCorrectionScalar>;
  assertExpectedValues(patches, current);
  if (
    inbound._count.sales_records > 0 &&
    patches.some((patch) => FINANCIAL_INBOUND_FIELDS.has(patch.fieldKey))
  ) {
    throw publicConflict(
      "INVENTORY_CORRECTION_SALES_SNAPSHOT_EXISTS",
      "판매 원장이 생성된 입고의 매입가·매입처·가격협의일은 일반 재고 보정으로 변경할 수 없습니다."
    );
  }

  const data: Prisma.inboundsUncheckedUpdateManyInput = {
    revision: { increment: 1 },
    updated_at: context.timestamp,
  };
  const normalized = new Map<string, InventoryCorrectionScalar | Date>();
  const changes: AppliedChange[] = [];
  for (const patch of patches) {
    let next: InventoryCorrectionScalar;
    switch (patch.fieldKey) {
      case "batch_no": next = nullableInteger(patch.nextValue, "차수", 1); break;
      case "supplier_name": next = nullableText(patch.nextValue); data.supplier_name = next; break;
      case "purchase_price": {
        next = nullableInteger(patch.nextValue, "매입가", 0);
        data.purchase_price = next;
        if (!sameValue(current.purchase_price, next)) {
          data.purchase_price_reference_rate_id = null;
          data.purchase_price_reference_amount = null;
          data.purchase_price_entry_mode = next === null ? null : PURCHASE_PRICE_ENTRY_MODE.manual;
          data.purchase_price_updated_by_user_id = context.user.userId;
          data.purchase_price_updated_at = context.timestamp;
        }
        break;
      }
      case "received_at": {
        const value = strictDateTime(patch.nextValue, "입고일시");
        next = dateTimeScalar(value);
        data.received_at = value;
        normalized.set(patch.fieldKey, value);
        break;
      }
      case "price_agreed_at": {
        const value = strictDateTime(patch.nextValue, "가격협의일시");
        next = dateTimeScalar(value);
        data.price_agreed_at = value;
        break;
      }
      case "note": next = nullableText(patch.nextValue); data.note = next; break;
      default: throw inputError(`지원하지 않는 입고 필드입니다: ${patch.fieldKey}`);
    }
    normalized.set(patch.fieldKey, normalized.get(patch.fieldKey) ?? next);
    const change = applied(patch, current[patch.fieldKey], next);
    if (change) changes.push(change);
  }
  if (changes.length === 0) return { changes, revision: inbound.revision };
  if (normalized.has("batch_no") || normalized.has("received_at")) {
    const batchNo = normalized.has("batch_no")
      ? (normalized.get("batch_no") as number | null)
      : inbound.inbound_batch?.batch_no ?? null;
    const receivedAt = normalized.has("received_at")
      ? (normalized.get("received_at") as Date | null)
      : inbound.received_at;
    if (!receivedAt) throw inputError("차수를 연결하려면 유효한 입고일시가 필요합니다.");
    data.inbound_batch_id = await resolveInboundBatchId(tx, batchNo, receivedAt);
  }
  const updated = await tx.inbounds.updateMany({
    where: { inbound_id: inbound.inbound_id, pg_no: pgNo, revision: inbound.revision },
    data,
  });
  if (updated.count !== 1) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "입고 정보가 동시에 변경되었습니다.");
  return { changes, revision: inbound.revision + 1 };
}

async function applyInventoryPatches(
  tx: TransactionClient,
  pgNo: string,
  patches: readonly InventoryCorrectionPatch[],
  context: { timestamp: Date; user: AuthUser; reason: string; operationKey: string }
) {
  const inventory = await tx.inventory.findFirst({
    where: { inventory_id: patches[0].recordId, pg_no: pgNo },
  });
  if (!inventory) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "재고 정보가 변경되거나 삭제되었습니다.");
  if (inventory.revision !== patches[0].expectedRevision) {
    throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "재고 정보가 변경되었습니다. 최신 내용을 다시 확인해 주세요.");
  }
  const current = {
    inventory_status: inventory.inventory_status,
    location: inventory.location,
    stocked_at: dateTimeScalar(inventory.stocked_at),
  } satisfies Record<string, InventoryCorrectionScalar>;
  assertExpectedValues(patches, current);
  let nextStatus = inventory.inventory_status;
  let location: string | null | undefined;
  let stockedAt: Date | null | undefined;
  const changes: AppliedChange[] = [];
  for (const patch of patches) {
    let next: InventoryCorrectionScalar;
    switch (patch.fieldKey) {
      case "inventory_status": {
        next = requiredText(patch.nextValue, "재고상태");
        if (!INVENTORY_STATUSES.has(next)) throw inputError("재고상태 값이 올바르지 않습니다.");
        nextStatus = next;
        break;
      }
      case "location": next = nullableText(patch.nextValue); location = next; break;
      case "stocked_at": {
        stockedAt = strictDateTime(patch.nextValue, "재고등록일시");
        next = dateTimeScalar(stockedAt);
        break;
      }
      default: throw inputError(`지원하지 않는 재고 필드입니다: ${patch.fieldKey}`);
    }
    const change = applied(patch, current[patch.fieldKey], next);
    if (change) changes.push(change);
  }
  if (changes.length === 0) return { changes, revision: inventory.revision };
  if (nextStatus !== inventory.inventory_status) {
    await transitionInventoryStatusWithLedger(tx, {
      pgNo,
      toStatus: nextStatus,
      expectedFromStatus: inventory.inventory_status,
      expectedRevision: inventory.revision,
      inventoryUpdate: { location, stockedAt },
      transitionPolicy: INVENTORY_TRANSITION_POLICY.manualInventoryCorrection,
      operationKey: `${context.operationKey}:INVENTORY:${inventory.inventory_id}:STATUS`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "INVENTORY_CORRECTION",
      sourceId: String(inventory.inventory_id),
      reason: context.reason,
      actorUserId: context.user.userId,
      occurredAt: context.timestamp,
    });
  } else {
    const updated = await tx.inventory.updateMany({
      where: { inventory_id: inventory.inventory_id, pg_no: pgNo, revision: inventory.revision },
      data: {
        location,
        stocked_at: stockedAt,
        revision: { increment: 1 },
        updated_at: context.timestamp,
      },
    });
    if (updated.count !== 1) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "재고 정보가 동시에 변경되었습니다.");
  }
  return { changes, revision: inventory.revision + 1 };
}

async function applyInspectionPatches(
  tx: TransactionClient,
  pgNo: string,
  patches: readonly InventoryCorrectionPatch[]
) {
  const inspection = await tx.inspections.findFirst({
    where: { inspection_id: patches[0].recordId, pg_no: pgNo },
  });
  if (!inspection) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "검수 정보가 변경되거나 삭제되었습니다.");
  if (inspection.revision !== patches[0].expectedRevision) {
    throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "검수 정보가 변경되었습니다. 최신 내용을 다시 확인해 주세요.");
  }
  const current = {
    inspection_type: inspection.inspection_type,
    inspection_round: inspection.inspection_round,
    inspection_result: inspection.inspection_result,
    checked_at: dateTimeScalar(inspection.checked_at),
    appearance_grade: inspection.appearance_grade,
    appearance_defect: inspection.appearance_defect,
    function_defect: inspection.function_defect,
    return_yn: inspection.return_yn,
    csc: inspection.csc,
    first_call_date: dateScalar(inspection.first_call_date),
    appearance_worker: inspection.appearance_worker,
    function_worker: inspection.function_worker,
    appearance_checked_at: dateTimeScalar(inspection.appearance_checked_at),
    function_checked_at: dateTimeScalar(inspection.function_checked_at),
    note: inspection.note,
  } satisfies Record<string, InventoryCorrectionScalar>;
  assertExpectedValues(patches, current);
  const data: Prisma.inspectionsUncheckedUpdateManyInput = {
    revision: { increment: 1 },
  };
  const changes: AppliedChange[] = [];
  for (const patch of patches) {
    let next: InventoryCorrectionScalar;
    switch (patch.fieldKey) {
      case "inspection_type": {
        next = requiredText(patch.nextValue, "검수 종류");
        if (!INSPECTION_TYPES.has(next)) throw inputError("검수 종류가 올바르지 않습니다.");
        data.inspection_type = next;
        break;
      }
      case "inspection_round": next = requiredInteger(patch.nextValue, "검수 차수", 1); data.inspection_round = next; break;
      case "inspection_result": {
        next = nullableText(patch.nextValue);
        if (next && !INSPECTION_RESULTS.has(next)) throw inputError("검수 결과가 올바르지 않습니다.");
        data.inspection_result = next;
        break;
      }
      case "checked_at": { const value = strictDateTime(patch.nextValue, "검수일시"); next = dateTimeScalar(value); data.checked_at = value; break; }
      case "appearance_grade": next = nullableText(patch.nextValue); data.appearance_grade = next; break;
      case "appearance_defect": next = nullableText(patch.nextValue); data.appearance_defect = next; break;
      case "function_defect": next = nullableText(patch.nextValue); data.function_defect = next; break;
      case "return_yn": {
        next = requiredText(patch.nextValue, "매입처 반품 여부").toUpperCase();
        if (next !== "Y" && next !== "N") throw inputError("매입처 반품 여부는 Y 또는 N이어야 합니다.");
        data.return_yn = next;
        break;
      }
      case "csc": next = nullableText(patch.nextValue); data.csc = next; break;
      case "first_call_date": {
        const value = strictDate(patch.nextValue, "최초통화일");
        next = dateScalar(value);
        data.first_call_date = value;
        break;
      }
      case "appearance_worker": next = nullableText(patch.nextValue); data.appearance_worker = next; break;
      case "function_worker": next = nullableText(patch.nextValue); data.function_worker = next; break;
      case "appearance_checked_at": { const value = strictDateTime(patch.nextValue, "외관 검수일시"); next = dateTimeScalar(value); data.appearance_checked_at = value; break; }
      case "function_checked_at": { const value = strictDateTime(patch.nextValue, "기능 검수일시"); next = dateTimeScalar(value); data.function_checked_at = value; break; }
      case "note": next = nullableText(patch.nextValue); data.note = next; break;
      default: throw inputError(`지원하지 않는 검수 필드입니다: ${patch.fieldKey}`);
    }
    const change = applied(patch, current[patch.fieldKey], next);
    if (change) changes.push(change);
  }
  if (changes.length === 0) return { changes, revision: inspection.revision, inboundId: null as number | null };
  const updated = await tx.inspections.updateMany({
    where: { inspection_id: inspection.inspection_id, pg_no: pgNo, revision: inspection.revision },
    data,
  });
  if (updated.count !== 1) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "검수 정보가 동시에 변경되었습니다.");
  const inboundId = inspection.source_type === INSPECTION_SOURCE_TYPE.coupangReturn
    ? null
    : inspection.inbound_id;
  return { changes, revision: inspection.revision + 1, inboundId };
}

async function projectInboundLifecycle(
  tx: TransactionClient,
  pgNo: string,
  inboundId: number,
  timestamp: Date
) {
  const inbound = await tx.inbounds.findFirst({ where: { inbound_id: inboundId, pg_no: pgNo } });
  if (!inbound || inbound.inbound_status === INBOUND_STATUS.purchased) return null;
  const status = await inferStoredDeviceStatus(tx, pgNo, inboundId);
  const nextStatus = inboundStatusFromInspectionLifecycle(status);
  if (nextStatus === inbound.inbound_status) return null;
  const updated = await tx.inbounds.updateMany({
    where: { inbound_id: inboundId, pg_no: pgNo, revision: inbound.revision },
    data: {
      inbound_status: nextStatus,
      supplier_returned_at:
        nextStatus === INBOUND_STATUS.supplierReturn
          ? inbound.supplier_returned_at ?? timestamp
          : undefined,
      revision: { increment: 1 },
      updated_at: timestamp,
    },
  });
  if (updated.count !== 1) throw publicConflict("INVENTORY_CORRECTION_STALE_RECORD", "입고 lifecycle이 동시에 변경되었습니다.");
  return {
    change: {
      recordKind: "inbound" as const,
      recordId: inboundId,
      fieldKey: "inbound_status",
      before: inbound.inbound_status,
      after: nextStatus,
    } satisfies AppliedChange,
    revision: inbound.revision + 1,
  };
}

function auditFieldPath(change: AppliedChange) {
  const fields = AUDIT_FIELD_PATHS[change.recordKind] as Record<string, string>;
  const path = fields[change.fieldKey];
  if (!path) throw new Error(`Missing inventory correction audit path: ${change.recordKind}.${change.fieldKey}`);
  return path as (typeof INVENTORY_CORRECTION_AUDIT.allowedFieldPaths extends ReadonlySet<infer T> ? T : never);
}

function protectedAuditValue(change: AppliedChange, side: "before" | "after") {
  if (SENSITIVE_AUDIT_FIELDS.has(change.fieldKey)) {
    return side === "before" ? "[보호됨]" : "[변경됨]";
  }
  return change[side] as DomainAuditScalar;
}

async function writeCorrectionAudit(
  tx: TransactionClient,
  input: {
    pgNo: string;
    changes: readonly AppliedChange[];
    user: AuthUser;
    reason: string;
    timestamp: Date;
    operationKey: string;
  }
) {
  const byRecord = new Map<string, AppliedChange[]>();
  for (const change of input.changes) {
    const key = `${change.recordKind}:${change.recordId}`;
    const current = byRecord.get(key) ?? [];
    current.push(change);
    byRecord.set(key, current);
  }
  for (const changes of byRecord.values()) {
    const first = changes[0];
    await appendDomainAuditEvent(tx, {
      contract: INVENTORY_CORRECTION_AUDIT,
      actorUserId: input.user.userId,
      action: "INVENTORY_CORRECTION",
      aggregateType: first.recordKind.toUpperCase(),
      aggregateId: first.recordId,
      operationKey: input.operationKey,
      occurredAt: input.timestamp,
      changes: changes.map((change) => ({
        fieldPath: auditFieldPath(change),
        before: protectedAuditValue(change, "before"),
        after: protectedAuditValue(change, "after"),
      })),
    });
  }

  await tx.employee_activity_logs.create({
    data: {
      user_id: input.user.userId,
      action_type: "INVENTORY_CORRECTION",
      target_type: "DEVICE",
      target_id: input.pgNo,
      ...explicitActivityLogChangeData(
        input.changes.map((change) => ({
          fieldName: `${change.recordKind}:${change.recordId}.${change.fieldKey}`,
          beforeValue: String(protectedAuditValue(change, "before") ?? ""),
          afterValue: String(protectedAuditValue(change, "after") ?? ""),
        })),
        {
          beforeSummary: `inventory correction ${input.changes.length} field(s)`,
          afterSummary: `inventory correction committed ${input.changes.length} field(s); reason=${input.reason}`,
        }
      ),
      result: "SUCCESS",
      created_at: input.timestamp,
    },
  });
}

async function applyPgCorrection(
  tx: TransactionClient,
  input: {
    pgNo: string;
    patches: readonly InventoryCorrectionPatch[];
    user: AuthUser;
    reason: string;
    timestamp: Date;
    operationKey: string;
  }
) {
  const changes: AppliedChange[] = [];
  const revisions: InventoryCorrectionRevision[] = [];
  const inboundProjectionIds = new Set<number>();
  for (const patches of groupPatches(input.patches)) {
    const kind = patches[0].recordKind;
    const result =
      kind === "device"
        ? await applyDevicePatches(tx, input.pgNo, patches, input)
        : kind === "inbound"
          ? await applyInboundPatches(tx, input.pgNo, patches, input)
          : kind === "inventory"
            ? await applyInventoryPatches(tx, input.pgNo, patches, input)
            : await applyInspectionPatches(tx, input.pgNo, patches);
    changes.push(...result.changes);
    revisions.push({ recordKind: kind, recordId: patches[0].recordId, revision: result.revision });
    if ("inboundId" in result && typeof result.inboundId === "number") {
      inboundProjectionIds.add(result.inboundId);
    }
  }
  if (changes.length === 0) throw inputError("실제로 변경되는 필드가 없습니다.");
  for (const inboundId of [...inboundProjectionIds].sort((a, b) => a - b)) {
    const projected = await projectInboundLifecycle(tx, input.pgNo, inboundId, input.timestamp);
    if (projected) {
      changes.push(projected.change);
      const revisionIndex = revisions.findIndex(
        (item) => item.recordKind === "inbound" && item.recordId === inboundId
      );
      const nextRevision = {
        recordKind: "inbound" as const,
        recordId: inboundId,
        revision: projected.revision,
      };
      if (revisionIndex >= 0) revisions[revisionIndex] = nextRevision;
      else revisions.push(nextRevision);
    }
  }
  await writeCorrectionAudit(tx, { ...input, changes });
  return { pgNo: input.pgNo, appliedPatchCount: changes.length, revisions };
}

function reasonFrom(input: CommandInput) {
  const reason = String(input.editReason ?? "").trim();
  if (!reason) throw inputError("수정 사유를 입력해야 저장할 수 있습니다.");
  return reason;
}

export async function updateExistingInventoryRecord(
  client: PrismaClient,
  pgNoInput: string,
  input: CommandInput,
  user: AuthUser
) {
  const pgNo = pgNoInput.trim().toUpperCase();
  if (!pgNo) throw inputError("PG 값이 필요합니다.");
  const reason = reasonFrom(input);
  const patches = parsePatches(input.patches);
  const timestamp = databaseNow();
  const operationKey = `inventory-correction:${pgNo}:${randomUUID()}`;
  try {
    return await runMeasuredTransaction(client, "inventory.correction", async (tx) => {
      await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
      await lockDeviceAggregateRow(tx, pgNo);
      const exists = await tx.devices.findUnique({ where: { pg_no: pgNo }, select: { device_id: true } });
      if (!exists) throw publicNotFound("INVENTORY_NOT_FOUND", "수정할 기기를 찾을 수 없습니다.");
      return applyPgCorrection(tx, { pgNo, patches, user, reason, timestamp, operationKey });
    });
  } catch (error) {
    if (isPostgresqlUniqueViolation(error)) {
      throw publicConflict("INVENTORY_CORRECTION_UNIQUE_CONFLICT", "IMEI 또는 모델 고유번호가 다른 기기와 중복됩니다.");
    }
    throw error;
  }
}

export async function updateExistingInventoryRecordsAtomically(
  client: PrismaClient,
  items: InventoryBulkCorrectionCommandItem[],
  editReason: string,
  user: AuthUser
) {
  const reason = editReason.trim();
  if (!reason) throw inputError("수정 사유를 입력해야 저장할 수 있습니다.");
  if (items.length === 0) throw inputError("일괄 수정할 재고를 선택해야 합니다.");
  const normalized = items.map((item) => ({
    pgNo: item.pgNo.trim().toUpperCase(),
    patches: parsePatches(item.patches),
  }));
  if (normalized.some((item) => !item.pgNo)) throw inputError("일괄 수정 대상에 PG가 없습니다.");
  if (new Set(normalized.map((item) => item.pgNo)).size !== normalized.length) {
    throw inputError("일괄 수정 대상에 같은 PG가 중복되어 있습니다.");
  }
  const ordered = [...normalized].sort((a, b) => a.pgNo.localeCompare(b.pgNo));
  const timestamp = databaseNow();
  const batchId = randomUUID();
  try {
    return await runMeasuredTransaction(
      client,
      "inventory.correction.bulk",
      async (tx) => {
        for (const item of ordered) {
          await lockAggregateKey(tx, { namespace: "device-inbound", key: item.pgNo });
        }
        for (const item of ordered) {
          await lockDeviceAggregateRow(tx, item.pgNo);
        }
        const sequenceItems = ordered.filter((item) =>
          item.patches.some(
            (patch) =>
              patch.recordKind === "device" &&
              (patch.fieldKey === "model" || patch.fieldKey === "model_seq")
          )
        );
        const currentModels = sequenceItems.length
          ? await tx.devices.findMany({
              where: { pg_no: { in: sequenceItems.map((item) => item.pgNo) } },
              select: { model: true },
            })
          : [];
        const requestedModels = sequenceItems.flatMap((item) =>
          item.patches
            .filter((patch) => patch.recordKind === "device" && patch.fieldKey === "model")
            .map((patch) => String(patch.nextValue ?? "").trim())
        );
        for (const model of [
          ...new Set([
            ...currentModels.map((item) => item.model.trim()),
            ...requestedModels,
          ]),
        ]
          .filter(Boolean)
          .sort()) {
          await lockAggregateKey(tx, { namespace: "model-sequence", key: model });
        }
        const results = [];
        for (const item of ordered) {
          const exists = await tx.devices.findUnique({
            where: { pg_no: item.pgNo },
            select: { device_id: true },
          });
          if (!exists) {
            throw publicNotFound(
              "INVENTORY_NOT_FOUND",
              `수정할 기기를 찾을 수 없습니다: ${item.pgNo}`
            );
          }
          results.push(
            await applyPgCorrection(tx, {
              ...item,
              user,
              reason,
              timestamp,
              operationKey: `inventory-correction-bulk:${batchId}:${item.pgNo}`,
            })
          );
        }
        return { updatedCount: results.length, pgNos: results.map((item) => item.pgNo), results };
      },
      { maxWait: 10_000, timeout: 120_000 }
    );
  } catch (error) {
    if (isPostgresqlUniqueViolation(error)) {
      throw publicConflict("INVENTORY_CORRECTION_UNIQUE_CONFLICT", "IMEI 또는 모델 고유번호가 다른 기기와 중복됩니다.");
    }
    throw error;
  }
}
