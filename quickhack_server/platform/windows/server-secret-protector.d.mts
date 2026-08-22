import type {
  ServerSecretProtectionMetadata,
  ServerSecretProtector,
} from "../contracts.ts";

export const windowsServerSecretProtectionMetadata: ServerSecretProtectionMetadata;
export const windowsMachineServerSecretProtectionMetadata: ServerSecretProtectionMetadata;
export const WINDOWS_SERVER_SECRET_SCOPE_ENV: "QUICKHACK_WINDOWS_SECRET_SCOPE";
export const WINDOWS_SERVER_SECRET_SCOPES: readonly ["CURRENT_USER", "LOCAL_MACHINE"];
export function resolveWindowsServerSecretScope(value?: unknown): "CURRENT_USER" | "LOCAL_MACHINE";
export function createWindowsServerSecretProtector(options?: {
  platform?: string;
  scope?: "CURRENT_USER" | "LOCAL_MACHINE";
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
