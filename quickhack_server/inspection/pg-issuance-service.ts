import { createHash, randomInt, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  INSPECTION_RECORD_KINDS,
  type InspectionRecordKind,
} from "@/quickhack_shared/inspection/inspection-schema";
import { INSPECTION_PG_RESERVATION_STATUS } from "@/quickhack_shared/inspection/pg-reservation";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import type { WorkerRunContext } from "@/quickhack_server/workers/types";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
  publicUnavailable,
} from "@/quickhack_server/core/public-error";

type TransactionClient = Prisma.TransactionClient;
type RandomInteger = (maxExclusive: number) => number;

const PG_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PG_DIGITS = "0123456789";
const PG_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const PG_GENERATION_ATTEMPTS = 12;

export function inspectionPgAutoIssuanceEnabled() {
  return process.env.QUICKHACK_PG_AUTO_ISSUANCE_ENABLED !== "0";
}

function requiredClientRecordId(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 200) {
    throw publicBadRequest("PG_RESERVATION_CLIENT_RECORD_REQUIRED", "PG_RESERVATION_CLIENT_RECORD_REQUIRED");
  }
  return normalized;
}

function requiredInspectionKind(value: unknown): InspectionRecordKind {
  if (value === INSPECTION_RECORD_KINDS.appearance || value === INSPECTION_RECORD_KINDS.function) {
    return value;
  }
  throw publicBadRequest("PG_RESERVATION_KIND_INVALID", "PG_RESERVATION_KIND_INVALID");
}

function requestDigest(clientRecordId: string, inspectionKind: InspectionRecordKind) {
  return createHash("sha256")
    .update(JSON.stringify({ clientRecordId, inspectionKind }))
    .digest("hex");
}

export function generateRandomPgNo(randomInteger: RandomInteger = randomInt) {
  let value = "";
  for (let index = 0; index < 2; index += 1) value += PG_LETTERS[randomInteger(PG_LETTERS.length)];
  for (let index = 0; index < 10; index += 1) value += PG_DIGITS[randomInteger(PG_DIGITS.length)];
  return value;
}

function reservationResult(row: {
  client_record_id: string;
  pg_no: string;
  status: string;
  expires_at: Date;
}, replayed: boolean) {
  return {
    clientRecordId: row.client_record_id,
    pgNo: row.pg_no,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    replayed,
  };
}

async function writeReservationActivity(
  tx: TransactionClient,
  input: { userId: number | null; actionType: string; pgNo: string; clientRecordId: string; kind: string; from: string | null; to: string; reason?: string }
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: input.userId,
      action_type: input.actionType,
      target_type: "PG_RESERVATION",
      target_id: input.pgNo,
      before_summary_text: input.from,
      after_summary_text: input.to,
      result: "SUCCESS",
      changes: {
        create: [
          { field_name: "clientRecordId", before_value: null, after_value: input.clientRecordId },
          { field_name: "inspectionKind", before_value: null, after_value: input.kind },
          ...(input.reason ? [{ field_name: "reason", before_value: null, after_value: input.reason }] : []),
        ],
      },
    },
  });
}

