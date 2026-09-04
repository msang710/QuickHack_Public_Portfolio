const LEGACY_API_MESSAGE_MAX_LENGTH = 2_000;

type ApiMessagePayload = {
  code?: unknown;
  message?: unknown;
};

export function legacyApiMessage(
  payload: unknown,
  localizedFallback: string
) {
  if (!payload || typeof payload !== "object") return localizedFallback;

  const candidate = payload as ApiMessagePayload;
  if (typeof candidate.code === "string" && candidate.code.trim()) {
    return localizedFallback;
  }
  if (typeof candidate.message !== "string") return localizedFallback;

  const snapshot = candidate.message
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, LEGACY_API_MESSAGE_MAX_LENGTH);
  return snapshot || localizedFallback;
}
