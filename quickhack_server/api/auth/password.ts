import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, apiFailureResponse } from "@/quickhack_server/api/error-response";
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

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/password", { method: "POST", body: bodyText });
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const body = parseJsonObject(bodyText);
  if (!body) {
    return NextResponse.json({ ok: false, code: "INVALID_BODY" }, { status: 400 });
  }

  const [authService, { prisma }, passwordService] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/prisma"),
    import("@/quickhack_server/auth/password-change-service"),
  ]);
  const session = await authService.getPasswordChangeSessionFromToken(token);
  if (!session) {
    return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  }

  try {
    const result = await passwordService.changeUserPassword(prisma, {
      userId: session.users.user_id,
      currentPasswordHash: session.users.password_hash,
      expectedCredentialRevision: session.users.credential_revision,
      mustChangePassword: session.users.must_change_password === 1,
      currentPassword: String(body.currentPassword || ""),
      newPassword: String(body.newPassword || ""),
      newPasswordConfirm: String(body.newPasswordConfirm || ""),
    });
    const response = NextResponse.json({
      ok: true,
      resultCode: "PASSWORD_CHANGED",
      mustChangePassword: false,
      revision: result.revision,
      user: authService.toAuthUser({ ...session.users, must_change_password: 0 }),
    });
    authService.setSessionCookie(response, result.token);
    return response;
  } catch (error) {
    if (error instanceof passwordService.PasswordChangeError) {
      return apiFailureResponse({
        status: error.status,
        code: error.code,
        cause: error,
      });
    }
    return apiErrorResponse(error);
  }
}
