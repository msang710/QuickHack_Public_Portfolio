import { NextRequest, NextResponse } from "next/server";
import { authorizeSupervisorRequest } from "@/quickhack_server/admin/supervisor-auth";
import { prisma } from "@/quickhack_server/core/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authorizationFailure = authorizeSupervisorRequest(request);
  if (authorizationFailure) return authorizationFailure;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, databaseReady: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, databaseReady: false, code: "DATABASE_NOT_READY" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
