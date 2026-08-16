export type WindowsSecurityRunOptions = {
  input?: string;
  inputLine?: string;
  timeoutMs?: number;
  timeoutAttempts?: number;
  maxOutputBytes?: number;
};

export const WINDOWS_SECURITY_OPERATION_TIMEOUT_MS: 60000;

export function createWindowsSecurityProcess(options?: {
  platform?: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spawnProcess?: (...args: readonly unknown[]) => unknown;
  spawnProcessSync?: (...args: readonly unknown[]) => unknown;
}): Readonly<{
  runCommand(
    executableKey: string,
    args: readonly string[],
    options?: WindowsSecurityRunOptions
  ): Promise<string>;
  runCommandSync(
    executableKey: string,
    args: readonly string[],
    options?: WindowsSecurityRunOptions
  ): string;
  runPowerShellScript(
    script: string,
    options?: WindowsSecurityRunOptions
  ): Promise<string>;
  runPowerShellScriptSync(
    script: string,
    options?: WindowsSecurityRunOptions
  ): string;
}>;

export function runWindowsSystemCommand(
  executableKey: string,
  args: readonly string[],
  options?: WindowsSecurityRunOptions
): Promise<string>;
export function runWindowsSystemCommandSync(
  executableKey: string,
  args: readonly string[],
  options?: WindowsSecurityRunOptions
): string;
export function runPowerShellScript(
  script: string,
  options?: WindowsSecurityRunOptions
): Promise<string>;
export function runPowerShellScriptSync(
  script: string,
  options?: WindowsSecurityRunOptions
): string;
