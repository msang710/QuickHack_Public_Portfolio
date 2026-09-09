// QuickHack note: 메인 대쉬보드에 필요한 오늘 차수별 검수 진행률을 반환합니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/statistics/dashboard", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "statistics.dashboard.read",
      source: "HTTP",
      route: "/api/statistics/dashboard",
      method: "GET",
    },
    async () => {
      const { getAuthUserFromRequest } = await import(
        "@/quickhack_server/auth/auth-service"
      );
      const user = await getAuthUserFromRequest(request);

      if (!user) {
        return NextResponse.json(
          { ok: false, code: "AUTH_REQUIRED" },
          { status: 401 }
        );
      }

      if (!canAccessRole(user.role, "VIEWER")) {
        return NextResponse.json(
          { ok: false, code: "FORBIDDEN" },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);

      const [{ prisma }, { getDashboardStatisticsData }] = await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/statistics/statistics-service"),
      ]);

      try {
        const data = await traceOperationSpan("SERVICE_READ", () =>
          getDashboardStatisticsData(prisma)
        );
        setOperationTraceTargetCount(data.batches.length);

        return NextResponse.json({
          ok: true,
          data,
        });
      } catch {
        return NextResponse.json(
          {
            ok: false,
            code: "DASHBOARD_LOAD_FAILED",
          },
          { status: 500 }
        );
      }
    }
  );
}
