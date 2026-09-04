import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";

type InboundBatchInput = Record<string, unknown>;
type TransactionClient = Prisma.TransactionClient;
type InboundBatchRow = Prisma.inbound_batchesGetPayload<{
  include: { _count: { select: { inbounds: true } } };
}>;

function inboundBatchInputError(message: string) {
  return publicBadRequest("INBOUND_BATCH_INPUT_INVALID", message);
}

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function nullableText(value: unknown) {
  return text(value) || null;
}

function positiveInt(value: unknown, label: string) {
  const normalized = text(value).replace(/,/g, "");

  if (!/^\d+$/.test(normalized)) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }

  return parsed;
}

function batchDate(value: unknown) {
  const normalized = text(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }

  return { text: normalized, value: parsed };
}

function normalizeInput(input: InboundBatchInput) {
  const normalizedBatchDate = batchDate(input.batchDate);
  return {
    batchDate: normalizedBatchDate.value,
    batchDateText: normalizedBatchDate.text,
    batchNo: positiveInt(input.batchNo, "차수 번호"),
    expectedQuantity: positiveInt(input.expectedQuantity, "예정 수량"),
    note: nullableText(input.note),
  };
}

function expectedRevision(input: InboundBatchInput) {
  const normalized = text(input.expectedRevision);
  const parsed = /^\d+$/.test(normalized)
    ? Number.parseInt(normalized, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }
  return parsed;
}

function toDto(batch: InboundBatchRow) {
  return {
    id: batch.inbound_batch_id,
    revision: batch.revision,
    batchDate: batch.batch_date,
    batchNo: batch.batch_no,
    expectedQuantity: batch.expected_quantity,
    linkedQuantity: batch._count.inbounds,
    note: batch.note,
    createdByUserId: batch.created_by_user_id,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
  };
}

function includeLinkedQuantity() {
  return {
    _count: { select: { inbounds: true } },
  } satisfies Prisma.inbound_batchesInclude;
}

async function readBatchById(tx: TransactionClient, id: number) {
  return tx.inbound_batches.findUnique({
    where: { inbound_batch_id: id },
    include: includeLinkedQuantity(),
  });
}

async function logActivity(
  tx: TransactionClient,
  user: AuthUser,
  actionType: string,
  batchId: number,
  beforeValue: unknown,
  afterValue: unknown,
  timestamp: Date
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: user.userId,
      action_type: actionType,
      target_type: "INBOUND_BATCH",
      target_id: String(batchId),
      ...activityLogChangeData(beforeValue, afterValue),
      result: "SUCCESS",
      created_at: timestamp,
    },
  });
}

export async function listInboundBatches(client: PrismaClient) {
  const rows = await client.inbound_batches.findMany({
    include: includeLinkedQuantity(),
    orderBy: [{ batch_date: "desc" }, { batch_no: "desc" }],
  });

  return rows.map(toDto);
}

export async function createInboundBatch(
  client: PrismaClient,
  input: InboundBatchInput,
  user: AuthUser
) {
  const data = normalizeInput(input);
  const timestamp = databaseNow();

  try {
    return await runMeasuredTransaction(
      client,
      "inbound.batch.create",
      async (tx) => {
        const existing = await tx.inbound_batches.findUnique({
          where: {
            batch_date_batch_no: {
              batch_date: data.batchDate,
              batch_no: data.batchNo,
            },
          },
          select: { inbound_batch_id: true },
        });

        if (existing) {
          throw publicConflict(
            "INBOUND_BATCH_ALREADY_EXISTS",
            "INBOUND_BATCH_ALREADY_EXISTS"
          );
        }

        const created = await tx.inbound_batches.create({
          data: {
            batch_date: data.batchDate,
            batch_no: data.batchNo,
            expected_quantity: data.expectedQuantity,
            note: data.note,
            created_by_user_id: user.userId,
            created_at: timestamp,
            updated_at: timestamp,
          },
          include: includeLinkedQuantity(),
        });

        const after = toDto(created);
        await logActivity(
          tx,
          user,
          "INBOUND_BATCH_PLAN_CREATE",
          created.inbound_batch_id,
          null,
          after,
          timestamp
        );

        return after;
      }
    );
  } catch (error) {
    if (isPostgresqlUniqueViolation(error)) {
      throw publicConflict(
        "INBOUND_BATCH_ALREADY_EXISTS",
        "INBOUND_BATCH_ALREADY_EXISTS"
      );
    }
    throw error;
  }
}

