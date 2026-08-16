export type QhkeyProvider = "COUPANG" | "LOGEN";
export type QhkeyVolumeIdentity = Readonly<{
  platform: "win32" | "linux";
  volumeId: string;
  rootPath: string;
  deviceId: string;
  fileSystemUuid: string;
  label: string;
  readOnly: boolean;
  providers: readonly QhkeyProvider[];
}>;
export type QhkeyReplacementState =
  | "PREPARED"
  | "AUTHORIZATION_REQUIRED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "CANCELLED"
  | "FAILED"
  | "EXPIRED"
  | "RECOVERY_REQUIRED";
export type QhkeyErrorCode =
  | "QHKEY_VOLUME_MISSING"
  | "QHKEY_VOLUME_AMBIGUOUS"
  | "QHKEY_VOLUME_IDENTITY_CHANGED"
  | "QHKEY_VOLUME_PERMISSION_DENIED"
  | "QHKEY_MASTER_PROVISIONING_REQUIRED"
  | "QHKEY_AUTHORIZATION_REQUIRED"
  | "QHKEY_AUTHORIZATION_CANCELLED"
  | "QHKEY_TRANSACTION_EXPIRED"
  | "QHKEY_TARGET_CHANGED"
  | "QHKEY_PUBLISH_FAILED"
  | "QHKEY_PUBLISH_RECOVERY_REQUIRED";

export const QHKEY_PROVIDERS: readonly QhkeyProvider[];
export const QHKEY_PROVIDER_RELATIVE_PATHS: Readonly<Record<QhkeyProvider, string>>;
export const QHKEY_REPLACEMENT_STATES: readonly QhkeyReplacementState[];
export const QHKEY_ERROR_CODES: readonly QhkeyErrorCode[];

export class QhkeyPlatformError extends Error {
  readonly code: QhkeyErrorCode;
  constructor(code: QhkeyErrorCode, message?: string);
}

export function assertQhkeyProvider(value: unknown): QhkeyProvider;
export function qhkeyProviderRelativePath(value: unknown): string;
export function assertQhkeyReplacementState(value: unknown): QhkeyReplacementState;
export function assertQhkeyTransactionId(value: unknown): string;
export function createQhkeyVolumeIdentity(value: unknown): QhkeyVolumeIdentity;
export function sameQhkeyVolumeIdentity(left: unknown, right: unknown): boolean;
export function publicQhkeyReplacement(value: unknown): Readonly<{
  state: QhkeyReplacementState;
  transactionId: string;
  provider: QhkeyProvider;
  volumeId: string;
  keyAlias: string;
  keyFingerprint: string;
  expiresAt: string;
  errorCode?: QhkeyErrorCode;
  message?: string;
}>;
