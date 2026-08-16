// QuickHack note: 외관/기능 검수 업로드를 Device, Inbound, Inspection 테이블에 트랜잭션으로 저장합니다.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { inferStoredDeviceStatus } from "@/quickhack_server/inspection/device-status";
import {
  createInspectionRecord,
  saleGradeFromAppearanceGrade,
  type InspectionRecord,
} from "@/quickhack_shared/inspection/inspection-schema";
import {
  INBOUND_STATUS,
  inboundStatusFromInspectionLifecycle,
} from "@/quickhack_shared/inbound/inbound-status";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { warrantyFromSaleGrade } from "@/quickhack_shared/device/types";
import {
  INSPECTION_SOURCE_TYPE,
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";
import { resolveInboundBatchId } from "@/quickhack_server/inbound/inbound-batch-reference";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  reclassifyInventorySkuWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { randomUUID } from "node:crypto";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { publicConflict } from "@/quickhack_server/core/public-error";
import { claimInboundWorkflowState } from "@/quickhack_server/inbound/inbound-workflow-claim-service";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";
import { lockDeviceAggregateRow } from "@/quickhack_server/inventory/device-aggregate-lock";
import {
  databaseDate,
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import { assignCurrentInventorySkuToDevice } from "@/quickhack_server/catalog/inventory-sku-service";

// QuickHack object: 구글 시트식 한글 컬럼명과 DB 저장 로직 사이의 필드명을 한곳에 모읍니다.
const FIELD = {
  pgNo: "PG",
  imei: "IMEI",
  appearanceGrade: "외관등급",
  appearanceDefect: "외관하자",
  functionDefect: "기능하자",
  returnYn: "매입처반품유무",
  product: "제품명",
  csc: "통신사",
  storage: "저장공간",
  color: "기기색상",
  firstCallDate: "최초통화일",
  batchNo: "차수",
  appearanceWorker: "외관검수자",
  functionWorker: "기능검수자",
  appearanceCheckedAt: "외관검수일시",
  functionCheckedAt: "기능검수일시",
} as const;

type InspectionRecordInput = Partial<InspectionRecord> & Record<string, unknown>;
type TransactionClient = Prisma.TransactionClient;

function text(record: InspectionRecordInput, key: string) {
  const value = record[key];

  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function nullableText(record: InspectionRecordInput, key: string) {
  const value = text(record, key);
  return value === "" ? null : value;
}

function optionalText(record: InspectionRecordInput, key: string) {
  const value = text(record, key);
  return value === "" ? undefined : value;
}

function nullableDateTime(record: InspectionRecordInput, key: string) {
  const value = record[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return databaseDateTime(value as DateTimeInput);
}

function nullableDate(record: InspectionRecordInput, key: string) {
  const value = record[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return databaseDate(value as DateTimeInput);
}

function parsePositiveInt(value: string) {
  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return parsed > 0 ? parsed : null;
}

function nowSql() {
  return databaseNow();
}

function compactUpdate<T extends Record<string, unknown>>(data: T) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

function hasInspectionData(record: InspectionRecordInput) {
  return [
    FIELD.appearanceGrade,
    FIELD.appearanceDefect,
    FIELD.functionDefect,
    FIELD.csc,
    FIELD.firstCallDate,
    FIELD.appearanceWorker,
    FIELD.functionWorker,
    FIELD.appearanceCheckedAt,
    FIELD.functionCheckedAt,
  ].some((key) => text(record, key) !== "");
}

async function upsertDevice(
  tx: TransactionClient,
  record: InspectionRecordInput,
  pgNo: string,
  timestamp: Date
) {
  const model = nullableText(record, FIELD.product);
  const imei = nullableText(record, FIELD.imei);
  const storage = nullableText(record, FIELD.storage);
  const color = nullableText(record, FIELD.color);
  const appearanceGrade = nullableText(record, FIELD.appearanceGrade);
  const saleGrade = appearanceGrade
    ? saleGradeFromAppearanceGrade(appearanceGrade)
    : null;
  const warranty = saleGrade ? warrantyFromSaleGrade(saleGrade) : null;

  return tx.devices.upsert({
    where: { pg_no: pgNo },
    create: {
      pg_no: pgNo,
      imei,
      model: model || "UNKNOWN",
      storage,
      color,
      sale_grade: saleGrade,
      warranty,
      created_at: timestamp,
      updated_at: timestamp,
    },
    update: compactUpdate({
      imei: imei || undefined,
      model: model || undefined,
      storage: storage || undefined,
      color: color || undefined,
      sale_grade: saleGrade || undefined,
      warranty: warranty || undefined,
      revision: { increment: 1 },
      updated_at: timestamp,
    }),
  });
}

async function upsertInbound(
  tx: TransactionClient,
  pgNo: string,
  record: InspectionRecordInput,
  timestamp: Date,
  existingInboundId: number | null
) {
  const existing = existingInboundId
    ? await tx.inbounds.findFirstOrThrow({
        where: { inbound_id: existingInboundId, pg_no: pgNo },
      })
    : null;
  const batchText = text(record, FIELD.batchNo);
  const batchNo = batchText ? parsePositiveInt(batchText) : undefined;

  if (batchText && batchNo === null) {
    throw new Error("차수는 1 이상의 숫자로 입력하세요.");
  }

  const batchTimestamp =
    text(record, FIELD.appearanceCheckedAt) ||
    text(record, FIELD.functionCheckedAt) ||
    existing?.received_at ||
    timestamp;
  const inboundBatchId = await resolveInboundBatchId(
    tx,
    batchNo ?? undefined,
    batchTimestamp
  );
  const data = compactUpdate({
    inbound_batch_id: inboundBatchId,
    revision: { increment: 1 },
    updated_at: timestamp,
  });

  if (existing) {
    return tx.inbounds.update({
      where: { inbound_id: existing.inbound_id },
      data,
    });
  }

  return tx.inbounds.create({
    data: {
      pg_no: pgNo,
      inbound_batch_id: inboundBatchId ?? null,
      inbound_status: INBOUND_STATUS.received,
      received_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
}

// QuickHack object: 검수 업로드 레코드를 DB inspections 저장 형태로 정규화합니다.
function inspectionWriteData(record: InspectionRecordInput) {
  return {
    inspection_type: INSPECTION_TYPE.appearance as string,
    inspection_round: 1,
    inspection_result: null as string | null,
    source_type: INSPECTION_SOURCE_TYPE.inbound as string,
    coupang_return_allocation_id: null as number | null,
    checked_by_user_id: null as number | null,
    checked_at: null as Date | null,
    appearance_grade: nullableText(record, FIELD.appearanceGrade),
    appearance_defect: nullableText(record, FIELD.appearanceDefect),
    function_defect: nullableText(record, FIELD.functionDefect),
    return_yn: optionalText(record, FIELD.returnYn) || "N",
    csc: nullableText(record, FIELD.csc),
    first_call_date: nullableDate(record, FIELD.firstCallDate),
    appearance_worker: nullableText(record, FIELD.appearanceWorker),
    function_worker: nullableText(record, FIELD.functionWorker),
    appearance_checked_at: nullableDateTime(record, FIELD.appearanceCheckedAt),
    function_checked_at: nullableDateTime(record, FIELD.functionCheckedAt),
  };
}

type InspectionWriteDataBase = ReturnType<typeof inspectionWriteData>;
type InspectionWriteData = Omit<
  InspectionWriteDataBase,
  | "checked_at"
  | "first_call_date"
  | "appearance_checked_at"
  | "function_checked_at"
> & {
  checked_at: Date | null;
  first_call_date: Date | null;
  appearance_checked_at: Date | null;
  function_checked_at: Date | null;
};
type StoredInspectionData =
  Prisma.inspectionsGetPayload<Prisma.inspectionsDefaultArgs>;

function hasTextValue(value: Date | string | null | undefined) {
  return value instanceof Date
    ? !Number.isNaN(value.getTime())
    : Boolean(value?.trim());
}

function hasAppearanceWriteData(data: InspectionWriteData) {
  return [
    data.appearance_grade,
    data.appearance_defect,
    data.appearance_worker,
    data.appearance_checked_at,
  ].some(hasTextValue);
}

function hasFunctionWriteData(data: InspectionWriteData) {
  return [
    data.function_defect,
    data.function_worker,
    data.function_checked_at,
    data.csc,
    data.first_call_date,
  ].some(hasTextValue);
}

function emptyInspectionWriteData(): InspectionWriteData {
  return {
    inspection_type: INSPECTION_TYPE.appearance,
    inspection_round: 1,
    inspection_result: null,
    source_type: INSPECTION_SOURCE_TYPE.inbound,
    coupang_return_allocation_id: null,
    checked_by_user_id: null,
    checked_at: null,
    appearance_grade: null,
    appearance_defect: null,
    function_defect: null,
    return_yn: "N",
    csc: null,
    first_call_date: null,
    appearance_worker: null,
    function_worker: null,
    appearance_checked_at: null,
    function_checked_at: null,
  };
}

function appearanceInspectionWriteData(data: InspectionWriteData) {
  return {
    ...emptyInspectionWriteData(),
    inspection_type: INSPECTION_TYPE.appearance,
    source_type: data.source_type || INSPECTION_SOURCE_TYPE.inbound,
    inspection_round: data.inspection_round || 1,
    inspection_result: data.inspection_result,
    coupang_return_allocation_id: data.coupang_return_allocation_id,
    checked_by_user_id: data.checked_by_user_id,
    checked_at: data.appearance_checked_at ?? data.checked_at,
    appearance_grade: data.appearance_grade,
    appearance_defect: data.appearance_defect,
    return_yn: data.return_yn || "N",
    appearance_worker: data.appearance_worker,
    appearance_checked_at: data.appearance_checked_at,
  };
}

function functionInspectionWriteData(data: InspectionWriteData) {
  return {
    ...emptyInspectionWriteData(),
    inspection_type: INSPECTION_TYPE.function,
    source_type: data.source_type || INSPECTION_SOURCE_TYPE.inbound,
    inspection_round: data.inspection_round || 1,
    inspection_result: data.inspection_result,
    coupang_return_allocation_id: data.coupang_return_allocation_id,
    checked_by_user_id: data.checked_by_user_id,
    checked_at: data.function_checked_at ?? data.checked_at,
    function_defect: data.function_defect,
    return_yn: data.return_yn || "N",
    csc: data.csc,
    first_call_date: data.first_call_date,
    function_worker: data.function_worker,
    function_checked_at: data.function_checked_at,
  };
}

// QuickHack object: 외관 검수와 기능 검수 데이터를 별도 inspection row로 나누기 위한 분리 로직입니다.
function splitInspectionWriteData(data: InspectionWriteData) {
  const inspections: InspectionWriteData[] = [];

  if (hasAppearanceWriteData(data)) {
    inspections.push(appearanceInspectionWriteData(data));
  }

  if (hasFunctionWriteData(data)) {
    inspections.push(functionInspectionWriteData(data));
  }

  return inspections;
}

function mergeInspectionUpdateData(
  existing: StoredInspectionData,
  data: InspectionWriteData
): InspectionWriteData {
  return {
    appearance_grade: data.appearance_grade ?? existing.appearance_grade,
    inspection_type: data.inspection_type ?? existing.inspection_type,
    inspection_round: data.inspection_round ?? existing.inspection_round,
    inspection_result: data.inspection_result ?? existing.inspection_result,
    source_type: data.source_type ?? existing.source_type,
    coupang_return_allocation_id:
      data.coupang_return_allocation_id ?? existing.coupang_return_allocation_id,
    checked_by_user_id:
      data.checked_by_user_id ?? existing.checked_by_user_id,
    checked_at: data.checked_at ?? existing.checked_at,
    appearance_defect: data.appearance_defect ?? existing.appearance_defect,
    function_defect: data.function_defect ?? existing.function_defect,
    return_yn: data.return_yn || existing.return_yn || "N",
    csc: data.csc ?? existing.csc,
    first_call_date: data.first_call_date ?? existing.first_call_date,
    appearance_worker: data.appearance_worker ?? existing.appearance_worker,
    function_worker: data.function_worker ?? existing.function_worker,
    appearance_checked_at:
      data.appearance_checked_at ?? existing.appearance_checked_at,
    function_checked_at:
      data.function_checked_at ?? existing.function_checked_at,
  };
}

async function findInspectionCandidate(
  tx: TransactionClient,
  pgNo: string,
  inboundId: number,
  data: InspectionWriteData
) {
  if (hasAppearanceWriteData(data) && data.appearance_checked_at) {
    const appearanceWhere = {
      pg_no: pgNo,
      inspection_type: INSPECTION_TYPE.appearance,
      appearance_checked_at: data.appearance_checked_at,
      function_checked_at: null,
    };
    const sameAppearance = await tx.inspections.findFirst({
      where: { ...appearanceWhere, inbound_id: inboundId },
      orderBy: { inspection_id: "desc" },
    });

    if (sameAppearance) {
      return sameAppearance;
    }
  }

  if (hasFunctionWriteData(data) && data.function_checked_at) {
    const functionWhere = {
      pg_no: pgNo,
      inspection_type: INSPECTION_TYPE.function,
      appearance_checked_at: null,
      function_checked_at: data.function_checked_at,
    };
    const sameFunction = await tx.inspections.findFirst({
      where: { ...functionWhere, inbound_id: inboundId },
      orderBy: { inspection_id: "desc" },
    });

    if (sameFunction) {
      return sameFunction;
    }
  }

  return null;
}

// QuickHack object: 분리된 외관/기능 검수 데이터를 기존 이력과 병합하거나 새 row로 저장합니다.
async function saveInspectionRows(
  tx: TransactionClient,
  pgNo: string,
  inboundId: number,
  record: InspectionRecordInput,
  timestamp: Date,
  userId?: number | null
) {
  if (!hasInspectionData(record)) {
    return [];
  }

  const inspectionRows: Array<{ inspection_id: number }> = [];
  const baseData = inspectionWriteData(record);
  baseData.checked_by_user_id = userId ?? null;
  baseData.checked_at =
    baseData.function_checked_at ?? baseData.appearance_checked_at ?? timestamp;
  const dataList = splitInspectionWriteData(baseData);

  for (const data of dataList) {
    const existing = await findInspectionCandidate(tx, pgNo, inboundId, data);

    if (existing) {
      inspectionRows.push(
        await tx.inspections.update({
          where: { inspection_id: existing.inspection_id },
          data: {
            ...mergeInspectionUpdateData(existing, data),
            inbound_id: inboundId,
            revision: { increment: 1 },
          },
        })
      );
      continue;
    }

    inspectionRows.push(
      await tx.inspections.create({
        data: {
          pg_no: pgNo,
          inbound_id: inboundId,
          ...data,
          created_at: timestamp,
        },
      })
    );
  }

  return inspectionRows;
}

function normalizePgNo(value: string) {
  return value.trim().toUpperCase();
}

function isValidPgNo(value: string) {
  return /^[A-Z]{2}\d{10}$/.test(normalizePgNo(value));
}

function isValidImei(value: string) {
  return /^\d{15}$/.test(value.trim());
}

function validateInspectionRecordInput(record: InspectionRecordInput) {
  const pgNo = normalizePgNo(text(record, FIELD.pgNo));
  const imei = text(record, FIELD.imei);
  const batchNo = text(record, FIELD.batchNo);

  if (!pgNo) {
    throw new Error("PG is required.");
  }

  if (!isValidPgNo(pgNo)) {
    throw new Error("PG 형식 오류 - 알파벳 2자리 + 숫자 10자리");
  }

  if (imei && !isValidImei(imei)) {
    throw new Error("IMEI 형식 오류 - 15자리 숫자");
  }

  if (batchNo && parsePositiveInt(batchNo) === null) {
    throw new Error("차수는 1 이상의 숫자로 입력하세요.");
  }

  return pgNo;
}

// QuickHack object: 검수 업로드 한 건을 Device/Inbound/Inspection에 트랜잭션으로 저장하는 공개 서비스입니다.
export async function saveInspectionRecord(
  client: PrismaClient,
  record: InspectionRecordInput,
  userId?: number | null
) {
  const normalizedRecord = createInspectionRecord(record);
  const pgNo = validateInspectionRecordInput(normalizedRecord);

  const timestamp = nowSql();

  return runMeasuredTransaction(client, "inspection.record.save", async (tx) => {
    await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
    await lockDeviceAggregateRow(tx, pgNo);

    const existingDevice = await tx.devices.findUnique({
      where: { pg_no: pgNo },
      select: {
        model: true,
        model_code: true,
        storage: true,
        color: true,
        sale_grade: true,
        inventory_sku_id: true,
        inventory: {
          select: { inventory_id: true },
        },
      },
    });
    const device = await upsertDevice(tx, normalizedRecord, pgNo, timestamp);
    const inboundBeforeClaim = await tx.inbounds.findFirst({
      where: { pg_no: pgNo },
      orderBy: { inbound_id: "desc" },
      select: {
        inbound_id: true,
        inbound_status: true,
        revision: true,
      },
    });

    if (inboundBeforeClaim) {
      const claim = await claimInboundWorkflowState(tx, {
        inboundId: inboundBeforeClaim.inbound_id,
        pgNo,
        expectedStatus: inboundBeforeClaim.inbound_status,
        expectedRevision: inboundBeforeClaim.revision,
      });

      if (!claim.claimed) {
        throw publicConflict(
          "INBOUND_WORKFLOW_STATE_CONFLICT",
          "입고 상태가 변경되어 검수 기록을 저장하지 않았습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.",
          {
            pgNo,
            inboundId: inboundBeforeClaim.inbound_id,
            expectedStatus: inboundBeforeClaim.inbound_status,
            expectedRevision: inboundBeforeClaim.revision,
            currentStatus: claim.currentStatus,
            currentRevision: claim.currentRevision,
          }
        );
      }
    }

    const changedCriteria = existingDevice
      ? {
          modelLabel: existingDevice.model.trim() !== device.model.trim(),
          modelOptionKey:
            (existingDevice.model_code ?? "").trim() !==
            (device.model_code ?? "").trim(),
          storage:
            (existingDevice.storage ?? "").trim() !==
            (device.storage ?? "").trim(),
          color:
            (existingDevice.color ?? "").trim() !==
            (device.color ?? "").trim(),
          saleGrade:
            (existingDevice.sale_grade ?? "").trim().toUpperCase() !==
            (device.sale_grade ?? "").trim().toUpperCase(),
        }
      : undefined;

    if (existingDevice?.inventory) {
      await reclassifyInventorySkuWithLedger(tx, {
        pgNo,
        previousInventorySkuId: existingDevice.inventory_sku_id,
        operationKey: `INSPECTION_SKU_RECLASSIFICATION:${pgNo}:${randomUUID()}`,
        movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification,
        sourceType: "INBOUND_INSPECTION",
        sourceId: String(existingDevice.inventory.inventory_id),
        reason: "검수 결과에 따른 재고 SKU 조합 변경",
        actorUserId: userId ?? null,
        occurredAt: timestamp,
        changedCriteria,
      });
    } else {
      await assignCurrentInventorySkuToDevice(tx, pgNo, {
        actorUserId: userId ?? null,
        required: false,
        changedCriteria,
      });
    }

    const inbound = await upsertInbound(
      tx,
      pgNo,
      normalizedRecord,
      timestamp,
      inboundBeforeClaim?.inbound_id ?? null
    );
    const inspections = await saveInspectionRows(
      tx,
      pgNo,
      inbound.inbound_id,
      normalizedRecord,
      timestamp,
      userId
    );
    const inspectionStatus = await inferStoredDeviceStatus(
      tx,
      pgNo,
      inbound.inbound_id
    );
    const nextInboundStatus =
      inbound.inbound_status === INBOUND_STATUS.purchased
        ? INBOUND_STATUS.purchased
        : inboundStatusFromInspectionLifecycle(inspectionStatus);

    const updatedInbound = await tx.inbounds.updateMany({
      where: {
        inbound_id: inbound.inbound_id,
        revision: inbound.revision,
      },
      data: {
        inbound_status: nextInboundStatus,
        supplier_returned_at:
          nextInboundStatus === INBOUND_STATUS.supplierReturn
            ? inbound.supplier_returned_at ?? timestamp
            : undefined,
        revision: { increment: 1 },
        updated_at: timestamp,
      },
    });
    if (updatedInbound.count !== 1) {
      throw publicConflict(
        "INBOUND_WORKFLOW_STATE_CONFLICT",
        "입고 회차가 동시에 변경되어 검수 기록을 저장하지 않았습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요."
      );
    }

    return {
      pg_no: device.pg_no,
      device_id: device.device_id,
      inbound_id: inbound.inbound_id,
      inspection_id: inspections[0]?.inspection_id ?? null,
      inspection_ids: inspections.map((inspection) => inspection.inspection_id),
      status: nextInboundStatus,
    };
  });
}
