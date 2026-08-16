// QuickHack note: 현재 세션의 민감 메뉴 2차 인증 유효 여부를 반환하는 서버 API 핸들러입니다.
import { NextRequest, NextResponse } from "next/server";
import {
  SENSITIVE_AUTH_MAX_AGE_SECONDS,
  type AuthUser,
} from "@/quickhack_shared/auth/auth-constants";
import {
  canUseSensitiveAction,
  parseSensitiveAction,
  type SensitiveAction,
} from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function sensitiveResponse(
  user: AuthUser | null,
  sensitiveAuthenticated: boolean,
  sensitiveAction: SensitiveAction
) {
  return NextResponse.json({
    ok: true,
    authenticated: Boolean(user),
    sensitiveAuthenticated,
    sensitiveAction,
    sensitiveAuthMaxAgeSeconds: SENSITIVE_AUTH_MAX_AGE_SECONDS,
    user,
  });
}

export async function GET(request: NextRequest) {
  const requestedAction = request.nextUrl.searchParams.get("action") || "";

  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/auth/sensitive-status?action=${encodeURIComponent(requestedAction)}`,
      {
        method: "GET",
        contentType: null,
      }
    );
  }

  const sensitiveAction = parseSensitiveAction(requestedAction);

  if (!sensitiveAction) {
    return NextResponse.json(
      { ok: false, message: "유효한 민감 작업이 지정되지 않았습니다." },
      { status: 400 }
    );
  }

  const {
    getAuthSessionFromRequest,
    isSensitiveSessionVerified,
    toAuthUser,
  } = await import("@/quickhack_server/auth/auth-service");
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return sensitiveResponse(null, false, sensitiveAction);
  }

  const user = toAuthUser(session.users);

  if (!canUseSensitiveAction(user.role, sensitiveAction)) {
    return NextResponse.json(
      { ok: false, message: "민감 작업을 확인할 권한이 없습니다." },
      { status: 403 }
    );
  }

  return sensitiveResponse(
    user,
    isSensitiveSessionVerified(session, sensitiveAction),
    sensitiveAction
  );
}
