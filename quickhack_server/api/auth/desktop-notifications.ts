import { NextRequest, NextResponse } from "next/server";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, `/api/auth/desktop-notifications${request.nextUrl.search}`);
  }
  const [{ getAuthSessionFromRequest }, { prisma }, service] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/prisma"),
    import("@/quickhack_server/notifications/desktop-notification-service"),
  ]);
  const session = await getAuthSessionFromRequest(request);
  if (!session) return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  return NextResponse.json({
    ok: true,
    ...(await service.listDesktopNotifications(prisma, session.users.user_id, {
      cursor: request.nextUrl.searchParams.get("cursor"),
      limit: Number(request.nextUrl.searchParams.get("limit") ?? 50),
    })),
  });
}

export async function PATCH(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/desktop-notifications", { method: "PATCH", body: bodyText });
  }
  const [{ getAuthSessionFromRequest }, { prisma }, service] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/prisma"),
    import("@/quickhack_server/notifications/desktop-notification-service"),
  ]);
  const session = await getAuthSessionFromRequest(request);
  if (!session) return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  const value = JSON.parse(bodyText) as { recipientIds?: unknown; action?: unknown };
  const rawIds = Array.isArray(value.recipientIds) ? value.recipientIds : [];
  const recipientIds = rawIds.map(String);
  if (recipientIds.length === 0 || recipientIds.some((id) => !/^\d+$/.test(id))) return NextResponse.json({ ok: false, code: "NOTIFICATION_IDS_INVALID" }, { status: 400 });
  const updated = String(value.action ?? "READ") === "DELIVERED"
    ? await service.markDesktopNotificationsDelivered(prisma, session.users.user_id, recipientIds.map(BigInt))
    : await service.markDesktopNotificationsRead(prisma, session.users.user_id, recipientIds.map(BigInt));
  return NextResponse.json({ ok: updated }, { status: updated ? 200 : 404 });
}
