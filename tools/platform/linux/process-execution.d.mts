import type { OperatorProcessExecution } from "../contracts.mjs";
export function createLinuxOperatorProcessExecution(
  platform?: string,
  dependencies?: Readonly<{
    killImplementation?: (pid: number) => void;
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  }>
): OperatorProcessExecution;
