import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { AUTH_COOKIE_NAME, SENSITIVE_AUTH_MAX_AGE_SECONDS } from "@/quickhack_shared/auth/auth-constants";
import { parseSensitiveAction } from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

type SensitiveVerifyDependencies = {
  loadTotpService?: () => Promise<
    Pick<typeof import("@/quickhack_server/auth/totp-service"), "verifySensitiveSession">
  >;
};

function parseJsonObject(text: string) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function handleSensitiveVerify(request: NextRequest, dependencies: SensitiveVerifyDependencies) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/sensitive-verify", { method: "POST", body: bodyText });
  }
  const sessionToken = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  }
  const body = parseJsonObject(bodyText);
  if (!body) {
    return NextResponse.json({ ok: false, code: "INVALID_BODY" }, { status: 400 });
  }
  const code = String(body.otpCode || body.code || "").trim();
  const sensitiveAction = parseSensitiveAction(body.sensitiveAction || body.action);
  if (!sensitiveAction || !code) {
    return NextResponse.json({ ok: false, code: "SENSITIVE_VERIFICATION_INPUT_REQUIRED" }, { status: 400 });
  }

  try {
    const [{ verifySensitiveSession }, { toAuthUser }] = await Promise.all([
      dependencies.loadTotpService?.() ?? import("@/quickhack_server/auth/totp-service"),
      import("@/quickhack_server/auth/auth-service"),
    ]);
    const result = await verifySensitiveSession({ sessionToken, code, sensitiveAction });
    const verification = result.verification;
    if (!verification.enabled) {
      return NextResponse.json(
        { ok: false, code: "OTP_SETUP_REQUIRED", totpSetupRequired: true },
        { status: 403 }
      );
    }
    if (!verification.verified) {
      return NextResponse.json(
        {
          ok: false,
          code: verification.locked ? "OTP_RATE_LIMITED" : "OTP_CODE_INVALID",
          details: verification.locked
            ? { remainingSeconds: verification.remainingLockedSeconds }
            : undefined,
        },
        { status: verification.locked ? 429 : 401 }
      );
    }
    return NextResponse.json({
      ok: true,
      user: toAuthUser(result.user),
      sensitiveAuthenticated: true,
      sensitiveAction,
      sensitiveVerifiedUntil: result.verifiedUntil,
      sensitiveAuthMaxAgeSeconds: SENSITIVE_AUTH_MAX_AGE_SECONDS,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export function createSensitiveVerifyHandler(dependencies: SensitiveVerifyDependencies = {}) {
  return (request: NextRequest) => handleSensitiveVerify(request, dependencies);
}

export const POST = createSensitiveVerifyHandler();
