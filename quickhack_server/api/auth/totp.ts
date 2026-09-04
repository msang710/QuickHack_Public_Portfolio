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
    return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
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
    return NextResponse.json({ ok: false, code: "INVALID_BODY" }, { status: 400 });
  }

  const [authService, totpService] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/auth/totp-service"),
  ]);
  const session = await authService.getAuthSessionFromToken(token);
  if (!session) {
    return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
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
        return NextResponse.json({ ok: false, code: "OTP_CODE_INVALID" }, { status: 401 });
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
        return NextResponse.json({ ok: false, code: "OTP_NOT_CONFIGURED" }, { status: 409 });
      }
      if (!result.verification.verified) {
        return NextResponse.json(
          {
            ok: false,
            code: result.verification.locked
              ? "OTP_RATE_LIMITED"
              : "OTP_CODE_INVALID",
            details: result.verification.locked
              ? { remainingSeconds: result.verification.remainingLockedSeconds }
              : undefined,
          },
          { status: result.verification.locked ? 429 : 403 }
        );
      }
      const response = NextResponse.json({
        ok: true,
        resultCode: action === "disable" ? "OTP_DISABLED" : "OTP_RECOVERY_CODES_ISSUED",
        disabled: action === "disable",
        recoveryCodes: result.recoveryCodes,
      });
      if (result.token) authService.setSessionCookie(response, result.token);
      return response;
    }

    return NextResponse.json({ ok: false, code: "OTP_ACTION_UNSUPPORTED" }, { status: 400 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
