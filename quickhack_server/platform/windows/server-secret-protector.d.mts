import type {
  ServerSecretProtectionMetadata,
  ServerSecretProtector,
} from "../contracts.ts";

export const windowsServerSecretProtectionMetadata: ServerSecretProtectionMetadata;
export function createWindowsServerSecretProtector(options?: {
  platform?: string;
  runCommand?: (
    executableKey: string,
    args: readonly string[],
    options?: Record<string, unknown>
  ) => Promise<string>;
  runScript?: (script: string, options?: Record<string, unknown>) => Promise<string>;
  runScriptSync?: (script: string, options?: Record<string, unknown>) => string;
}): Readonly<{
  protector: ServerSecretProtector;
  protectBytes(secret: Buffer): Promise<Buffer>;
  unprotectBytes(payload: Buffer): Promise<Buffer>;
  unprotectBytesSync(payload: Buffer): Buffer;
  secureDirectoryAcl(
    directoryPath: string,
    options?: { includeNetworkService?: boolean }
  ): Promise<void>;
  ensureDirectory(directoryPath: string): Promise<void>;
}>;
export const windowsServerSecretProtector: ServerSecretProtector;
export function protectForCurrentWindowsUser(secret: Buffer): Promise<Buffer>;
export function unprotectForCurrentWindowsUser(payload: Buffer): Promise<Buffer>;
export function unprotectForCurrentWindowsUserSync(payload: Buffer): Buffer;
export function secureWindowsDirectoryAcl(
  directoryPath: string,
  options?: { includeNetworkService?: boolean }
): Promise<void>;
export function ensureCurrentWindowsUserSecretDirectory(
  directoryPath: string
): Promise<void>;
