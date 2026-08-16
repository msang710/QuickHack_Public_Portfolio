export const generateQhkeyMasterKey: () => Buffer;
export const readQhkeyMasterKeyFile: (filePath: string) => Buffer;
export const readQhkeyMasterKeyFileAsync: (filePath: string) => Promise<Buffer>;
export function writeQhkeyMasterKeyFile(
  filePath: string,
  force?: boolean,
  options?: { protection?: string }
): void;
export function getQhkeyMasterKeyFileProtection(filePath: string): string;
export function getQhkeyMasterKeyFileProtectionAsync(filePath: string): Promise<string>;
