import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { AUTH_COOKIE_NAME } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function parseJsonObject(text: string) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/totp", { method: "GET", contentType: null });
  }
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const [authService, totpService] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/auth/totp-service"),
  ]);
  const session = await authService.getAuthSessionFromToken(token);
  if (!session) {
    return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    user: authService.toAuthUser(session.users),
    status: await totpService.getUserTotpStatus(session.users.user_id),
  });
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/totp", { method: "POST", body: bodyText });
  }
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const body = parseJsonObject(bodyText);
  if (!body) {
    return NextResponse.json({ ok: false, message: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  const [authService, totpService] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/auth/totp-service"),
  ]);
  const session = await authService.getAuthSessionFromToken(token);
  if (!session) {
    return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
  }

  const action = String(body.action || "").trim();
  try {
    if (action === "setup") {
      const setup = await totpService.createTotpEnrollmentForSession({
        sessionId: session.session_id,
        userId: session.user_id,
        passwordHash: session.users.password_hash,
        password: String(body.password || ""),
      });
      return NextResponse.json({ ok: true, user: authService.toAuthUser(session.users), setup });
    }

    if (action === "confirm") {
      const result = await totpService.confirmTotpEnrollmentForSession({
        sessionId: session.session_id,
        userId: session.user_id,
        code: String(body.code || body.otpCode || ""),
        enrollmentToken: String(body.enrollmentToken || ""),
      });
      if (!result.confirmed) {
        return NextResponse.json({ ok: false, message: "OTP 코드가 올바르지 않습니다." }, { status: 401 });
      }
      const response = NextResponse.json({
        ok: true,
        user: authService.toAuthUser(session.users),
        confirmed: true,
        revision: result.revision,
        recoveryCodes: result.recoveryCodes,
      });
      authService.setSessionCookie(response, result.token);
      return response;
    }

    if (action === "recoveryCodes" || action === "disable") {
      const result = await totpService.manageUserTotpForSession({
        sessionId: session.session_id,
        userId: session.user_id,
        passwordHash: session.users.password_hash,
        password: String(body.password || ""),
        code: String(body.code || body.otpCode || ""),
        action,
      });
      if (!result.verification.enabled) {
        return NextResponse.json({ ok: false, message: "이 계정에는 OTP가 설정되어 있지 않습니다." }, { status: 409 });
      }
      if (!result.verification.verified) {
        return NextResponse.json(
          {
            ok: false,
            message: result.verification.locked
              ? `OTP 인증이 잠겼습니다. ${result.verification.remainingLockedSeconds}초 뒤 다시 시도하세요.`
              : "OTP 코드가 올바르지 않습니다.",
          },
          { status: result.verification.locked ? 429 : 403 }
        );
      }
      const response = NextResponse.json({
        ok: true,
        message:
          action === "disable"
            ? "OTP 2차 인증을 해제했습니다."
            : "OTP 복구코드를 새로 발급했습니다.",
        disabled: action === "disable",
        recoveryCodes: result.recoveryCodes,
      });
      if (result.token) authService.setSessionCookie(response, result.token);
      return response;
    }

    return NextResponse.json({ ok: false, message: "지원하지 않는 OTP 요청입니다." }, { status: 400 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
