// QuickHack object: Inventory audit saves physical stock location checks for sellable inventory only.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { explicitActivityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { PREPACK_COMPLETED_LOCATION } from "@/quickhack_shared/supplies/supplies";
import { consumePrepackSupplies } from "@/quickhack_server/supplies/outbound-supply-service";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { requiredApiDate } from "@/quickhack_server/core/database/time-boundary";

const INVENTORY_AUDIT_LOCATIONS = new Set([
  "포장 완료",
  "포장 대기",
  "상품화 대기",
  "",
]);
const AUDIT_BATCH_SIZE = 200;

type InventoryAuditInput = Record<string, unknown>;
type TransactionClient = Prisma.TransactionClient;

function inventoryAuditInputError(message: string) {
  return publicBadRequest("INVENTORY_AUDIT_INPUT_INVALID", message);
}

type NormalizedInventoryAuditItem = {
  pgNo: string;
  inventoryId: number;
  expectedRevision: number;
  expectedLocation: string | null;
  location: string | null;
};

type InventoryAuditLocationChangeValue = {
  pgNo: string;
  location: string | null;
};

function text(value: unknown) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function normalizeAuditBaseDate(value: unknown, timestamp: string) {
  const rawDate = text(value) || timestamp.slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw inventoryAuditInputError("실사 기준일은 YYYY-MM-DD 형식으로 입력해야 합니다.");
  }

  const date = new Date(`${rawDate}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== rawDate) {
    throw inventoryAuditInputError("실사 기준일이 올바른 날짜가 아닙니다.");
  }

  if (rawDate > timestamp.slice(0, 10)) {
    throw inventoryAuditInputError("실사 기준일은 오늘 이후로 지정할 수 없습니다.");
  }

  return rawDate;
}

function addDaysToDateKey(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfDate(value: string) {
  return `${value} 00:00:00`;
}

function endOfDate(value: string) {
  return `${value} 23:59:59`;
}

function normalizeLocation(value: unknown) {
  const location = text(value);

  if (!INVENTORY_AUDIT_LOCATIONS.has(location)) {
    throw inventoryAuditInputError(
      "재고 실사 위치는 포장 완료, 포장 대기, 상품화 대기 중 하나만 저장할 수 있습니다."
    );
  }

  return location || null;
}

function normalizeAuditScope(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => text(item))
    .filter((item) => INVENTORY_AUDIT_LOCATIONS.has(item) && item);
}

function normalizeAuditItems(input: InventoryAuditInput) {
  const rawItems = input.items;

  if (!Array.isArray(rawItems)) {
    throw inventoryAuditInputError("저장할 재고 실사 항목이 없습니다.");
  }

  const itemByPgNo = new Map<string, NormalizedInventoryAuditItem>();

  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw inventoryAuditInputError("재고 실사 항목 형식이 올바르지 않습니다.");
    }

    const item = rawItem as Record<string, unknown>;
    const pgNo = text(item.pgNo).toUpperCase();
    const inventoryId = Number(item.inventoryId);
    const expectedRevision = Number(item.expectedRevision);

    if (!pgNo) {
      throw inventoryAuditInputError("PG가 없는 재고 실사 항목이 있습니다.");
    }
    if (!Number.isSafeInteger(inventoryId) || inventoryId <= 0) {
      throw inventoryAuditInputError(`${pgNo} 재고 ID가 올바르지 않습니다.`);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw inventoryAuditInputError(`${pgNo} 재고 revision이 올바르지 않습니다.`);
    }
    if (!("expectedLocation" in item)) {
      throw inventoryAuditInputError(`${pgNo}의 조회 당시 위치가 필요합니다.`);
    }
    if (itemByPgNo.has(pgNo)) {
      throw inventoryAuditInputError(`${pgNo} 재고 실사 항목이 중복되었습니다.`);
    }

    itemByPgNo.set(pgNo, {
      pgNo,
      inventoryId,
      expectedRevision,
      expectedLocation: normalizeLocation(item.expectedLocation),
      location: normalizeLocation(item.location),
    });
  }

  return [...itemByPgNo.values()];
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function readInventoryRows(
  tx: TransactionClient,
  pgNos: string[]
) {
  const rows = [];

  for (const batch of chunk(pgNos, AUDIT_BATCH_SIZE)) {
    rows.push(
      ...(await tx.inventory.findMany({
        where: {
          pg_no: {
            in: batch,
          },
        },
        select: {
          inventory_id: true,
          revision: true,
          pg_no: true,
          inventory_status: true,
          location: true,
        },
      }))
    );
  }

  return rows;
}

export async function saveInventoryAuditLocations(
  client: PrismaClient,
  input: InventoryAuditInput,
  user: AuthUser
) {
  const items = normalizeAuditItems(input);

  if (items.length === 0) {
    throw inventoryAuditInputError("저장할 재고 실사 변경사항이 없습니다.");
  }

  const timestamp = nowKstSqlDateTime();
  const auditBaseDate = normalizeAuditBaseDate(input.auditBaseDate, timestamp);
  const auditScope = normalizeAuditScope(input.auditScope);

  return runMeasuredTransaction(client, "inventory.audit", async (tx) => {
    const previousSession = await tx.inventory_audit_sessions.findFirst({
      where: {
        audit_base_date: {
          lt: auditBaseDate,
        },
      },
      orderBy: [{ audit_base_date: "desc" }, { inventory_audit_session_id: "desc" }],
      select: {
        audit_base_date: true,
      },
    });
    const auditPeriodFrom = previousSession
      ? startOfDate(
          addDaysToDateKey(requiredApiDate(previousSession.audit_base_date), 1)
        )
      : startOfDate(addDaysToDateKey(auditBaseDate, -6));
    const auditPeriodTo = endOfDate(auditBaseDate);
    const rows = await readInventoryRows(
      tx,
      items.map((item) => item.pgNo)
    );
    const rowByPgNo = new Map(rows.map((row) => [row.pg_no, row]));
    const beforeValue: InventoryAuditLocationChangeValue[] = [];
    const afterValue: InventoryAuditLocationChangeValue[] = [];
    const packedCompletedPgNos: string[] = [];
    let changedCount = 0;

    for (const item of items) {
      const row = rowByPgNo.get(item.pgNo);

      if (!row) {
        throw publicConflict(
          "INVENTORY_AUDIT_TARGET_CHANGED",
          `${item.pgNo} 재고 정보를 찾을 수 없습니다.`
        );
      }

      if (row.inventory_status !== INVENTORY_STATUS.sellable) {
        throw publicConflict(
          "INVENTORY_AUDIT_TARGET_CHANGED",
          `${item.pgNo}는 판매가능 재고가 아닙니다.`
        );
      }

      if (
        row.inventory_id !== item.inventoryId ||
        row.revision !== item.expectedRevision ||
        (row.location ?? null) !== item.expectedLocation
      ) {
        throw publicConflict(
          "INVENTORY_AUDIT_TARGET_CHANGED",
          `${item.pgNo} 재고가 조회 후 변경되었습니다. 목록을 새로 고쳐 주세요.`
        );
      }

      if ((row.location ?? null) === item.location) {
        continue;
      }

      const updated = await tx.inventory.updateMany({
        where: {
          inventory_id: item.inventoryId,
          revision: item.expectedRevision,
          inventory_status: INVENTORY_STATUS.sellable,
          location: item.expectedLocation,
        },
        data: {
          location: item.location,
          revision: { increment: 1 },
          updated_at: timestamp,
        },
      });
      if (updated.count !== 1) {
        throw publicConflict(
          "INVENTORY_AUDIT_TARGET_CHANGED",
          `${item.pgNo} 재고가 저장 중 변경되었습니다. 목록을 새로 고쳐 주세요.`
        );
      }
      beforeValue.push({
        pgNo: item.pgNo,
        location: row.location,
      });
      afterValue.push({
        pgNo: item.pgNo,
        location: item.location,
      });
      if (
        row.location !== PREPACK_COMPLETED_LOCATION &&
        item.location === PREPACK_COMPLETED_LOCATION
      ) {
        packedCompletedPgNos.push(item.pgNo);
      }
      changedCount += 1;
    }

    const session = await tx.inventory_audit_sessions.create({
      data: {
        audit_base_date: auditBaseDate,
        audit_period_from: auditPeriodFrom,
        audit_period_to: auditPeriodTo,
        changed_count: changedCount,
        packed_completed_count: packedCompletedPgNos.length,
        created_by_user_id: user.userId,
        created_at: timestamp,
      },
    });

    if (beforeValue.length > 0) {
      await tx.inventory_audit_location_changes.createMany({
        data: beforeValue.map((before, index) => ({
          inventory_audit_session_id: session.inventory_audit_session_id,
          pg_no: before.pgNo,
          previous_location: before.location,
          new_location: afterValue[index]?.location ?? null,
          created_at: timestamp,
        })),
      });
    }

    const packingSupplyConsumption = await consumePrepackSupplies(tx, {
      pgNos: packedCompletedPgNos,
      inventoryAuditSessionId: session.inventory_audit_session_id,
      auditPeriodFrom,
      auditPeriodTo,
      occurredAt: timestamp,
      actorUserId: user.userId,
    });

    await tx.employee_activity_logs.create({
      data: {
        user_id: user.userId,
        action_type: "INVENTORY_AUDIT_LOCATION_UPDATE",
        target_type: "INVENTORY_AUDIT_SESSION",
        target_id: String(session.inventory_audit_session_id),
        ...explicitActivityLogChangeData(
          [
            {
              fieldName: "changedCount",
              beforeValue: null,
              afterValue: String(changedCount),
            },
            {
              fieldName: "packedCompletedCount",
              beforeValue: null,
              afterValue: String(packedCompletedPgNos.length),
            },
          ],
          {
            beforeSummary: `scope=${auditScope}`,
            afterSummary: `session=${session.inventory_audit_session_id} / changed=${changedCount}`,
          }
        ),
        result: "SUCCESS",
        created_at: timestamp,
      },
    });

    return {
      changedCount,
      auditBaseDate,
      auditPeriodFrom,
      auditPeriodTo,
      packedCompletedCount: packedCompletedPgNos.length,
      packingSupplyConsumption,
    };
  });
}
