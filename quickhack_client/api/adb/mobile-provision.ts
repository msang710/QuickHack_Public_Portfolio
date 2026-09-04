import { NextRequest, NextResponse } from "next/server";
import { type MobileProvisioningBootstrap } from "@/quickhack_client/adb/mobile-provisioning";
import { requestNativeBroker } from "@/quickhack_client/native/native-broker-client";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isAdbVirtualSerial } from "@/quickhack_shared/adb/adb-target-policy";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";
import {
  getRemoteServerOrigin,
  getServerProxyErrorCode,
  mutateServerJson,
  ServerProxyError,
} from "@/quickhack_shared/core/server-proxy";
import { loadMobileManagedTrustBundle } from "@/quickhack_client/security/mobile-trust-bundle";
import { ADB_CLIENT_API_CODE } from "@/quickhack_client/api/adb/client-api-codes";

export const runtime = "nodejs";

type ProvisionResponse = {
  ok: boolean;
  code?: string;
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
      { ok: false, code: ADB_CLIENT_API_CODE.clientRuntimeRequired },
      { status: 403 }
    );
  }
  let user;
  try {
    user = await getRuntimeAuthUser(request);
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: getServerProxyErrorCode(error) },
      {
        status:
          error instanceof ServerProxyError && error.status
            ? error.status
            : 503,
      }
    );
  }
  if (!user) {
    return NextResponse.json({ ok: false, code: ADB_CLIENT_API_CODE.authRequired }, { status: 401 });
  }
  const body = objectBody(await request.json().catch(() => null));
  if (!body) {
    return NextResponse.json({ ok: false, code: ADB_CLIENT_API_CODE.invalidBody }, { status: 400 });
  }
  const scope = body.scope === "ADMIN" ? "ADMIN" : body.scope === "SELF" ? "SELF" : null;
  if (!scope || (scope === "ADMIN" && !canAccessRole(user.role, "LEADER"))) {
    return NextResponse.json({ ok: false, code: ADB_CLIENT_API_CODE.provisionForbidden }, { status: 403 });
  }
  const serial = String(body.adbSerial ?? "").trim();
  if (!serial || isAdbVirtualSerial(serial)) {
    return NextResponse.json(
      { ok: false, code: ADB_CLIENT_API_CODE.physicalDeviceRequired },
      { status: 400 }
    );
  }
  const deviceId = body.deviceId == null ? null : Number(body.deviceId);
  const serverOrigin = getRemoteServerOrigin();
  let trustBundle;
  try {
    trustBundle = loadMobileManagedTrustBundle(serverOrigin);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        code: ADB_CLIENT_API_CODE.trustBundleInvalid,
        detailsCode: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "TRUST_BUNDLE_INVALID",
      },
      { status: 503 }
    );
  }
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
      { ok: false, code: getServerProxyErrorCode(error) },
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
      {
        ok: false,
        code: provisioned.code || ADB_CLIENT_API_CODE.centralResponseInvalid,
      },
      { status: 502 }
    );
  }

  try {
    const enumeration = await requestNativeBroker("adb.list", {}) as { revision: string };
    await requestNativeBroker("adb.provision", {
      serial,
      enumerationRevision: enumeration.revision,
      serverOrigin,
      bootstrap: provisioned.bootstrap,
      trustBundle,
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
        code: compensated
          ? ADB_CLIENT_API_CODE.deliveryCompensated
          : ADB_CLIENT_API_CODE.deliveryRecoveryRequired,
        details: deliveryError instanceof Error ? deliveryError.message : "",
      },
      { status: compensated ? 409 : 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    code: ADB_CLIENT_API_CODE.provisionDelivered,
    item: provisioned.item,
  });
}
