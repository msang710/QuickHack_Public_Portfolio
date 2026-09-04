import { NextRequest, NextResponse } from "next/server";
import { toAdbErrorResponse } from "@/quickhack_client/adb/adb";
import { NativeBrokerClientError, requestNativeBroker } from "@/quickhack_client/native/native-broker-client";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";
import { getServerProxyErrorCode } from "@/quickhack_shared/core/server-proxy";
import { ADB_CLIENT_API_CODE, type AdbClientApiCode } from "@/quickhack_client/api/adb/client-api-codes";

export const runtime = "nodejs";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AdbActionRequestError extends Error {
  constructor(readonly code: AdbClientApiCode) {
    super(code);
  }
}

function readSerials(body: Record<string, unknown>) {
  if (!Array.isArray(body.serials) || body.serials.length === 0) {
    throw new AdbActionRequestError(ADB_CLIENT_API_CODE.serialsRequired);
  }
  const serials = body.serials.map((item) => String(item ?? "").trim());
  if (serials.some((serial) => !serial)) {
    throw new AdbActionRequestError(ADB_CLIENT_API_CODE.serialEmpty);
  }
  return [...new Set(serials)];
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
      { status: 503 }
    );
  }
  if (!user) {
    return NextResponse.json({ ok: false, code: ADB_CLIENT_API_CODE.authRequired }, { status: 401 });
  }
  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json({ ok: false, code: ADB_CLIENT_API_CODE.actionForbidden }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!isObject(body) || typeof body.action !== "string") {
    return NextResponse.json({ ok: false, code: ADB_CLIENT_API_CODE.actionRequired }, { status: 400 });
  }
  let serials: string[];
  try {
    serials = readSerials(body);
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: error instanceof AdbActionRequestError ? error.code : ADB_CLIENT_API_CODE.invalidBody },
      { status: 400 }
    );
  }
  try {
    const enumeration = await requestNativeBroker("adb.list", {}) as { revision: string };
    const result = await requestNativeBroker("adb.action", { action: body.action, serials, enumerationRevision: enumeration.revision }) as { failCount: number } & Record<string, unknown>;
    return NextResponse.json({ ok: result.failCount === 0, ...result });
  } catch (error) {
    if (error instanceof NativeBrokerClientError) {
      return NextResponse.json({ ok: false, code: error.code }, { status: error.code === "SELECTION_STALE" ? 409 : 503 });
    }
    const response = toAdbErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
