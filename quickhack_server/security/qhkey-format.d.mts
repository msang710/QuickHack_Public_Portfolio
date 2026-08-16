export type QhkeyEnvironment = "mock" | "live" | "development" | "production";
export type QhkeyCredentialKind =
  | "COUPANG_OPEN_API"
  | "LOGEN_OPEN_API";
export type QhkeyFormatErrorCode =
  | "QHKEY_FORMAT_INVALID"
  | "QHKEY_CREDENTIAL_KIND_UNSUPPORTED"
  | "QHKEY_DECRYPT_FAILED";

export type CoupangOpenApiCredential = {
  vendorId: string;
  accessKey: string;
  secretKey: string;
};

export type LogenOpenApiCredential = {
  userId: string;
  customerCode: string;
  secretKey: string;
};

export type QhkeyMetadata = {
  formatVersion: 2;
  credentialKind: QhkeyCredentialKind;
  environment: QhkeyEnvironment;
  keyAlias: string;
  keyFingerprint: string;
  issuedAt: string;
  expiresAt: string;
};

type CreateEncryptedQhkeyCommonInput = {
  masterKey: Buffer;
  environment: string;
  keyAlias: string;
  issuedAt: string;
  expiresAt: string;
};

export type CreateEncryptedQhkeyInput = CreateEncryptedQhkeyCommonInput &
  (
    | {
        credentialKind: "COUPANG_OPEN_API";
        credential: CoupangOpenApiCredential;
      }
    | {
        credentialKind: "LOGEN_OPEN_API";
        credential: LogenOpenApiCredential;
      }
  );

export type CreateEncryptedQhkeyResult = {
  buffer: Buffer;
  metadata: QhkeyMetadata;
};

export type DecryptedQhkey =
  | {
      metadata: QhkeyMetadata & { credentialKind: "COUPANG_OPEN_API" };
      credential: CoupangOpenApiCredential;
    }
  | {
      metadata: QhkeyMetadata & { credentialKind: "LOGEN_OPEN_API" };
      credential: LogenOpenApiCredential;
    };

export class QhkeyFormatError extends Error {
  readonly code: QhkeyFormatErrorCode;
  constructor(code: QhkeyFormatErrorCode);
}

export const QHKEY_ENVIRONMENTS: string[];
export const QHKEY_CREDENTIAL_KINDS: readonly QhkeyCredentialKind[];

export function normalizeQhkeyEnvironment(value: string): QhkeyEnvironment;
export function normalizeQhkeyCredentialKind(value: string): QhkeyCredentialKind;
export function parseQhkeyIsoDateTimeMs(value: string, label?: string): number;
export function assertValidQhkeyDateRange(issuedAt: string, expiresAt: string): void;
export function qhkeyFingerprint(input:
  | { credentialKind: "COUPANG_OPEN_API"; credential: CoupangOpenApiCredential }
  | { credentialKind: "LOGEN_OPEN_API"; credential: LogenOpenApiCredential }
): string;
export function normalizeQhkeyMasterKey(masterKey: Buffer): Buffer;
export function validateQhkeyMetadata(metadata: QhkeyMetadata): void;
export function createEncryptedQhkey(input: CreateEncryptedQhkeyInput): CreateEncryptedQhkeyResult;
export function readQhkeyMetadata(filePath: string): QhkeyMetadata;
export function readQhkeyMetadataAsync(filePath: string): Promise<QhkeyMetadata>;
export function readQhkeyMetadataBuffer(buffer: Buffer): QhkeyMetadata;
export function decryptQhkey(filePath: string, masterKey: Buffer): DecryptedQhkey;
export function decryptQhkeyAsync(filePath: string, masterKey: Buffer): Promise<DecryptedQhkey>;
export function decryptQhkeyBuffer(buffer: Buffer, masterKey: Buffer): DecryptedQhkey;
export function writeQhkeyFile(filePath: string, payload: Buffer, force?: boolean): void;
export function qhkeyDaysUntilExpiry(expiresAt: string, now?: Date): number | null;