export async function reserveInspectionPg(
  client: PrismaClient,
  raw: { clientRecordId?: unknown; inspectionKind?: unknown },
  user: AuthUser,
  options?: { randomInteger?: RandomInteger; now?: Date }
) {
  const clientRecordId = requiredClientRecordId(raw.clientRecordId);
  const inspectionKind = requiredInspectionKind(raw.inspectionKind);
  const digest = requestDigest(clientRecordId, inspectionKind);
  const now = options?.now ?? databaseNow();
  const expiresAt = new Date(now.getTime() + PG_RESERVATION_TTL_MS);

  return runMeasuredTransaction(client, "inspection.pg.reserve", async (tx) => {
    const existing = await tx.inspection_pg_reservations.findUnique({ where: { client_record_id: clientRecordId } });
    if (existing) {
      if (existing.request_digest !== digest) throw publicConflict("PG_RESERVATION_ID_CONFLICT", "PG_RESERVATION_ID_CONFLICT");
      if (
        existing.status === INSPECTION_PG_RESERVATION_STATUS.reserved &&
        existing.expires_at.getTime() <= now.getTime()
      ) {
        await tx.inspection_pg_reservations.update({
          where: { inspection_pg_reservation_id: existing.inspection_pg_reservation_id },
          data: {
            status: INSPECTION_PG_RESERVATION_STATUS.abandoned,
            abandoned_at: now,
            updated_at: now,
          },
        });
        await writeReservationActivity(tx, {
          userId: user.userId,
          actionType: "PG_ISSUANCE_EXPIRED",
          pgNo: existing.pg_no,
          clientRecordId,
          kind: inspectionKind,
          from: "RESERVED",
          to: "ABANDONED",
          reason: "REPLAY_AFTER_EXPIRY",
        });
        return reservationResult({ ...existing, status: "ABANDONED" }, true);
      }
      return reservationResult(existing, true);
    }

    for (let attempt = 0; attempt < PG_GENERATION_ATTEMPTS; attempt += 1) {
      const pgNo = generateRandomPgNo(options?.randomInteger);
      await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
      const inserted = await tx.$queryRaw<Array<{
        client_record_id: string; pg_no: string; status: string; expires_at: Date;
      }>>`
        INSERT INTO inspection_pg_reservations (
          inspection_pg_reservation_id, client_record_id, pg_no, inspection_kind,
          request_digest, issued_by_user_id, status, expires_at, created_at, updated_at
        )
        SELECT ${randomUUID()}::uuid, ${clientRecordId}, ${pgNo}, ${inspectionKind},
          ${digest}, ${user.userId}, 'RESERVED', ${expiresAt}, ${now}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM devices WHERE pg_no = ${pgNo})
        ON CONFLICT DO NOTHING
        RETURNING client_record_id, pg_no, status, expires_at
      `;
      if (inserted.length === 1) {
        await writeReservationActivity(tx, {
          userId: user.userId, actionType: "PG_ISSUANCE_RESERVED", pgNo,
          clientRecordId, kind: inspectionKind, from: null, to: "RESERVED",
        });
        return reservationResult(inserted[0], false);
      }
      const raced = await tx.inspection_pg_reservations.findUnique({ where: { client_record_id: clientRecordId } });
      if (raced) {
        if (raced.request_digest !== digest) throw publicConflict("PG_RESERVATION_ID_CONFLICT", "PG_RESERVATION_ID_CONFLICT");
        return reservationResult(raced, true);
      }
    }
    throw publicUnavailable("PG_ISSUANCE_EXHAUSTED", "PG_ISSUANCE_EXHAUSTED");
  });
}

