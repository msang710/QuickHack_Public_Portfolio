// QuickHack note: 직원 작업 이력 조회 화면에 employee_activity_logs 데이터를 제공하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { KeysetCursorError } from "@/quickhack_server/core/database/keyset-page";
import {
  activityLogsCsvStream,
  listActivityLogPage,
  parseActivityLogQuery,
} from "@/quickhack_server/admin/admin-log-query-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/activity-logs", {
      method: "GET",
      contentType: null,
      responseMode:
        request.nextUrl.searchParams.get("format") === "csv" ? "stream" : "buffer",
    });
  }

  const [{ getAuthUserFromRequest }, { prisma }] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/prisma"),
  ]);
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "LEADER")) {
    return NextResponse.json(
      { ok: false, message: "직원 작업 이력 조회 권한이 없습니다." },
      { status: 403 }
    );
  }

  const query = parseActivityLogQuery(request.nextUrl.searchParams);
  if (request.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(activityLogsCsvStream(prisma, query), {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": 'attachment; filename="employee-activity-logs.csv"',
      },
    });
  }

  try {
    return NextResponse.json(await listActivityLogPage(prisma, query));
  } catch (error) {
    if (error instanceof KeysetCursorError) {
      return NextResponse.json(
        { ok: false, code: error.code, message: error.message },
        { status: 400 }
      );
    }
    throw error;
  }
}
