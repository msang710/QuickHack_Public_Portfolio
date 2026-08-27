import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  DESKTOP_NOTIFICATION_KIND,
  DESKTOP_NOTIFICATION_PAGE_LIMIT,
  type DesktopNotificationKind,
} from "@/quickhack_shared/notifications/desktop-notifications";

type DbClient = PrismaClient | Prisma.TransactionClient;

const POLICY = {
  [DESKTOP_NOTIFICATION_KIND.inspectionComplete]: {
    preference: "inspection_complete_notification_enabled",
    roles: ["STAFF", "MANAGER", "LEADER"],
  },
  [DESKTOP_NOTIFICATION_KIND.shipmentAddressChange]: {
    preference: "shipment_change_notification_enabled",
    roles: ["STAFF", "MANAGER", "LEADER"],
  },
  [DESKTOP_NOTIFICATION_KIND.returnRequest]: {
    preference: "return_notification_enabled",
    roles: ["STAFF", "MANAGER", "LEADER"],
  },
} as const;

export async function publishDesktopNotification(
  tx: Prisma.TransactionClient,
  input: {
    kind: DesktopNotificationKind;
    sourceType: string;
    sourceId: string;
    dedupeKey: string;
    menuId: string;
    title: string;
    body: string;
    occurredAt?: Date;
    resolvedAt?: Date | null;
  }
) {
  const policy = POLICY[input.kind];
  const event = await tx.desktop_notification_events.upsert({
    where: { dedupe_key: input.dedupeKey },
    create: {
      event_kind: input.kind,
      source_type: input.sourceType,
      source_id: input.sourceId,
      dedupe_key: input.dedupeKey,
      menu_id: input.menuId,
      title: input.title,
      body: input.body,
      occurred_at: input.occurredAt,
      resolved_at: input.resolvedAt,
    },
    update: {},
    select: { notification_event_id: true },
  });
  const recipients = await tx.users.findMany({
    where: {
      is_active: 1,
      role: { in: [...policy.roles] },
      user_preferences: { is: {
        windows_notifications_enabled: 1,
        [policy.preference]: 1,
      } },
    },
    select: { user_id: true },
  });
  if (recipients.length > 0) {
    await tx.desktop_notification_recipients.createMany({
      data: recipients.map(({ user_id }) => ({
        notification_event_id: event.notification_event_id,
        user_id,
      })),
      skipDuplicates: true,
    });
  }
  return event.notification_event_id;
}

type NotificationCursor = { occurredAt: string; recipientId: string };

function decodeCursor(value: string | null | undefined): NotificationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as NotificationCursor;
    if (!/^\d+$/.test(parsed.recipientId) || !Number.isFinite(Date.parse(parsed.occurredAt))) return null;
    return parsed;
  } catch { return null; }
}

function encodeCursor(value: NotificationCursor) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function listDesktopNotifications(
  client: DbClient,
  userId: number,
  options: { cursor?: string | null; limit?: number } = {}
) {
  const limit = Math.min(DESKTOP_NOTIFICATION_PAGE_LIMIT, Math.max(1, Math.trunc(options.limit ?? DESKTOP_NOTIFICATION_PAGE_LIMIT)));
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new Error("NOTIFICATION_CURSOR_INVALID");
  const rows = await client.desktop_notification_recipients.findMany({
    where: {
      user_id: userId,
      ...(cursor ? { OR: [
        { event: { is: { occurred_at: { lt: new Date(cursor.occurredAt) } } } },
        { event: { is: { occurred_at: new Date(cursor.occurredAt) } }, notification_recipient_id: { lt: BigInt(cursor.recipientId) } },
      ] } : {}),
    },
    orderBy: [{ event: { occurred_at: "desc" } }, { notification_recipient_id: "desc" }],
    take: limit + 1,
    include: { event: true },
  });
  const page = rows.slice(0, limit).map((row) => ({
    recipientId: row.notification_recipient_id.toString(),
    eventKind: row.event.event_kind as DesktopNotificationKind,
    menuId: row.event.menu_id,
    title: row.event.title,
    body: row.event.body,
    occurredAt: row.event.occurred_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
    resolvedAt: row.event.resolved_at?.toISOString() ?? null,
  }));
  const presentations = [] as Array<{
    presentationId: string; recipientIds: string[]; count: number;
    eventKind: DesktopNotificationKind; menuId: string; title: string; body: string;
    occurredAt: string; readAt: string | null; resolvedAt: string | null;
  }>;
  for (const item of page) {
    const groupKey = item.eventKind === DESKTOP_NOTIFICATION_KIND.inspectionComplete
      ? `${item.eventKind}:${item.menuId}:${Math.floor(Date.parse(item.occurredAt) / 30_000)}`
      : item.recipientId;
    const existing = presentations.find((candidate) => candidate.presentationId === groupKey);
    if (existing) {
      existing.recipientIds.push(item.recipientId);
      existing.count += 1;
      existing.title = `검수 완료 ${existing.count}건`;
      existing.body = `${existing.count}건의 검수 결과가 저장되었습니다.`;
      existing.readAt = existing.readAt && item.readAt ? existing.readAt : null;
      existing.resolvedAt = existing.resolvedAt && item.resolvedAt ? existing.resolvedAt : null;
    } else presentations.push({
      presentationId: groupKey,
      recipientIds: [item.recipientId], count: 1,
      eventKind: item.eventKind, menuId: item.menuId, title: item.title, body: item.body,
      occurredAt: item.occurredAt, readAt: item.readAt, resolvedAt: item.resolvedAt,
    });
  }
  const last = page.at(-1);
  return {
    presentations,
    unreadCount: await client.desktop_notification_recipients.count({ where: { user_id: userId, read_at: null } }),
    nextCursor: rows.length > limit && last ? encodeCursor({ occurredAt: last.occurredAt, recipientId: last.recipientId }) : null,
  };
}

export async function markDesktopNotificationsRead(
  client: PrismaClient,
  userId: number,
  recipientIds: bigint[]
) {
  const uniqueIds = [...new Set(recipientIds.map(String))].map(BigInt);
  if (uniqueIds.length === 0 || uniqueIds.length > DESKTOP_NOTIFICATION_PAGE_LIMIT) return false;
  return client.$transaction(async (tx) => {
    const owned = await tx.desktop_notification_recipients.count({ where: { user_id: userId, notification_recipient_id: { in: uniqueIds } } });
    if (owned !== uniqueIds.length) return false;
    await tx.desktop_notification_recipients.updateMany({
      where: { user_id: userId, notification_recipient_id: { in: uniqueIds } },
      data: { read_at: new Date() },
    });
    return true;
  });
}

export async function markDesktopNotificationsDelivered(client: PrismaClient, userId: number, recipientIds: bigint[]) {
  const uniqueIds = [...new Set(recipientIds.map(String))].map(BigInt);
  if (uniqueIds.length === 0 || uniqueIds.length > DESKTOP_NOTIFICATION_PAGE_LIMIT) return false;
  const result = await client.desktop_notification_recipients.updateMany({
    where: { user_id: userId, notification_recipient_id: { in: uniqueIds }, delivered_at: null },
    data: { delivered_at: new Date() },
  });
  return result.count <= uniqueIds.length;
}

export async function resolveDesktopNotificationBySource(tx: Pick<Prisma.TransactionClient, "desktop_notification_events">, input: { sourceType: string; sourceId: string; resolvedAt?: Date }) {
  return tx.desktop_notification_events.updateMany({
    where: { source_type: input.sourceType, source_id: input.sourceId, resolved_at: null },
    data: { resolved_at: input.resolvedAt ?? new Date() },
  });
}
