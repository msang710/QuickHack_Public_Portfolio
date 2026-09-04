import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import {
  isClientRuntime,
  normalizeInternalServerOrigin,
  requireInternalServerUrl,
} from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from "@/quickhack_shared/http/bounded-request-body";
import {
  bodyBoolean,
  bodyText,
  parseJsonObject,
  requireDeveloper,
} from "@/quickhack_server/api/developer/common";

export const runtime = "nodejs";

const MAX_RESPONSE_TEXT_LENGTH = 24_000;
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const SUPPORTED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_PATH_PREFIXES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/totp",
  "/api/auth/sensitive-verify",
  "/api/developer/api-sandbox",
];

function normalizeMethod(value: string) {
  return value.trim().toUpperCase();
}

function normalizePath(value: string) {
  const text = value.trim();

  if (!text.startsWith("/api/")) {
    return "";
  }

  try {
    const url = new URL(text, "http://quickhack.local");
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function isBlockedPath(pathname: string) {
  return BLOCKED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function truncateText(text: string) {
  if (text.length <= MAX_RESPONSE_TEXT_LENGTH) {
    return {
      text,
      truncated: false,
      originalLength: text.length,
    };
  }

  return {
    text: text.slice(0, MAX_RESPONSE_TEXT_LENGTH),
    truncated: true,
    originalLength: text.length,
  };
}

export function resolveApiSandboxTarget(internalOrigin: string, pathname: string) {
  const normalizedOrigin = normalizeInternalServerOrigin(internalOrigin);
  const url = new URL(pathname, `${normalizedOrigin}/`);
  if (url.origin !== normalizedOrigin || !url.pathname.startsWith("/api/")) {
    throw new Error("The API sandbox target escaped the internal API origin.");
  }
  return url;
}

export function apiSandboxOutboundHeaders(input: {
  internalOrigin: string;
  url: URL;
  cookie: string | null;
  method: string;
}) {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
  };
  if (input.url.origin !== normalizeInternalServerOrigin(input.internalOrigin)) {
    throw new Error("The API sandbox refused to forward a cookie across origins.");
  }
  if (input.cookie) {
    headers.cookie = input.cookie;
  }
  if (!SAFE_METHODS.has(input.method)) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

export async function POST(request: NextRequest) {
  let body;
  try {
    body = await readBoundedRequestText(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { ok: false, code: error.code },
        { status: 413 }
      );
    }
    throw error;
  }

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/developer/api-sandbox", {
      method: "POST",
      body,
    });
  }

  const auth = await requireDeveloper(request);

  if (!auth.ok) {
    return auth.response;
  }

  const parsed = parseJsonObject(body);

  if (!parsed) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  const method = normalizeMethod(bodyText(parsed, "method") || "GET");
  const pathname = normalizePath(bodyText(parsed, "path"));
  const requestBody = bodyText(parsed, "body");
  const allowWrite = bodyBoolean(parsed, "allowWrite");

  if (!SUPPORTED_METHODS.has(method)) {
    return NextResponse.json(
      { ok: false, code: "HTTP_METHOD_UNSUPPORTED" },
      { status: 400 }
    );
  }

  if (!pathname) {
    return NextResponse.json(
      { ok: false, code: "API_PATH_INVALID" },
      { status: 400 }
    );
  }

  if (isBlockedPath(new URL(pathname, "http://quickhack.internal").pathname)) {
    return NextResponse.json(
      { ok: false, code: "API_PATH_PROTECTED" },
      { status: 400 }
    );
  }

  if (!SAFE_METHODS.has(method) && !allowWrite) {
    return NextResponse.json(
      {
        ok: false,
        code: "API_WRITE_CONFIRMATION_REQUIRED",
      },
      { status: 400 }
    );
  }

  let internalOrigin: string;
  let url: URL;
  try {
    internalOrigin = requireInternalServerUrl();
    url = resolveApiSandboxTarget(internalOrigin, pathname);
  } catch (error) {
    return apiErrorResponse(error);
  }
  const cookie = request.headers.get("cookie");
  const headers = apiSandboxOutboundHeaders({
    internalOrigin,
    url,
    cookie,
    method,
  });

  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: SAFE_METHODS.has(method) ? undefined : requestBody || "{}",
      cache: "no-store",
      redirect: "manual",
    });
    const durationMs = Math.round(performance.now() - startedAt);
    const responseText = await response.text();
    const truncated = truncateText(responseText);
    let parsedJson: unknown = null;
    let jsonParseError = "";

    if ((response.headers.get("content-type") || "").includes("application/json")) {
      try {
        parsedJson = JSON.parse(responseText);
      } catch {
        jsonParseError = "응답 본문이 유효한 JSON 형식이 아닙니다.";
      }
    }

    return NextResponse.json({
      ok: true,
      request: {
        method,
        path: pathname,
        bodySent: !SAFE_METHODS.has(method),
      },
      response: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type") || "",
        durationMs,
        text: truncated.text,
        truncated: truncated.truncated,
        originalLength: truncated.originalLength,
        json: parsedJson,
        jsonParseError,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
