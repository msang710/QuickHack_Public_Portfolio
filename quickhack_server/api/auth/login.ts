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

export const runtime = "nodejs";

function invalidLoginResponse() {
  return NextResponse.json(
    { ok: false, message: "로그인 정보가 올바르지 않습니다." },
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
        { ok: false, code: error.code, message: "로그인 요청 본문이 너무 큽니다." },
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
      { ok: false, message: "아이디와 비밀번호를 입력하세요." },
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
        { ok: false, message: "잘못된 로그인 요청입니다." },
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
        include: { employee_profiles: true },
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
        message: `로그인 실패가 반복되어 잠시 제한되었습니다. ${attemptResult.remainingSeconds}초 후 다시 시도하세요.`,
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
  });

  setSessionCookie(response, token);
  return response;
}
