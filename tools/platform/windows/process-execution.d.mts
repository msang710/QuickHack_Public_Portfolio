import type { OperatorProcessExecution } from "../contracts.mjs";
export function createWindowsOperatorProcessExecution(
  platform?: string,
  dependencies?: Readonly<{
    spawnSyncImplementation?: (
      executable: string,
      arguments: readonly string[],
      options: unknown
    ) => { status: number | null };
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  }>
): OperatorProcessExecution;
