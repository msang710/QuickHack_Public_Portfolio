import { NextRequest, NextResponse } from "next/server";
import {
  isJsonMediaType,
  requestBodyLimitForPath,
} from "@/quickhack_shared/http/request-body-policy.mjs";

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

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname.startsWith("/api/");

  if (!isApiRequest || !UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return withSecurityHeaders(NextResponse.next());
  }

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
