import { NextRequest, NextResponse } from "next/server";
import {
  isJsonMediaType,
  requestBodyLimitForPath,
} from "@/quickhack_shared/http/request-body-policy.mjs";
import { AUTH_COOKIE_NAME } from "@/quickhack_shared/auth/auth-constants";
import { protectedWorkflowFamily, verifyWorkflowAdmission, WORKFLOW_ADMISSION_COOKIE } from "@/quickhack_shared/desktop/client-compatibility";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestOrigin(request: NextRequest) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");

  if (forwardedProto === "https" && forwardedHost) {
    return `https://${forwardedHost}`;
  }

  const host = request.headers.get("host");
  if (host) {
    return `${request.nextUrl.protocol}//${host}`;
  }

  return request.nextUrl.origin;
}

function isAllowedOrigin(request: NextRequest, origin: string) {
  return requestOrigin(request) === origin;
}

function requestHasBody(request: NextRequest) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    return Number(contentLength) > 0;
  }
  return request.body !== null;
}

function declaredBodyTooLarge(request: NextRequest) {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength)) {
    return false;
  }
  return Number(contentLength) > requestBodyLimitForPath(request.nextUrl.pathname);
}

function withSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  return response;
}

function cookie(request: NextRequest, name: string) { return request.cookies.get(name)?.value ?? ""; }

function admissionFailure(request: NextRequest) {
  const workflowFamily = protectedWorkflowFamily(request.nextUrl.pathname);
  if (!workflowFamily || request.nextUrl.pathname === "/api/auth/workflow-admission") return null;
  const clientFamily = request.headers.get("x-quickhack-client-family") ?? process.env.QUICKHACK_CLIENT_FAMILY ?? "BROWSER_DEVELOPMENT";
  if (!clientFamily.startsWith("ELECTRON_")) return null;
  const clientVersion = request.headers.get("x-quickhack-client-version") ?? process.env.QUICKHACK_CLIENT_VERSION ?? "0.0.0";
  try {
    verifyWorkflowAdmission(cookie(request, WORKFLOW_ADMISSION_COOKIE), { clientFamily, clientVersion, workflowFamily }, cookie(request, AUTH_COOKIE_NAME));
    return null;
  } catch (error) {
    const code = error instanceof Error && error.message === "WORKFLOW_ADMISSION_EXPIRED" ? "WORKFLOW_ADMISSION_EXPIRED" : "WORKFLOW_ADMISSION_INVALID";
    return NextResponse.json({ ok: false, code, message: code === "WORKFLOW_ADMISSION_EXPIRED" ? "업무 허용 시간이 만료됐습니다. 메뉴에 다시 진입하세요." : "이 업무를 시작할 수 있는 유효한 데스크톱 허용 정보가 없습니다." }, { status: 403 });
  }
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname.startsWith("/api/");

  if (!isApiRequest || !UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return withSecurityHeaders(NextResponse.next());
  }

  const admission = admissionFailure(request);
  if (admission) return withSecurityHeaders(admission);

  if (declaredBodyTooLarge(request)) {
    return withSecurityHeaders(
      NextResponse.json(
        { ok: false, code: "REQUEST_BODY_TOO_LARGE", message: "요청 본문이 너무 큽니다." },
        { status: 413 }
      )
    );
  }

  if (
    requestHasBody(request) &&
    !isJsonMediaType(request.headers.get("content-type"))
  ) {
    return withSecurityHeaders(
      NextResponse.json(
        {
          ok: false,
          code: "JSON_CONTENT_TYPE_REQUIRED",
          message: "JSON 요청은 application/json Content-Type을 사용해야 합니다.",
        },
        { status: 415 }
      )
    );
  }

  const origin = request.headers.get("origin");

  if (!origin || isAllowedOrigin(request, origin)) {
    return withSecurityHeaders(NextResponse.next());
  }

  return withSecurityHeaders(
    NextResponse.json(
      {
        ok: false,
        code: "ORIGIN_NOT_ALLOWED",
        message: "허용되지 않은 출처의 요청입니다.",
      },
      { status: 403 }
    )
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
