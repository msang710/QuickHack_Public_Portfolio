import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { SENSITIVE_ACTIONS, sensitiveAuthRequiredResponse } from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { runOperationTrace, setOperationTraceTargetCount, setOperationTraceUserId, traceOperationSpan } from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) return proxyToServer(request, `/api/coupang/manual-order-matches${request.nextUrl.search}`, { method: "GET", contentType: null });
  return runOperationTrace({ operationName: "sales-channel.manual-order-match.read", source: "HTTP", route: "/api/coupang/manual-order-matches", method: "GET" }, async () => {
    const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
    const user = await getAuthUserFromRequest(request);
    if (!user) return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    if (!canAccessRole(user.role, "STAFF")) return NextResponse.json({ ok: false, message: "주문 변경 요청 조회 권한이 없습니다." }, { status: 403 });
    setOperationTraceUserId(user.userId);
    const service = await import("@/quickhack_server/sales-channel/coupang/manual-order-match-service");
    const mode = request.nextUrl.searchParams.get("mode");
    try {
      const data = mode === "candidates"
        ? await traceOperationSpan("SERVICE_READ_CANDIDATES", () =>
            service.listManualOrderMatchCandidates({
              search: request.nextUrl.searchParams.get("search"),
              limit: Number(request.nextUrl.searchParams.get("limit") ?? 40),
              workItemId: Number(request.nextUrl.searchParams.get("workItemId")),
              operation: String(request.nextUrl.searchParams.get("operation") ?? "ASSIGN") as "ASSIGN" | "REPLACE",
            }, user)
          )
        : await traceOperationSpan("SERVICE_READ", () =>
            service.listManualOrderMatches({
              search: request.nextUrl.searchParams.get("search"),
              limit: Number(request.nextUrl.searchParams.get("limit") ?? 50),
            })
          );
      setOperationTraceTargetCount(data.items.length);
      return NextResponse.json({ ok: true, data });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) return proxyToServer(request, "/api/coupang/manual-order-matches", { method: "POST", body: bodyText });
  return runOperationTrace({ operationName: "sales-channel.manual-order-match.write", source: "HTTP", route: "/api/coupang/manual-order-matches", method: "POST" }, async () => {
    const { getAuthSessionFromRequest, getAuthUserFromRequest, isSensitiveSessionVerified } = await import("@/quickhack_server/auth/auth-service");
    const user = await getAuthUserFromRequest(request);
    if (!user) return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    let body: Record<string, unknown>;
    try { body = JSON.parse(bodyText || "{}"); } catch { return NextResponse.json({ ok: false, message: "요청 본문이 올바르지 않습니다." }, { status: 400 }); }
    const action = String(body.action ?? "").toUpperCase();
    const service = await import("@/quickhack_server/sales-channel/coupang/manual-order-match-service");
    setOperationTraceUserId(user.userId);
    if (action === "PREVIEW") {
      if (!canAccessRole(user.role, "STAFF")) return NextResponse.json({ ok: false, message: "주문 변경 요청 조회 권한이 없습니다." }, { status: 403 });
      try {
        const data = await traceOperationSpan("SERVICE_READ", () => service.previewManualOrderMatch(body, user));
        setOperationTraceTargetCount(1);
        return NextResponse.json({ ok: true, data });
      } catch (error) { return apiErrorResponse(error); }
    }
    if (action !== "EXECUTE") return NextResponse.json({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
    if (!canAccessRole(user.role, "MANAGER")) return NextResponse.json({ ok: false, message: "주문 변경 요청 처리 권한이 없습니다." }, { status: 403 });
    const session = await getAuthSessionFromRequest(request);
    if (!session || !isSensitiveSessionVerified(session, SENSITIVE_ACTIONS.channelOrderMatching)) return NextResponse.json(sensitiveAuthRequiredResponse("주문 PG 변경은 OTP 인증이 필요합니다.", SENSITIVE_ACTIONS.channelOrderMatching), { status: 403 });
    try {
      const data = await traceOperationSpan("SERVICE_WRITE", () => service.executeManualOrderMatch(body, user, { sensitiveActionVerified: true }));
      setOperationTraceTargetCount(1);
      return NextResponse.json({ ok: true, data });
    } catch (error) { return apiErrorResponse(error); }
  });
}