export async function abandonInspectionPg(client: PrismaClient, clientRecordIdRaw: unknown, user: AuthUser, reason = "LIST_REMOVED") {
  const clientRecordId = requiredClientRecordId(clientRecordIdRaw);
  return runMeasuredTransaction(client, "inspection.pg.abandon", async (tx) => {
    const rows = await tx.$queryRaw<Array<{ inspection_pg_reservation_id: string; pg_no: string; inspection_kind: string; status: string }>>`
      SELECT inspection_pg_reservation_id, pg_no, inspection_kind, status
      FROM inspection_pg_reservations WHERE client_record_id = ${clientRecordId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw publicNotFound("PG_RESERVATION_NOT_FOUND", "PG_RESERVATION_NOT_FOUND");
    if (row.status === INSPECTION_PG_RESERVATION_STATUS.consumed) throw publicConflict("PG_RESERVATION_ALREADY_CONSUMED", "PG_RESERVATION_ALREADY_CONSUMED");
    if (row.status === INSPECTION_PG_RESERVATION_STATUS.abandoned) return { clientRecordId, pgNo: row.pg_no, status: row.status, replayed: true };
    const now = databaseNow();
    await tx.inspection_pg_reservations.update({
      where: { inspection_pg_reservation_id: row.inspection_pg_reservation_id },
      data: { status: INSPECTION_PG_RESERVATION_STATUS.abandoned, abandoned_at: now, updated_at: now },
    });
    await writeReservationActivity(tx, {
      userId: user.userId, actionType: "PG_ISSUANCE_ABANDONED", pgNo: row.pg_no,
      clientRecordId, kind: row.inspection_kind, from: "RESERVED", to: "ABANDONED", reason,
    });
    return { clientRecordId, pgNo: row.pg_no, status: "ABANDONED", replayed: false };
  });
}

export async function lockInspectionPgReservation(tx: TransactionClient, clientRecordIdRaw: unknown) {
  const clientRecordId = requiredClientRecordId(clientRecordIdRaw);
  const rows = await tx.$queryRaw<Array<{
    inspection_pg_reservation_id: string; client_record_id: string; pg_no: string;
    inspection_kind: string; status: string; expires_at: Date; result_payload: Prisma.JsonValue | null;
  }>>`
    SELECT inspection_pg_reservation_id, client_record_id, pg_no, inspection_kind, status, expires_at, result_payload
    FROM inspection_pg_reservations WHERE client_record_id = ${clientRecordId} FOR UPDATE
  `;
  if (!rows[0]) throw publicNotFound("PG_RESERVATION_NOT_FOUND", "PG_RESERVATION_NOT_FOUND");
  return rows[0];
}

export async function lockInspectionPgReservationByPg(tx: TransactionClient, pgNo: string) {
  const rows = await tx.$queryRaw<Array<{
    inspection_pg_reservation_id: string;
    client_record_id: string;
    pg_no: string;
    inspection_kind: string;
    status: string;
    expires_at: Date;
  }>>`
    SELECT inspection_pg_reservation_id, client_record_id, pg_no, inspection_kind, status, expires_at
    FROM inspection_pg_reservations WHERE pg_no = ${pgNo} FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function consumeLockedInspectionPg(
  tx: TransactionClient,
  reservation: Awaited<ReturnType<typeof lockInspectionPgReservation>>,
  result: Record<string, unknown>,
  userId: number | null
) {
  const now = databaseNow();
  await tx.inspection_pg_reservations.update({
    where: { inspection_pg_reservation_id: reservation.inspection_pg_reservation_id },
    data: { status: "CONSUMED", consumed_at: now, result_payload: result as Prisma.InputJsonValue, updated_at: now },
  });
  await writeReservationActivity(tx, {
    userId, actionType: "PG_ISSUANCE_CONSUMED", pgNo: reservation.pg_no,
    clientRecordId: reservation.client_record_id, kind: reservation.inspection_kind,
    from: "RESERVED", to: "CONSUMED",
  });
}

export async function expireInspectionPgReservations(options: {
  context?: WorkerRunContext;
  limit?: number;
  now?: Date;
} = {}) {
  if (!inspectionPgAutoIssuanceEnabled()) {
    return {
      candidateCount: 0,
      abandonedCount: 0,
      summaryText: "Inspection PG auto issuance is disabled.",
    };
  }
  const { prisma } = await import("@/quickhack_server/core/prisma");
  const now = options.now ?? databaseNow();
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2_000));

  return runMeasuredTransaction(prisma, "inspection.pg.retention", async (tx) => {
    await options.context?.assertLeaseActive();
    const candidates = await tx.$queryRaw<Array<{
      inspection_pg_reservation_id: string;
      client_record_id: string;
      pg_no: string;
      inspection_kind: string;
    }>>`
      SELECT inspection_pg_reservation_id, client_record_id, pg_no, inspection_kind
      FROM inspection_pg_reservations
      WHERE status = 'RESERVED' AND expires_at <= ${now}
      ORDER BY expires_at, inspection_pg_reservation_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    for (const candidate of candidates) {
      await tx.inspection_pg_reservations.update({
        where: { inspection_pg_reservation_id: candidate.inspection_pg_reservation_id },
        data: {
          status: INSPECTION_PG_RESERVATION_STATUS.abandoned,
          abandoned_at: now,
          updated_at: now,
        },
      });
      await writeReservationActivity(tx, {
        userId: null,
        actionType: "PG_ISSUANCE_EXPIRED",
        pgNo: candidate.pg_no,
        clientRecordId: candidate.client_record_id,
        kind: candidate.inspection_kind,
        from: "RESERVED",
        to: "ABANDONED",
        reason: "EXPIRED",
      });
    }
    await options.context?.updateProgress(candidates.length, candidates.length);
    return {
      candidateCount: candidates.length,
      abandonedCount: candidates.length,
      summaryText: `Expired ${candidates.length} inspection PG reservation(s).`,
    };
  });
}
