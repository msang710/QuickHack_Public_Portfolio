// QuickHack note: 쿠팡 주문 아이템과 실제 재고를 매칭하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { ORDER_MATCHING_WORKER_KEY } from "@/quickhack_server/workers/worker-keys";

export const runtime = "nodejs";

function parseJsonObject(text: string) {
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/order-matching", {
      method: "POST",
      body: bodyText,
    });
  }

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  if (!parseJsonObject(bodyText)) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  try {
    const { runWorkerJob } = await import(
      "@/quickhack_server/workers/worker-jobs"
    );
    const result = await runWorkerJob(ORDER_MATCHING_WORKER_KEY, user);

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