export async function updateInboundBatch(
  client: PrismaClient,
  id: number,
  input: InboundBatchInput,
  user: AuthUser
) {
  if (!Number.isInteger(id) || id <= 0) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }

  const data = normalizeInput(input);
  const revision = expectedRevision(input);
  const timestamp = databaseNow();

  try {
    return await runMeasuredTransaction(
      client,
      "inbound.batch.update",
      async (tx) => {
        await tx.$queryRaw`
          SELECT inbound_batch_id
          FROM inbound_batches
          WHERE inbound_batch_id = ${id}
          FOR UPDATE
        `;
        const beforeRow = await readBatchById(tx, id);

        if (!beforeRow) {
          throw publicNotFound(
            "INBOUND_BATCH_NOT_FOUND",
            "INBOUND_BATCH_NOT_FOUND"
          );
        }
        if (beforeRow.revision !== revision) {
          throw publicConflict(
            "INBOUND_BATCH_CHANGED",
            "INBOUND_BATCH_CHANGED"
          );
        }

        const duplicate = await tx.inbound_batches.findUnique({
          where: {
            batch_date_batch_no: {
              batch_date: data.batchDate,
              batch_no: data.batchNo,
            },
          },
          select: { inbound_batch_id: true },
        });

        if (duplicate && duplicate.inbound_batch_id !== id) {
          throw publicConflict(
            "INBOUND_BATCH_ALREADY_EXISTS",
            "INBOUND_BATCH_ALREADY_EXISTS"
          );
        }

        const before = toDto(beforeRow);
        const changed = await tx.inbound_batches.updateMany({
          where: { inbound_batch_id: id, revision },
          data: {
            batch_date: data.batchDate,
            batch_no: data.batchNo,
            expected_quantity: data.expectedQuantity,
            note: data.note,
            revision: { increment: 1 },
            updated_at: timestamp,
          },
        });
        if (changed.count !== 1) {
          throw publicConflict(
            "INBOUND_BATCH_CHANGED",
            "INBOUND_BATCH_CHANGED"
          );
        }
        const updated = await readBatchById(tx, id);
        if (!updated) {
          throw publicNotFound(
            "INBOUND_BATCH_NOT_FOUND",
            "INBOUND_BATCH_NOT_FOUND"
          );
        }

        const after = toDto(updated);
        await logActivity(
          tx,
          user,
          "INBOUND_BATCH_PLAN_UPDATE",
          id,
          before,
          after,
          timestamp
        );

        return after;
      }
    );
  } catch (error) {
    if (isPostgresqlUniqueViolation(error)) {
      throw publicConflict(
        "INBOUND_BATCH_ALREADY_EXISTS",
        "INBOUND_BATCH_ALREADY_EXISTS"
      );
    }
    throw error;
  }
}

export async function deleteInboundBatch(
  client: PrismaClient,
  id: number,
  input: InboundBatchInput,
  user: AuthUser
) {
  if (!Number.isInteger(id) || id <= 0) {
    throw inboundBatchInputError("INBOUND_BATCH_INPUT_INVALID");
  }

  const timestamp = databaseNow();
  const revision = expectedRevision(input);

  return runMeasuredTransaction(client, "inbound.batch.delete", async (tx) => {
    await tx.$queryRaw`
      SELECT inbound_batch_id
      FROM inbound_batches
      WHERE inbound_batch_id = ${id}
      FOR UPDATE
    `;
    const beforeRow = await readBatchById(tx, id);

    if (!beforeRow) {
      throw publicNotFound(
        "INBOUND_BATCH_NOT_FOUND",
        "INBOUND_BATCH_NOT_FOUND"
      );
    }
    if (beforeRow.revision !== revision) {
      throw publicConflict(
        "INBOUND_BATCH_CHANGED",
        "INBOUND_BATCH_CHANGED"
      );
    }

    if (beforeRow._count.inbounds > 0) {
      throw publicConflict(
        "INBOUND_BATCH_DELETE_CONFLICT",
        "INBOUND_BATCH_DELETE_CONFLICT"
      );
    }

    const before = toDto(beforeRow);

    const deleted = await tx.inbound_batches.deleteMany({
      where: { inbound_batch_id: id, revision },
    });
    if (deleted.count !== 1) {
      throw publicConflict(
        "INBOUND_BATCH_CHANGED",
        "INBOUND_BATCH_CHANGED"
      );
    }

    await logActivity(
      tx,
      user,
      "INBOUND_BATCH_PLAN_DELETE",
      id,
      before,
      null,
      timestamp
    );

    return before;
  });
}
