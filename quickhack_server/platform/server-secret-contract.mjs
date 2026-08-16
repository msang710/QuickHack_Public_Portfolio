export const SERVER_SECRET_KINDS = Object.freeze([
  "OTP_MASTER_KEY",
  "BACKUP_MASTER_KEY",
  "POSTGRESQL_CREDENTIAL",
  "MOBILE_SERIAL_HMAC",
  "QHKEY_MASTER_KEY",
]);

export const SERVER_SECRET_LIFECYCLES = Object.freeze([
  "OPAQUE_PAYLOAD",
  "ACTIVATION_CREDENTIAL",
]);

const SERVER_SECRET_KIND_SET = new Set(SERVER_SECRET_KINDS);

export function assertServerSecretKind(value) {
  const kind = String(value ?? "").trim();
  if (!SERVER_SECRET_KIND_SET.has(kind)) {
    throw new TypeError(`Unsupported server secret kind: ${kind || "empty"}.`);
  }
  return kind;
}

export function assertServerSecretBuffer(value, fieldName) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty Buffer.`);
  }
  return value;
}

export function createServerSecretProtectionMetadata(input) {
  const protection = String(input?.protection ?? "").trim();
  const identityScope = String(input?.identityScope ?? "").trim();
  const formatVersion = Number(input?.formatVersion);
  const lifecycle = String(input?.lifecycle ?? "").trim();
  if (!protection || !/^[A-Z][A-Z0-9_]*$/u.test(protection)) {
    throw new TypeError("Server secret protection metadata is invalid.");
  }
  if (!identityScope || !/^[A-Z][A-Z0-9_]*$/u.test(identityScope)) {
    throw new TypeError("Server secret identity scope metadata is invalid.");
  }
  if (!Number.isSafeInteger(formatVersion) || formatVersion < 1) {
    throw new TypeError("Server secret format version metadata is invalid.");
  }
  if (typeof input?.portable !== "boolean") {
    throw new TypeError("Server secret portability metadata is invalid.");
  }
  if (!SERVER_SECRET_LIFECYCLES.includes(lifecycle)) {
    throw new TypeError("Server secret lifecycle metadata is invalid.");
  }
  return Object.freeze({
    protection,
    identityScope,
    portable: input.portable,
    formatVersion,
    lifecycle,
  });
}
