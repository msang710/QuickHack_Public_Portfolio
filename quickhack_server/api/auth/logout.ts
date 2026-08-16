// QuickHack note: 현재 세션을 폐기하고 로그인 쿠키를 제거하는 서버 API 핸들러입니다.
﻿import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/logout", {
      method: "POST",
      contentType: null,
    });
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const { clearSessionCookie, deleteSessionToken } = await import("@/quickhack_server/auth/auth-service");

  if (token) {
    await deleteSessionToken(token);
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);

  return response;
}
