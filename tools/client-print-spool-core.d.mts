export type ClientPrintSpoolPaths = {
  clientDataDir: string;
  spoolDir: string;
  recoveryDir: string;
};

export type ClientPrintSpoolOptions = {
  clientDataDir: string;
  now?: () => Date;
};

export type ClientPrintSpoolPlatformOptions = ClientPrintSpoolOptions & {
  platform: "win32" | "linux";
  applyWindowsAcl?: (directory: string) => Promise<void>;
};

export type ClientPrintRecoveryMarker = {
  version: 1;
  status: "UNKNOWN";
  reasonCode: "ORPHANED_PRINT_SPOOL" | "PRINT_ATTEMPT_STARTED";
  requestKey: string;
  contentHash: string;
  recoveredAt: string;
};

export class ClientPrintSpoolError extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown);
}

export function getClientPrintSpoolPaths(
  options: ClientPrintSpoolOptions
): ClientPrintSpoolPaths;

export function parseClientPrintSpoolFileName(filename: string):
  | {
      requestKey: string;
      contentHash: string;
    }
  | null;

export function initializeClientPrintSpool(
  options: ClientPrintSpoolPlatformOptions
): Promise<
  ClientPrintSpoolPaths & {
    ok: true;
    recoveredCount: number;
    skippedCount: number;
    skippedNames: string[];
  }
>;

export function inspectClientPrintSpoolRecovery(
  options: ClientPrintSpoolOptions & {
    requestKey: string;
    contentHash: string;
  }
): Promise<
  | { status: "MATCH"; marker: ClientPrintRecoveryMarker }
  | { status: "CONFLICT" | "NONE"; marker: null }
>;

export function createPrivatePrintSpoolFile(
  options: ClientPrintSpoolPlatformOptions & {
    requestKey: string;
    contentHash: string;
    payload: Buffer;
  }
): Promise<string>;

export function armClientPrintSpoolAttempt(
  options: ClientPrintSpoolOptions & {
    requestKey: string;
    contentHash: string;
  }
): Promise<ClientPrintRecoveryMarker>;

export function removePrivatePrintSpoolFile(
  filename: string,
  options: ClientPrintSpoolOptions
): Promise<void>;
