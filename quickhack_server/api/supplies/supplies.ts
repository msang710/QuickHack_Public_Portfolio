// QuickHack note: 비품관리 재고/소요예측/재구매 메뉴에 필요한 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  createMutationReceipt,
  settleOptionalMutationRefresh,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";
import {
  MUTATION_RECEIPT_OUTCOMES,
  type MutationReceiptOutcome,
} from "@/quickhack_shared/core/mutation-receipt";

export const runtime = "nodejs";

function parseJsonObject(text: string) {
  if (!text.trim()) {
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

async function requireStaff(request: NextRequest) {
  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, message: "비품관리 권한이 없습니다." },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, user };
}

function actionText(body: Record<string, unknown>) {
  return String(body.action ?? "").trim();
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/supplies", {
      method: "GET",
      contentType: null,
    });
  }

  const auth = await requireStaff(request);

  if (!auth.ok) {
    return auth.response;
  }

  const [{ prisma }, { getSupplyWorkspaceData }] = await Promise.all([
    import("@/quickhack_server/core/prisma"),
    import("@/quickhack_server/supplies/supplies-service"),
  ]);

  try {
    return NextResponse.json({
      ok: true,
      data: await getSupplyWorkspaceData(prisma, {
        reorderCursor: request.nextUrl.searchParams.get("reorderCursor"),
        reorderLimit: request.nextUrl.searchParams.get("reorderLimit"),
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/supplies", {
      method: "POST",
      body: bodyText,
    });
  }

  const auth = await requireStaff(request);

  if (!auth.ok) {
    return auth.response;
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 본문은 JSON 객체여야 합니다." },
      { status: 400 }
    );
  }

  const action = actionText(body);

  try {
    const [
      { prisma },
      {
        calculateSupplyForecasts,
        createSuggestedReordersFromForecasts,
        getSupplyWorkspaceData,
        recordSupplyMovement,
        saveSupply,
        saveSupplyConsumptionRule,
      },
    ] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/supplies/supplies-service"),
    ]);
    let result: unknown = null;
    let message = "비품관리 작업을 완료했습니다.";
    let receiptOperationId: string | null = null;
    let receiptOutcome: MutationReceiptOutcome =
      MUTATION_RECEIPT_OUTCOMES.committed;
    let receiptCommittedAt: Date | string | undefined;

    if (action === "saveSupply") {
      result = await saveSupply(prisma, body, auth.user);
      message = "비품 정보를 저장했습니다.";
    } else if (action === "recordMovement") {
      const command = await recordSupplyMovement(prisma, body, auth.user);
      result = command.movement;
      receiptOperationId = command.operationId;
      receiptOutcome = command.observed
        ? MUTATION_RECEIPT_OUTCOMES.observed
        : MUTATION_RECEIPT_OUTCOMES.committed;
      receiptCommittedAt = command.movement.created_at;
      message = "비품 재고 수량 변동을 저장했습니다.";
    } else if (action === "saveConsumptionRule") {
      result = await saveSupplyConsumptionRule(prisma, body, auth.user);
      message = "비품 소요 계산 규칙을 저장했습니다.";
    } else if (action === "calculateForecast") {
      result = await calculateSupplyForecasts(prisma, body, auth.user);
      message = "비품 소요예측을 계산했습니다.";
    } else if (action === "createReorderSuggestions") {
      result = await createSuggestedReordersFromForecasts(prisma, body, auth.user);
      message = "비품 재구매 추천을 생성했습니다.";
    } else {
      return NextResponse.json(
        { ok: false, message: "지원하지 않는 비품관리 작업입니다." },
        { status: 400 }
      );
    }

    const receipt = createMutationReceipt(result, {
      operationId:
        receiptOperationId ??
        stableMutationOperationId(`supplies-${action}`, [
          JSON.stringify(result),
        ]),
      outcome: receiptOutcome,
      committedAt: receiptCommittedAt,
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      getSupplyWorkspaceData(prisma)
    );

    return NextResponse.json({
      ok: true,
      message,
      result,
      ...(refresh.completed ? { data: refresh.value } : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/supplies", {
      method: "PATCH",
      body: bodyText,
    });
  }

  const auth = await requireStaff(request);

  if (!auth.ok) {
    return auth.response;
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 본문은 JSON 객체여야 합니다." },
      { status: 400 }
    );
  }

  const action = actionText(body);

  try {
    const [
      { prisma },
      { getSupplyWorkspaceData, saveSupply, updateSupplyReorderRequest },
    ] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/supplies/supplies-service"),
    ]);
    let result: unknown = null;
    let message = "비품관리 정보를 수정했습니다.";

    if (action === "saveSupply") {
      result = await saveSupply(prisma, body, auth.user);
      message = "비품 정보를 수정했습니다.";
    } else if (action === "updateReorderRequest") {
      result = await updateSupplyReorderRequest(prisma, body, auth.user);
      message = "비품 재구매 상태를 수정했습니다.";
    } else {
      return NextResponse.json(
        { ok: false, message: "지원하지 않는 비품관리 수정 작업입니다." },
        { status: 400 }
      );
    }

    const receipt = createMutationReceipt(result, {
      operationId: stableMutationOperationId(`supplies-${action}`, [
        JSON.stringify(result),
      ]),
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      getSupplyWorkspaceData(prisma)
    );

    return NextResponse.json({
      ok: true,
      message,
      result,
      ...(refresh.completed ? { data: refresh.value } : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
