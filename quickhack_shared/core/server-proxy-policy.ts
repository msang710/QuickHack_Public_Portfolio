// QuickHack note: 데스크톱 클라이언트와 본서버 사이의 timeout 및 실패 응답 계약입니다.
export const DEFAULT_SERVER_PROXY_TIMEOUT_MS = 120_000;
export const AUTH_SERVER_PROXY_TIMEOUT_MS = 15_000;

export const SERVER_PROXY_ERROR_CODE = {
  unavailable: "SERVER_PROXY_UNAVAILABLE",
  timeout: "SERVER_PROXY_TIMEOUT",
} as const;

export type ServerProxyErrorCode =
  (typeof SERVER_PROXY_ERROR_CODE)[keyof typeof SERVER_PROXY_ERROR_CODE];

export type ServerProxyFailurePayload = {
  ok: false;
  code: ServerProxyErrorCode;
  message: string;
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
  detail = ""
): ServerProxyFailurePayload {
  const suffix = detail.trim() ? ` ${detail.trim()}` : "";

  return {
    ok: false,
    code: SERVER_PROXY_ERROR_CODE.unavailable,
    message: `중앙 서버에 연결할 수 없습니다.${suffix}`,
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
      message:
        "중앙 서버 응답 시간이 초과되었습니다. 잠시 뒤 다시 시도해 주세요.",
      retryable: true,
      uncertain: false,
    };
  }

  return {
    ok: false,
    code: SERVER_PROXY_ERROR_CODE.timeout,
    message:
      "요청이 적용됐는지 확인할 수 없습니다. 자동으로 다시 보내지 않았습니다. 화면을 새로고침하거나 해당 상태를 확인해 주세요.",
    retryable: false,
    uncertain: true,
  };
}
