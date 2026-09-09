// QuickHack note: 로그인 요청을 검증하고 세션 쿠키를 발급하는 서버 API 핸들러입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from "@/quickhack_shared/http/bounded-request-body";
import { normalizeAccountUsername } from "@/quickhack_shared/auth/account-username";
import { normalizeQuickHackLocale } from "@/quickhack_shared/i18n/locales";

export const runtime = "nodejs";

function invalidLoginResponse() {
  return NextResponse.json(
    { ok: false, code: "LOGIN_INVALID_CREDENTIALS" },
    { status: 401 }
  );
}

export async function POST(request: NextRequest) {
  let bodyText;
  try {
    bodyText = await readBoundedRequestText(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { ok: false, code: error.code },
        { status: 413 }
      );
    }
    throw error;
  }

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/login", {
      method: "POST",
      body: bodyText,
    });
  }

  const body = bodyText
    ? (() => {
        try {
          return JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          return null;
        }
      })()
    : null;
  const username = normalizeAccountUsername(body?.username);
  const password = String(body?.password || "");

  if (!username || !password) {
    return NextResponse.json(
      { ok: false, code: "LOGIN_CREDENTIALS_REQUIRED" },
      { status: 400 }
    );
  }

  const [
    { createUserSession, setSessionCookie, toAuthUser },
    { verifyLoginPassword },
    { prisma },
    {
      InvalidTrustedClientAddressError,
      executeLoginAttempt,
      loginAttemptIdentity,
    },
  ] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/password"),
    import("@/quickhack_server/core/prisma"),
    import("@/quickhack_server/auth/login-attempt-service"),
  ]);
  let attemptIdentity;

  try {
    attemptIdentity = loginAttemptIdentity(request.headers, username);
  } catch (error) {
    if (error instanceof InvalidTrustedClientAddressError) {
      return NextResponse.json(
        { ok: false, code: "LOGIN_REQUEST_INVALID" },
        { status: 400 }
      );
    }

    return apiErrorResponse(error);
  }

  const attemptResult = await executeLoginAttempt(
    prisma,
    attemptIdentity,
    async (tx) => {
      const user = await tx.users.findUnique({
        where: { username },
        include: { employee_profiles: true, user_preferences: true },
      });
      const passwordOk = await verifyLoginPassword(
        password,
        user?.is_active === 1 ? user.password_hash : null
      );
      return {
        succeeded: Boolean(user && user.is_active === 1 && passwordOk),
        value: user,
      };
    }
  );

  if (attemptResult.status === "BLOCKED") {
    return NextResponse.json(
      {
        ok: false,
        code: "LOGIN_RATE_LIMITED",
        details: { remainingSeconds: attemptResult.remainingSeconds },
      },
      { status: 429 }
    );
  }
  if (attemptResult.status === "FAILED") {
    return invalidLoginResponse();
  }

  const user = attemptResult.value;
  let token: string;
  try {
    token = await createUserSession(user.user_id, user.credential_revision);
  } catch {
    return invalidLoginResponse();
  }
  const response = NextResponse.json({
    ok: true,
    user: toAuthUser(user),
    locale: normalizeQuickHackLocale(user.user_preferences?.locale),
  });

  setSessionCookie(response, token);
  const { setLocaleSnapshotCookie } = await import(
    "@/quickhack_server/i18n/locale-cookie"
  );
  setLocaleSnapshotCookie(
    request,
    response,
    normalizeQuickHackLocale(user.user_preferences?.locale)
  );
  return response;
}
