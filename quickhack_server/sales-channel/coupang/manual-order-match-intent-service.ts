import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { canonicalPgNos, normalizePgNo } from "@/quickhack_shared/inventory/pg-no";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";

const INTENT_TTL_MS = 30_000;
export const MANUAL_ORDER_MATCH_INTENT_RENEW_MS = 10_000;
type IntentClient = Prisma.TransactionClient | typeof prisma;

async function databaseClockNow(client: IntentClient) {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  if (!row?.now) throw new Error("PostgreSQL clock을 확인하지 못했습니다.");
  return row.now;
}

export async function hasActiveManualOrderMatchIntent(
  client: IntentClient,
  input: {
    externalOrderId: string;
    externalShipmentId: string;
    pgNo?: string | null;
  }
) {
  const now = await databaseClockNow(client);
  const pgNo = input.pgNo ? normalizePgNo(input.pgNo) : null;
  return Boolean(await client.manual_order_match_intent_leases.findFirst({
    where: {
      lease_status: "ACTIVE",
      expires_at: { gt: now },
      OR: [
        {
          external_order_id: input.externalOrderId,
          external_shipment_id: input.externalShipmentId,
        },
        ...(pgNo ? [{ pg_nos: { has: pgNo } }] : []),
      ],
    },
    select: { lease_id: true },
  }));
}

export async function filterTargetsWithoutManualOrderMatchIntent<
  T extends { externalOrderId: string; externalShipmentId: string },
>(client: IntentClient, targets: readonly T[]) {
  const available: T[] = [];
  for (const target of targets) {
    if (!(await hasActiveManualOrderMatchIntent(client, target))) {
      available.push(target);
    }
  }
  return available;
}

export async function acquireManualOrderMatchIntent(
  raw: Record<string, unknown>,
  user: AuthUser
) {
  const workItemId = Number(raw.workItemId);
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) {
    throw new Error("workItemId 값이 올바르지 않습니다.");
  }
  const work = await prisma.order_matching_work_queue.findUniqueOrThrow({
    where: { work_item_id: workItemId },
    select: { external_order_id: true, external_shipment_id: true, external_vendor_item_id: true },
  });
  const allocationId = raw.allocationId == null ? null : Number(raw.allocationId);
  const previous = allocationId && Number.isSafeInteger(allocationId)
    ? await prisma.match_worker_allocation.findFirst({
        where: {
          allocation_id: allocationId,
          external_order_id: work.external_order_id,
          external_shipment_id: work.external_shipment_id,
          external_vendor_item_id: work.external_vendor_item_id,
        },
        select: { pg_no: true },
      })
    : null;
  const pgNos = canonicalPgNos([
    previous?.pg_no,
    String(raw.operation ?? "").toUpperCase() === "RELEASE" ? null : raw.pgNo,
  ].filter((value): value is string => Boolean(value)));
  const now = await databaseClockNow(prisma);
  await prisma.manual_order_match_intent_leases.updateMany({
    where: { lease_status: "ACTIVE", expires_at: { lte: now } },
    data: { lease_status: "EXPIRED", released_at: now },
  });
  return prisma.manual_order_match_intent_leases.create({
    data: {
      external_order_id: work.external_order_id,
      external_shipment_id: work.external_shipment_id,
      pg_nos: pgNos,
      command_key: String(raw.idempotencyKey ?? "").trim(),
      owner_user_id: user.userId,
      acquired_at: now,
      expires_at: new Date(now.getTime() + INTENT_TTL_MS),
    },
  });
}

export async function releaseManualOrderMatchIntent(leaseId: string) {
  const now = await databaseClockNow(prisma);
  await prisma.manual_order_match_intent_leases.updateMany({
    where: { lease_id: leaseId, lease_status: "ACTIVE" },
    data: { lease_status: "RELEASED", released_at: now },
  });
}

export async function renewManualOrderMatchIntent(leaseId: string) {
  const now = await databaseClockNow(prisma);
  const renewed = await prisma.manual_order_match_intent_leases.updateMany({
    where: { lease_id: leaseId, lease_status: "ACTIVE", expires_at: { gt: now } },
    data: { expires_at: new Date(now.getTime() + INTENT_TTL_MS) },
  });
  return renewed.count === 1;
}

export async function assertManualOrderMatchIntentActive(
  client: IntentClient,
  leaseId: string,
  ownerUserId: number
) {
  const now = await databaseClockNow(client);
  const lease = await client.manual_order_match_intent_leases.findFirst({
    where: {
      lease_id: leaseId,
      owner_user_id: ownerUserId,
      lease_status: "ACTIVE",
      expires_at: { gt: now },
    },
    select: { lease_id: true },
  });
  if (!lease) throw new Error("MANUAL_INTENT_LOST");
}
