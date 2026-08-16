import path from "node:path";

export const QHKEY_PROVIDERS = Object.freeze(["COUPANG", "LOGEN"]);

export const QHKEY_PROVIDER_RELATIVE_PATHS = Object.freeze({
  COUPANG: path.join("quickhack-keys", "coupang.qhkey"),
  LOGEN: path.join("quickhack-keys", "logen.qhkey"),
});

export const QHKEY_REPLACEMENT_STATES = Object.freeze([
  "PREPARED",
  "AUTHORIZATION_REQUIRED",
  "PUBLISHING",
  "PUBLISHED",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
  "RECOVERY_REQUIRED",
]);

export const QHKEY_ERROR_CODES = Object.freeze([
  "QHKEY_VOLUME_MISSING",
  "QHKEY_VOLUME_AMBIGUOUS",
  "QHKEY_VOLUME_IDENTITY_CHANGED",
  "QHKEY_VOLUME_PERMISSION_DENIED",
  "QHKEY_MASTER_PROVISIONING_REQUIRED",
  "QHKEY_AUTHORIZATION_REQUIRED",
  "QHKEY_AUTHORIZATION_CANCELLED",
  "QHKEY_TRANSACTION_EXPIRED",
  "QHKEY_TARGET_CHANGED",
  "QHKEY_PUBLISH_FAILED",
  "QHKEY_PUBLISH_RECOVERY_REQUIRED",
]);

const PROVIDER_SET = new Set(QHKEY_PROVIDERS);
const STATE_SET = new Set(QHKEY_REPLACEMENT_STATES);
const ERROR_CODE_SET = new Set(QHKEY_ERROR_CODES);

export class QhkeyPlatformError extends Error {
  constructor(code, message) {
    if (!ERROR_CODE_SET.has(code)) {
      throw new TypeError(`Unsupported QHKEY error code: ${code}.`);
    }
    super(String(message || code));
    this.name = "QhkeyPlatformError";
    this.code = code;
  }
}

function requiredText(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\r\n\0]/u.test(normalized)) {
    throw new TypeError(`QHKEY ${fieldName} is invalid.`);
  }
  return normalized;
}

export function assertQhkeyProvider(value) {
  const provider = String(value ?? "").trim().toUpperCase();
  if (!PROVIDER_SET.has(provider)) {
    throw new TypeError(`Unsupported QHKEY provider: ${provider || "empty"}.`);
  }
  return provider;
}

export function qhkeyProviderRelativePath(providerValue) {
  return QHKEY_PROVIDER_RELATIVE_PATHS[assertQhkeyProvider(providerValue)];
}

export function assertQhkeyReplacementState(value) {
  const state = String(value ?? "").trim().toUpperCase();
  if (!STATE_SET.has(state)) {
    throw new TypeError(`Unsupported QHKEY replacement state: ${state || "empty"}.`);
  }
  return state;
}

export function assertQhkeyTransactionId(value) {
  const transactionId = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(transactionId)) {
    throw new TypeError("QHKEY transaction id is invalid.");
  }
  return transactionId;
}

export function createQhkeyVolumeIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("QHKEY volume identity is required.");
  }
  const platform = requiredText(value.platform, "volume platform");
  if (platform !== "win32" && platform !== "linux") {
    throw new TypeError("QHKEY volume platform is unsupported.");
  }
  const rawRootPath = requiredText(value.rootPath, "volume root");
  if (!path.isAbsolute(rawRootPath)) {
    throw new TypeError("QHKEY volume root must be absolute.");
  }
  const rootPath = path.resolve(rawRootPath);
  const providers = [...(value.providers ?? [])].map(assertQhkeyProvider);
  if (new Set(providers).size !== providers.length) {
    throw new TypeError("QHKEY volume providers must be unique.");
  }
  if (typeof value.readOnly !== "boolean") {
    throw new TypeError("QHKEY volume readOnly flag is invalid.");
  }
  return Object.freeze({
    platform,
    volumeId: requiredText(value.volumeId, "volume id"),
    rootPath,
    deviceId: requiredText(value.deviceId, "device id"),
    fileSystemUuid: requiredText(value.fileSystemUuid, "filesystem uuid"),
    label: String(value.label ?? "").trim(),
    readOnly: value.readOnly,
    providers: Object.freeze(providers),
  });
}

export function sameQhkeyVolumeIdentity(leftValue, rightValue) {
  const left = createQhkeyVolumeIdentity(leftValue);
  const right = createQhkeyVolumeIdentity(rightValue);
  return (
    left.platform === right.platform &&
    left.volumeId === right.volumeId &&
    left.rootPath === right.rootPath &&
    left.deviceId === right.deviceId &&
    left.fileSystemUuid === right.fileSystemUuid &&
    left.readOnly === right.readOnly
  );
}

export function publicQhkeyReplacement(value) {
  const state = assertQhkeyReplacementState(value?.state);
  const provider = assertQhkeyProvider(value?.provider);
  const publicValue = {
    state,
    transactionId: assertQhkeyTransactionId(value?.transactionId),
    provider,
    volumeId: requiredText(value?.volumeId ?? value?.volume?.volumeId, "volume id"),
    keyAlias: requiredText(value?.keyAlias, "key alias"),
    keyFingerprint: requiredText(value?.keyFingerprint, "key fingerprint"),
    expiresAt: requiredText(value?.expiresAt, "expiry"),
  };
  if (value?.errorCode) {
    const errorCode = String(value.errorCode).trim();
    if (!ERROR_CODE_SET.has(errorCode)) {
      throw new TypeError("QHKEY replacement error code is invalid.");
    }
    publicValue.errorCode = errorCode;
  }
  if (value?.message) publicValue.message = String(value.message);
  return Object.freeze(publicValue);
}
