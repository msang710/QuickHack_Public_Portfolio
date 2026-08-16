export type PreparedRestoreRequest = Readonly<{
  kind: "QUICKHACK_RESTORE_REQUEST";
  operationId: string;
  creatorPid: number;
  creatorToken: string;
  backupFile: string;
  directory: string;
  publishedPath: string;
}>;
export function prepareOperatorOneShotRequest(operation: string, input: Record<string, unknown>, runtimeConfig: Record<string, unknown>): PreparedRestoreRequest | undefined;
export function cleanupOperatorOneShotRequest(preparedRequest: PreparedRestoreRequest | undefined): boolean;
export function createDirectOperatorOneShot(options: Record<string, unknown>): Readonly<{ execute(operation: string, input: Record<string, unknown>): Promise<Readonly<{ operation: string; state: "COMPLETED" }>> }>;
