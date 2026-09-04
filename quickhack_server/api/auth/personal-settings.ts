import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function PUT(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/personal-settings", {
      method: "PUT",
      body: bodyText,
    });
  }

  const [{ getAuthSessionFromRequest }, { prisma }] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/prisma"),
  ]);
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  const body = parseObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, code: "PERSONAL_SETTINGS_INPUT_INVALID" },
      { status: 400 }
    );
  }

  try {
    const { savePersonalSettings } = await import(
      "@/quickhack_server/user/personal-settings-service"
    );
    const personalSettings = await savePersonalSettings(
      prisma,
      session.users.user_id,
      body
    );

    const response = NextResponse.json({
      ok: true,
      resultCode: "PERSONAL_SETTINGS_SAVED",
      personalSettings,
    });
    const { setLocaleSnapshotCookie } = await import(
      "@/quickhack_server/i18n/locale-cookie"
    );
    setLocaleSnapshotCookie(request, response, personalSettings.locale);
    return response;
  } catch (error) {
    const { PersonalSettingsValidationError } = await import(
      "@/quickhack_server/user/personal-settings-service"
    );
    const validationError =
      error instanceof PersonalSettingsValidationError ? error : null;

    if (validationError) {
      const status =
        validationError.status === 401 || validationError.status === 409
          ? validationError.status
          : 400;
      return apiFailureResponse({
        status,
        code: "PERSONAL_SETTINGS_VALIDATION_FAILED",
        extra: { actionCode: validationError.actionCode },
        cause: validationError,
      });
    }

    return apiErrorResponse(error);
  }
}
