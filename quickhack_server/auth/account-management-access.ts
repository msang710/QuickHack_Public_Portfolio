// QuickHack note: 사용자 계정 관리 전용 LEADER 권한과 OTP grant를 서버에서 함께 강제합니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import {
  SENSITIVE_ACTIONS,
  sensitiveAuthRequiredResponse,
} from "@/quickhack_shared/auth/sensitive-auth";

export async function authorizeAccountManagement(request: NextRequest) {
  const {
    getAuthSessionFromRequest,
    isSensitiveSessionVerified,
    toAuthUser,
  } = await import("@/quickhack_server/auth/auth-service");
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return {
      authorized: false as const,
      response: NextResponse.json(
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }

  const user = toAuthUser(session.users);

  if (!canAccessRole(user.role, "LEADER")) {
    return {
      authorized: false as const,
      response: NextResponse.json(
        { ok: false, message: "사용자 계정 관리 권한이 없습니다." },
        { status: 403 }
      ),
    };
  }

  if (
    !isSensitiveSessionVerified(
      session,
      SENSITIVE_ACTIONS.accountManagement
    )
  ) {
    return {
      authorized: false as const,
      response: NextResponse.json(
        sensitiveAuthRequiredResponse(
          "사용자 계정 관리는 OTP 인증이 필요합니다.",
          SENSITIVE_ACTIONS.accountManagement
        ),
        { status: 403 }
      ),
    };
  }

  return {
    authorized: true as const,
    user,
    securityContext: {
      actor: user,
      sessionId: session.session_id,
    },
  };
}
