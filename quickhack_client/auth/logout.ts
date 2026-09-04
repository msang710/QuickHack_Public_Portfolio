// QuickHack note: 중앙 session과 로컬 cookie 만료가 모두 확인된 로그아웃만 성공으로 취급합니다.
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";

type LogoutResponsePayload = {
  ok?: unknown;
  message?: unknown;
  code?: unknown;
  uncertain?: unknown;
};

export async function requestQuickHackLogout(
  fetchImplementation: typeof fetch,
  fallbackMessage: string
) {
  const response = await fetchImplementation("/api/auth/logout", {
    method: "POST",
  });
  const payload = (await response
    .json()
    .catch(() => null)) as LogoutResponsePayload | null;

  if (!response.ok || payload?.ok !== true) {
    throw new Error(legacyApiMessage(payload, fallbackMessage));
  }
}
