// QuickHack note: 매입가 기준을 날짜/조건별로 조회하고 저장하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import {
  createMutationReceipt,
  settleOptionalMutationRefresh,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";

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

function purchasePricePath(request: NextRequest) {
  const query = request.nextUrl.searchParams.toString();

  return `/api/inbound/purchase-prices${query ? `?${query}` : ""}`;
}

function purchasePriceNoteFromBody(body: Record<string, unknown>) {
  if (typeof body.note === "string") {
    return body.note;
  }

  if (typeof body.conditionNote === "string") {
    return body.conditionNote;
  }

  return "";
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, purchasePricePath(request), {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.purchase-price.read",
      source: "HTTP",
      route: "/api/inbound/purchase-prices",
      method: "GET",
    },
    async () => {

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return apiFailureResponse({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      message: "로그인이 필요합니다.",
    });
  }

  if (!canAccessRole(user.role, "MANAGER")) {
    return apiFailureResponse({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "매입가 지정 권한이 없습니다.",
    });
  }
  setOperationTraceUserId(user.userId);

  try {
    const priceDate = request.nextUrl.searchParams.get("priceDate") ?? "";
    const hasNote = request.nextUrl.searchParams.has("note");
    const note = request.nextUrl.searchParams.get("note") ?? "";

    if (!priceDate || !hasNote) {
      return apiFailureResponse({
        status: 400,
        code: "PURCHASE_PRICE_QUERY_CONTEXT_REQUIRED",
        message: "매입가 조회에는 적용일과 조건 메모가 모두 필요합니다.",
      });
    }
    const [
      { prisma },
      { listPurchasePriceConditionNotes, listPurchasePriceRates },
    ] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inbound/purchase-price-service"),
    ]);
    const [rates, notes] = await traceOperationSpan("SERVICE_READ", () =>
      Promise.all([
        listPurchasePriceRates(prisma, priceDate, note),
        listPurchasePriceConditionNotes(prisma, priceDate),
      ])
    );
    setOperationTraceTargetCount(rates.length);

    return NextResponse.json({
      ok: true,
      queryContext: { priceDate, note },
      rates,
      notes,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/purchase-prices", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.purchase-price.save",
      source: "HTTP",
      route: "/api/inbound/purchase-prices",
      method: "POST",
    },
    async () => {

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return apiFailureResponse({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      message: "로그인이 필요합니다.",
    });
  }

  if (!canAccessRole(user.role, "MANAGER")) {
    return apiFailureResponse({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "매입가 지정 권한이 없습니다.",
    });
  }
  setOperationTraceUserId(user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",
      message: "요청 본문이 올바르지 않습니다.",
    });
  }
  setOperationTraceTargetCount(Array.isArray(body.rates) ? body.rates.length : 0);

  try {
    const [
      { prisma },
      {
        listPurchasePriceConditionNotes,
        listPurchasePriceRates,
        savePurchasePriceRates,
      },
    ] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inbound/purchase-price-service"),
    ]);
    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      savePurchasePriceRates(prisma, body, user)
    );
    const note = purchasePriceNoteFromBody(body);
    const priceDate = String(body.priceDate ?? "");
    const receipt = createMutationReceipt(result, {
      operationId: stableMutationOperationId(
        "purchase-price-save",
        result.savedRates.flatMap((rate) => [rate.id, rate.revision])
      ),
      committedAt: result.savedRates.at(-1)?.updatedAt,
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      traceOperationSpan("SERVICE_READ", () =>
        Promise.all([
          listPurchasePriceRates(prisma, priceDate, note),
          listPurchasePriceConditionNotes(prisma, priceDate),
        ])
      )
    );

    return NextResponse.json({
      ok: true,
      message: `매입가 기준 ${result.savedRates.length}개를 저장했습니다.`,
      queryContext: { priceDate, note },
      ...(refresh.completed
        ? { rates: refresh.value[0], notes: refresh.value[1] }
        : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
