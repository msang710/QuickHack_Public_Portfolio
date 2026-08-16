import { NextRequest, NextResponse } from "next/server";
import {
  deliverMobileProvisioningBootstrap,
  type MobileProvisioningBootstrap,
} from "@/quickhack_client/adb/mobile-provisioning";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isAdbVirtualSerial } from "@/quickhack_shared/adb/adb-target-policy";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";
import {
  getRemoteServerOrigin,
  getServerProxyErrorMessage,
  mutateServerJson,
  ServerProxyError,
} from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

type ProvisionResponse = {
  ok: boolean;
  message?: string;
  item?: Record<string, unknown>;
  bootstrap?: MobileProvisioningBootstrap;
};

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validBootstrap(value: unknown): value is MobileProvisioningBootstrap {
  const item = objectBody(value);
  return !!(
    item &&
    item.version === 1 &&
    Number.isInteger(item.deviceId) &&
    Number(item.deviceId) > 0 &&
    Number.isInteger(item.registrationRevision) &&
    Number(item.registrationRevision) >= 0 &&
    typeof item.provisioningToken === "string" &&
    item.provisioningToken.length >= 32 &&
    typeof item.provisioningExpiresAt === "string"
  );
}

export async function POST(request: NextRequest) {
  if (isServerRuntime()) {
    return NextResponse.json(
      { ok: false, message: "USB 기기 등록은 클라이언트 런타임에서만 실행합니다." },
      { status: 403 }
    );
  }
  let user;
  try {
    user = await getRuntimeAuthUser(request);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: getServerProxyErrorMessage(error) },
      {
        status:
          error instanceof ServerProxyError && error.status
            ? error.status
            : 503,
      }
    );
  }
  if (!user) {
    return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
  }
  const body = objectBody(await request.json().catch(() => null));
  if (!body) {
    return NextResponse.json({ ok: false, message: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }
  const scope = body.scope === "ADMIN" ? "ADMIN" : body.scope === "SELF" ? "SELF" : null;
  if (!scope || (scope === "ADMIN" && !canAccessRole(user.role, "LEADER"))) {
    return NextResponse.json({ ok: false, message: "기기 등록 권한이 없습니다." }, { status: 403 });
  }
  const serial = String(body.adbSerial ?? "").trim();
  if (!serial || isAdbVirtualSerial(serial)) {
    return NextResponse.json(
      { ok: false, message: "현재 연결된 실제 USB ADB 기기를 선택하세요." },
      { status: 400 }
    );
  }
  const deviceId = body.deviceId == null ? null : Number(body.deviceId);
  const action = deviceId ? "reprovision" : "beginProvisioning";
  const pathname = scope === "ADMIN" ? "/api/admin/mobile-devices" : "/api/auth/mobile-devices";
  const mainBody = {
    action,
    ...(scope === "ADMIN" ? { userId: body.userId } : {}),
    adbSerial: serial,
    label: body.label,
    ...(deviceId
      ? {
          deviceId,
          expectedRegistrationRevision: body.expectedRegistrationRevision,
        }
      : {}),
  };
  const cookieHeader = request.headers.get("cookie") ?? undefined;
  let provisioned: ProvisionResponse;
  try {
    provisioned = await mutateServerJson<ProvisionResponse>({
      pathname,
      cookieHeader,
      body: mainBody,
      signal: request.signal,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: getServerProxyErrorMessage(error) },
      {
        status:
          error instanceof ServerProxyError && error.status
            ? error.status
            : 503,
      }
    );
  }
  if (!provisioned.ok || !validBootstrap(provisioned.bootstrap)) {
    return NextResponse.json(
      { ok: false, message: provisioned.message || "중앙 서버의 기기 등록 응답이 올바르지 않습니다." },
      { status: 502 }
    );
  }

  try {
    await deliverMobileProvisioningBootstrap({
      serial,
      serverOrigin: getRemoteServerOrigin(),
      bootstrap: provisioned.bootstrap,
    });
  } catch (deliveryError) {
    let compensated = false;
    try {
      await mutateServerJson({
        pathname,
        cookieHeader,
        body: {
          action: "cancelProvisioning",
          deviceId: provisioned.bootstrap.deviceId,
          expectedRegistrationRevision: provisioned.bootstrap.registrationRevision,
          provisioningToken: provisioned.bootstrap.provisioningToken,
        },
      });
      compensated = true;
    } catch {
      // The unchanged PROVISIONING row remains visible for explicit revocation.
    }
    return NextResponse.json(
      {
        ok: false,
        recoveryRequired: !compensated,
        message: compensated
          ? `USB 전달에 실패해 등록 요청을 안전하게 폐기했습니다. ${deliveryError instanceof Error ? deliveryError.message : ""}`.trim()
          : "USB 전달에 실패했고 등록 상태도 변경되었습니다. 목록을 새로고침해 PROVISIONING 등록을 폐기하세요.",
      },
      { status: compensated ? 409 : 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "선택한 실제 USB 기기로 보안 등록 정보를 전달했습니다. 모바일 앱에서 로그인하세요.",
    item: provisioned.item,
  });
}
