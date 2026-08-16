export type RestoreRequestRuntimeConfig = Readonly<{ dataDirectory: string }>;
export type RestoreRequestPreparation = Readonly<{
  kind: "QUICKHACK_RESTORE_REQUEST";
  operationId: string;
  creatorPid: number;
  creatorToken: string;
  backupFile: string;
  directory: string;
  publishedPath: string;
}>;
export type RestoreRequestClaim = Readonly<{
  kind: "QUICKHACK_RESTORE_REQUEST";
  schemaVersion: 1 | 2;
  operationId: string;
  backupFile: string;
  ownerPid: number;
  ownerToken: string;
  directory: string;
  claimedPath: string;
}>;
export type RestoreRequestHandoff = Readonly<{
  prepare(backupFile: string, runtimeConfig: RestoreRequestRuntimeConfig): RestoreRequestPreparation;
  claim(runtimeConfig: RestoreRequestRuntimeConfig): RestoreRequestClaim;
  finalize(claim: RestoreRequestClaim, terminalState?: "SUCCEEDED" | "FAILED"): boolean;
  cleanupUnclaimed(preparation: RestoreRequestPreparation): boolean;
}>;
export function createRestoreRequestHandoff(options?: Record<string, unknown>): RestoreRequestHandoff;
export const defaultRestoreRequestHandoff: RestoreRequestHandoff;
