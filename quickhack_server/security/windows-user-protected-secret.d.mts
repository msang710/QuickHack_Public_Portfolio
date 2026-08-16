export function protectForCurrentWindowsUser(secret: Buffer): Promise<Buffer>;
export function unprotectForCurrentWindowsUser(payload: Buffer): Promise<Buffer>;
export function unprotectForCurrentWindowsUserSync(payload: Buffer): Buffer;
export function ensureCurrentWindowsUserSecretDirectory(
  directoryPath: string
): Promise<void>;
export function secureWindowsDirectoryAcl(
  directoryPath: string,
  options?: { includeNetworkService?: boolean }
): Promise<void>;
