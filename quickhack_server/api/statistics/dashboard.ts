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
          { ok: false, message: "로그인이 필요합니다." },
          { status: 401 }
        );
      }

      if (!canAccessRole(user.role, "VIEWER")) {
        return NextResponse.json(
          { ok: false, message: "대쉬보드 조회 권한이 없습니다." },
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
            message: "대시보드 통계를 불러오지 못했습니다.",
          },
          { status: 500 }
        );
      }
    }
  );
}
