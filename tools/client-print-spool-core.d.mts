export type ClientPrintSpoolPaths = {
  clientDataDir: string;
  spoolDir: string;
  recoveryDir: string;
  recoveryIndexDir: string;
  jobsDir: string;
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

export type ResolvedClientPrintRecoveryMarker = {
  version: 2;
  status: "RESOLVED";
  sourceStatus: "UNKNOWN" | "CONFLICT";
  reasonCode: string;
  requestKey: string;
  contentHash: string;
  recoveredAt: string;
  resolution: "CONFIRMED" | "PRINTED" | "NOT_PRINTED";
  acknowledgedAt: string;
};

export type ClientPrintArtifactLifecycleSummary = {
  dryRun: boolean;
  cutoffExclusive: Date;
  maxBatchSize: number;
  attemptedCount: number;
  changedCount: number;
  skippedCount: number;
  backlogCount: number;
  oldestEligibleAgeMs: number | null;
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
    lifecycle: ClientPrintArtifactLifecycleSummary | null;
    lifecycleWarning: string | null;
  }
>;

export function acknowledgeClientPrintSpoolRecovery(
  options: ClientPrintSpoolOptions & {
    requestKey: string;
    contentHash: string;
    resolution: "CONFIRMED" | "PRINTED" | "NOT_PRINTED";
    acknowledgedAt?: string | Date;
  }
): Promise<ResolvedClientPrintRecoveryMarker>;

export function pruneAcknowledgedClientPrintArtifacts(
  options: Omit<ClientPrintSpoolOptions, "now"> & {
    now?: string | Date;
    dryRun?: boolean;
    maxBatchSize?: number;
  }
): Promise<ClientPrintArtifactLifecycleSummary>;

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
