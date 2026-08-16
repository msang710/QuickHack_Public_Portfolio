export const QUICKHACK_REQUEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

export function requestBodyLimitForPath(pathname) {
  return String(pathname || "").startsWith("/api/auth/")
    ? QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES
    : QUICKHACK_REQUEST_BODY_LIMIT_BYTES;
}

export function isJsonMediaType(value) {
  return (
    String(value || "").split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}
