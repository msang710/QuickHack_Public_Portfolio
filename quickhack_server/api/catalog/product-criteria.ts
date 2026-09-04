// QuickHack note: 상품 기준값 목록을 조회하고 기준값 옵션을 저장하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole, type Role } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
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

async function auth(request: NextRequest, minRole: Role) {
  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      response: NextResponse.json(
        { ok: false, code: "AUTH_REQUIRED" },
        { status: 401 }
      ),
    };
  }

  if (!canAccessRole(user.role, minRole)) {
    return {
      response: NextResponse.json(
        { ok: false, code: "FORBIDDEN" },
        { status: 403 }
      ),
    };
  }

  return { user };
}

export async function GET(request: NextRequest) {
  const includeInactive =
    request.nextUrl.searchParams.get("includeInactive") === "1";
  const path = `/api/product-criteria${
    includeInactive ? "?includeInactive=1" : ""
  }`;

  if (isClientRuntime()) {
    return proxyToServer(request, path, {
      method: "GET",
      contentType: null,
    });
  }

  const authResult = await auth(request, "VIEWER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const [{ prisma }, { getProductCriteriaPayload }] = await Promise.all([
    import("@/quickhack_server/core/prisma"),
    import("@/quickhack_server/catalog/product-criteria-service"),
  ]);
  const data = await getProductCriteriaPayload(prisma, includeInactive);

  return NextResponse.json({ ok: true, data });
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/product-criteria", {
      method: "POST",
      body: bodyText,
    });
  }

  const authResult = await auth(request, "LEADER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  try {
    const [
      { prisma },
      {
        ensureDefaultProductCriteriaOptions,
        getProductCriteriaPayload,
        saveProductCriteriaRelations,
        upsertProductCriteriaOption,
      },
    ] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/catalog/product-criteria-service"),
    ]);

    if (body.action === "bootstrap") {
      await ensureDefaultProductCriteriaOptions(prisma);
      const result = { defaultCriteriaEnsured: true } as const;
      const receipt = createMutationReceipt(result, {
        operationId: stableMutationOperationId("product-criteria-bootstrap", [
          true,
        ]),
      });
      const refresh = await settleOptionalMutationRefresh(receipt, () =>
        getProductCriteriaPayload(prisma, true)
      );

      return NextResponse.json({
        ok: true,
        resultCode: "PRODUCT_CRITERIA_BOOTSTRAPPED",
        ...(refresh.completed ? { data: refresh.value } : {}),
        receipt: refresh.receipt,
      });
    }

    if (body.action === "saveRelations") {
      const relation = await saveProductCriteriaRelations(
        prisma,
        body,
        authResult.user
      );
      const receipt = createMutationReceipt(relation, {
        operationId: stableMutationOperationId(
          "product-criteria-relations",
          [relation.optionId, relation.relationRevision]
        ),
        committedAt: relation.updatedAt,
      });
      const refresh = await settleOptionalMutationRefresh(receipt, () =>
        getProductCriteriaPayload(prisma, true)
      );

      return NextResponse.json({
        ok: true,
        resultCode: "PRODUCT_CRITERIA_RELATION_SAVED",
        relation,
        ...(refresh.completed ? { data: refresh.value } : {}),
        receipt: refresh.receipt,
      });
    }

    const option = await upsertProductCriteriaOption(
      prisma,
      body,
      authResult.user
    );
    const receipt = createMutationReceipt(option, {
      operationId: stableMutationOperationId("product-criteria-option", [
        option.optionId,
        option.revision,
      ]),
      committedAt: option.updatedAt,
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      getProductCriteriaPayload(prisma, true)
    );

    return NextResponse.json({
      ok: true,
      resultCode: "PRODUCT_CRITERIA_SAVED",
      option,
      ...(refresh.completed ? { data: refresh.value } : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
