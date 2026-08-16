// QuickHack note: 중앙 session과 로컬 cookie 만료가 모두 확인된 로그아웃만 성공으로 취급합니다.
type LogoutResponsePayload = {
  ok?: unknown;
  message?: unknown;
  code?: unknown;
  uncertain?: unknown;
};

function payloadMessage(payload: LogoutResponsePayload | null) {
  return typeof payload?.message === "string" && payload.message.trim()
    ? payload.message.trim()
    : "";
}

export async function requestQuickHackLogout(
  fetchImplementation: typeof fetch = fetch
) {
  const response = await fetchImplementation("/api/auth/logout", {
    method: "POST",
  });
  const payload = (await response
    .json()
    .catch(() => null)) as LogoutResponsePayload | null;

  if (!response.ok || payload?.ok !== true) {
    throw new Error(payloadMessage(payload) || "로그아웃하지 못했습니다.");
  }
}
