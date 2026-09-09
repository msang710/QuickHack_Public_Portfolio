// QuickHack note: 데스크톱 클라이언트와 본서버 사이의 timeout 및 실패 응답 계약입니다.
export const DEFAULT_SERVER_PROXY_TIMEOUT_MS = 120_000;
export const AUTH_SERVER_PROXY_TIMEOUT_MS = 15_000;

export const SERVER_PROXY_ERROR_CODE = {
  unavailable: "SERVER_PROXY_UNAVAILABLE",
  timeout: "SERVER_PROXY_TIMEOUT",
  invalidResponse: "SERVER_PROXY_INVALID_RESPONSE",
  upstream: "SERVER_PROXY_UPSTREAM_ERROR",
} as const;

export type ServerProxyErrorCode =
  (typeof SERVER_PROXY_ERROR_CODE)[keyof typeof SERVER_PROXY_ERROR_CODE];

export type ServerProxyFailurePayload = {
  ok: false;
  code: ServerProxyErrorCode;
  retryable: boolean;
  uncertain: boolean;
};

export function serverProxyTimeoutMs(pathname: string) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;

  return normalizedPath.startsWith("/api/auth/")
    ? AUTH_SERVER_PROXY_TIMEOUT_MS
    : DEFAULT_SERVER_PROXY_TIMEOUT_MS;
}

export function isServerProxyReadMethod(method: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method.trim().toUpperCase());
}

export function serverProxyUnavailablePayload(
  _detail = ""
): ServerProxyFailurePayload {
  return {
    ok: false,
    code: SERVER_PROXY_ERROR_CODE.unavailable,
    retryable: false,
    uncertain: false,
  };
}

export function serverProxyTimeoutPayload(
  method: string
): ServerProxyFailurePayload {
  if (isServerProxyReadMethod(method)) {
    return {
      ok: false,
      code: SERVER_PROXY_ERROR_CODE.timeout,
      retryable: true,
      uncertain: false,
    };
  }

  return {
    ok: false,
    code: SERVER_PROXY_ERROR_CODE.timeout,
    retryable: false,
    uncertain: true,
  };
}
