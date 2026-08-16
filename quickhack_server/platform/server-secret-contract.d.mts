export const SERVER_SECRET_KINDS: readonly [
  "OTP_MASTER_KEY",
  "BACKUP_MASTER_KEY",
  "POSTGRESQL_CREDENTIAL",
  "MOBILE_SERIAL_HMAC",
  "QHKEY_MASTER_KEY",
];

export type ServerSecretKind = (typeof SERVER_SECRET_KINDS)[number];

export const SERVER_SECRET_LIFECYCLES: readonly [
  "OPAQUE_PAYLOAD",
  "ACTIVATION_CREDENTIAL"
];
export type ServerSecretLifecycle = (typeof SERVER_SECRET_LIFECYCLES)[number];

export type ServerSecretProtectionMetadata = Readonly<{
  protection: string;
  identityScope: string;
  portable: boolean;
  formatVersion: number;
  lifecycle: ServerSecretLifecycle;
}>;

export function assertServerSecretKind(value: unknown): ServerSecretKind;
export function assertServerSecretBuffer(
  value: unknown,
  fieldName: string
): Buffer;
export function createServerSecretProtectionMetadata(input: {
  protection: string;
  identityScope: string;
  portable: boolean;
  formatVersion: number;
  lifecycle: ServerSecretLifecycle;
}): ServerSecretProtectionMetadata;
