// QuickHack note: 상품 기준값 목록을 조회하고 기준값 옵션을 저장하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole, type Role } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

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
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }

  if (!canAccessRole(user.role, minRole)) {
    return {
      response: NextResponse.json(
        { ok: false, message: "상품 기준값 관리 권한이 없습니다." },
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
      { ok: false, message: "요청 본문이 올바르지 않습니다." },
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
      const data = await getProductCriteriaPayload(prisma, true);

      return NextResponse.json({
        ok: true,
        message: "기본 상품 기준값을 확인했습니다.",
        data,
      });
    }

    if (body.action === "saveRelations") {
      await saveProductCriteriaRelations(prisma, body, authResult.user);
      const data = await getProductCriteriaPayload(prisma, true);

      return NextResponse.json({
        ok: true,
        message: "연결된 기준값을 저장했습니다.",
        data,
      });
    }

    const option = await upsertProductCriteriaOption(
      prisma,
      body,
      authResult.user
    );
    const data = await getProductCriteriaPayload(prisma, true);

    return NextResponse.json({
      ok: true,
      message: "상품 기준값을 저장했습니다.",
      option,
      data,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
