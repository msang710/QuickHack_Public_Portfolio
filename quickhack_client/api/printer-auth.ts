import { NextRequest, NextResponse } from "next/server";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";
import { getServerProxyErrorMessage } from "@/quickhack_shared/core/server-proxy";

export async function authorizeLocalPrinter(request: NextRequest) {
  if (isServerRuntime()) {
    return {
      user: null,
      response: NextResponse.json(
        {
          ok: false,
          message:
            "The printer API is only available in QuickHack client or single runtime.",
        },
        { status: 403 }
      ),
    };
  }
  let user;
  try {
    user = await getRuntimeAuthUser(request);
  } catch (error) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, message: getServerProxyErrorMessage(error) },
        { status: 503 }
      ),
    };
  }
  if (!user) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, message: "Login is required." },
        { status: 401 }
      ),
    };
  }
  if (!canAccessRole(user.role, "STAFF")) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, message: "You do not have permission to use printers." },
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
      message: error instanceof Error ? error.message : String(error),
    },
    { status: uncertain ? 409 : 400 }
  );
}

