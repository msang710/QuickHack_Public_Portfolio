// QuickHack note: 서버 작업 로그 조회 화면에 server_job_logs 데이터를 제공하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { KeysetCursorError } from "@/quickhack_server/core/database/keyset-page";
import {
  listServerJobLogPage,
  parseServerJobLogQuery,
  serverJobLogsCsvStream,
} from "@/quickhack_server/admin/admin-log-query-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/server-logs", {
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
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "LEADER")) {
    return NextResponse.json(
      { ok: false, code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const query = parseServerJobLogQuery(request.nextUrl.searchParams);
  if (request.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(serverJobLogsCsvStream(prisma, query), {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": 'attachment; filename="server-job-logs.csv"',
      },
    });
  }

  try {
    return NextResponse.json(await listServerJobLogPage(prisma, query));
  } catch (error) {
    if (error instanceof KeysetCursorError) {
      return NextResponse.json(
        { ok: false, code: error.code },
        { status: 400 }
      );
    }
    throw error;
  }
}
