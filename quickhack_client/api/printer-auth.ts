import { NextRequest, NextResponse } from "next/server";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";

export async function authorizeLocalPrinter(request: NextRequest) {
  if (isServerRuntime()) {
    return {
      user: null,
      response: NextResponse.json(
        {
          ok: false,
          code: "CLIENT_RUNTIME_REQUIRED",
        },
        { status: 403 }
      ),
    };
  }
  let user;
  try {
    user = await getRuntimeAuthUser(request);
  } catch {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, code: "SERVER_PROXY_FAILED" },
        { status: 503 }
      ),
    };
  }
  if (!user) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, code: "AUTH_REQUIRED" },
        { status: 401 }
      ),
    };
  }
  if (!canAccessRole(user.role, "STAFF")) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, code: "FORBIDDEN" },
        { status: 403 }
      ),
    };
  }
  return { user, response: null };
}

export function localPrinterErrorResponse(error: unknown) {
  const code =
    error instanceof Error && "code" in error
      ? String(error.code)
      : "LOCAL_PRINTER_ERROR";
  const uncertain =
    error instanceof Error &&
    "uncertain" in error &&
    Boolean(error.uncertain);
  return NextResponse.json(
    {
      ok: false,
      code,
      uncertain,
    },
    { status: uncertain ? 409 : 400 }
  );
}
