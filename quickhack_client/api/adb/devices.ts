// QuickHack note: 클라이언트 런타임에서 ADB 기기 조회 API 요청을 서버로 프록시합니다.
﻿import { NextRequest, NextResponse } from "next/server";
import { getConnectedAdbDevices, toAdbErrorResponse } from "@/quickhack_client/adb/adb";
import { getRuntimeAuthUser } from "@/quickhack_client/auth/request-auth";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isServerRuntime } from "@/quickhack_shared/core/runtime";
import { getServerProxyErrorMessage } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isServerRuntime()) {
    return NextResponse.json(
      { ok: false, message: "ADB API는 클라이언트 앱에서만 실행됩니다." },
      { status: 403 }
    );
  }

  let user;

  try {
    user = await getRuntimeAuthUser(request);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: getServerProxyErrorMessage(error) },
      { status: 503 }
    );
  }

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "ADB 기기 조회 권한이 없습니다." },
      { status: 403 }
    );
  }

  try {
    const devices = await getConnectedAdbDevices();

    return NextResponse.json({
      ok: true,
      devices,
    });
  } catch (error) {
    const response = toAdbErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
