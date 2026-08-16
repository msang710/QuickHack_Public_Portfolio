import { NextRequest, NextResponse } from "next/server";
import { runAdbAction, toAdbErrorResponse } from "@/quickhack_client/adb/adb";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";
import { getServerProxyErrorMessage } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSerials(body: Record<string, unknown>) {
  if (!Array.isArray(body.serials) || body.serials.length === 0) {
    throw new Error("ADB 작업 대상 기기 목록을 명시해야 합니다.");
  }
  const serials = body.serials.map((item) => String(item ?? "").trim());
  if (serials.some((serial) => !serial)) {
    throw new Error("ADB 작업 대상 기기 목록에 빈 값이 있습니다.");
  }
  return [...new Set(serials)];
}

export async function POST(request: NextRequest) {
  if (isServerRuntime()) {
    return NextResponse.json(
      { ok: false, message: "ADB API는 클라이언트 런타임에서만 실행합니다." },
      { status: 403 }
    );
  }
  let user;
  try {
    user = await getRuntimeAuthUser(request);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: getServerProxyErrorMessage(error) },
      { status: 503 }
    );
  }
  if (!user) {
    return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
  }
  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json({ ok: false, message: "ADB 작업 실행 권한이 없습니다." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!isObject(body) || typeof body.action !== "string") {
    return NextResponse.json({ ok: false, message: "실행할 ADB 작업이 없습니다." }, { status: 400 });
  }
  let serials: string[];
  try {
    serials = readSerials(body);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "ADB 대상이 올바르지 않습니다." },
      { status: 400 }
    );
  }
  try {
    const result = await runAdbAction(body.action, serials);
    return NextResponse.json({ ok: result.failCount === 0, ...result });
  } catch (error) {
    const response = toAdbErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
