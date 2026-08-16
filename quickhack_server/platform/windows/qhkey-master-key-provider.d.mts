import type { QhkeyMasterKeyProvider, QhkeyMasterKeyStatus } from "../contracts.ts";

export type WindowsQhkeyMasterKeyProvider = QhkeyMasterKeyProvider & Readonly<{
  masterFilePath(dataDir: string): string;
  protection(input: { dataDir?: string; filePath?: string }): Promise<"RAW" | "DPAPI">;
  protectionSync(input: { dataDir?: string; filePath?: string }): "RAW" | "DPAPI";
  write(input: { dataDir?: string; filePath?: string; force?: boolean; protection?: string }): void;
  ensure(input: { dataDir: string; force?: boolean; protection?: string }): Promise<QhkeyMasterKeyStatus>;
  importProtectedFile(input: { dataDir?: string; filePath?: string; sourceFile: string; force?: boolean }): string;
}>;

export function createWindowsQhkeyMasterKeyProvider(options?: Record<string, unknown>): WindowsQhkeyMasterKeyProvider;
