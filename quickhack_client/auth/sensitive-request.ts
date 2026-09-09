// QuickHack note: 민감 작업 API 응답을 해석하고 2차 인증 필요 상태를 처리하는 클라이언트 헬퍼입니다.
import {
  isSensitiveAuthRequiredResponse,
  type SensitiveAuthRequiredResponse,
} from "@/quickhack_shared/auth/sensitive-auth";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";

type JsonBody = Record<string, unknown> | unknown[] | string | null;

export type SensitiveJsonRequest = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: JsonBody;
  headers?: Record<string, string>;
  cache?: RequestCache;
  fallbacks: SensitiveRequestFallbacks;
};

export type SensitiveRequestFallbacks = {
  authRequired: string;
  requestFailed: string;
  verifyFailed: string;
};

type PreparedSensitiveJsonRequest = {
  url: string;
  init: RequestInit;
  fallbacks: SensitiveRequestFallbacks;
};

type SensitiveVerifyResponse = {
  ok: boolean;
  message?: string;
  sensitiveAuthenticated?: boolean;
  sensitiveVerifiedUntil?: string;
  sensitiveAuthMaxAgeSeconds?: number;
};

export class ApiRequestError extends Error {
  readonly response: Response;
  readonly payload: unknown;

  constructor(message: string, response: Response, payload: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.response = response;
    this.payload = payload;
  }
}

export class SensitiveAuthRequiredError extends Error {
  readonly request: PreparedSensitiveJsonRequest;
  readonly response: Response;
  readonly payload: SensitiveAuthRequiredResponse;

  constructor(
    request: PreparedSensitiveJsonRequest,
    response: Response,
    payload: SensitiveAuthRequiredResponse
  ) {
    super(request.fallbacks.authRequired);
    this.name = "SensitiveAuthRequiredError";
    this.request = request;
    this.response = response;
    this.payload = payload;
  }
}

function prepareRequest(request: SensitiveJsonRequest): PreparedSensitiveJsonRequest {
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
  };
  const hasBody = request.body !== undefined;

  if (hasBody && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }

  return {
    url: request.url,
    fallbacks: request.fallbacks,
    init: {
      method: request.method ?? (hasBody ? "POST" : "GET"),
      headers,
      body: hasBody
        ? typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body)
        : undefined,
      cache: request.cache,
    },
  };
}

async function readJsonPayload(response: Response) {
  return (await response.json().catch(() => null)) as unknown;
}

async function runPreparedSensitiveJson<T>(
  request: PreparedSensitiveJsonRequest
) {
  const response = await fetch(request.url, request.init);
  const payload = await readJsonPayload(response);

  if (!response.ok && isSensitiveAuthRequiredResponse(payload)) {
    throw new SensitiveAuthRequiredError(request, response, payload);
  }

  if (!response.ok) {
    throw new ApiRequestError(
      legacyApiMessage(payload, request.fallbacks.requestFailed),
      response,
      payload
    );
  }

  return payload as T;
}

export async function sensitiveJsonFetch<T>(request: SensitiveJsonRequest) {
  return runPreparedSensitiveJson<T>(prepareRequest(request));
}

export async function verifySensitiveOtpCode(
  otpCode: string,
  sensitiveAction: string,
  fallbackMessage: string
) {
  const response = await fetch("/api/auth/sensitive-verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ otpCode, sensitiveAction }),
  });
  const payload = (await response.json().catch(() => null)) as
    | SensitiveVerifyResponse
    | null;

  if (!response.ok || !payload?.ok || !payload.sensitiveAuthenticated) {
    throw new ApiRequestError(
      legacyApiMessage(payload, fallbackMessage),
      response,
      payload
    );
  }

  return payload;
}

export async function retrySensitiveJsonFetch<T>(
  error: SensitiveAuthRequiredError,
  otpCode: string
) {
  await verifySensitiveOtpCode(
    otpCode,
    error.payload.sensitiveAction || "",
    error.request.fallbacks.verifyFailed
  );
  return runPreparedSensitiveJson<T>(error.request);
}
