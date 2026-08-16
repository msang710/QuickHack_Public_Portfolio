import type {
  ProcessEnvironmentPolicy,
  ProcessEnvironmentSource,
} from "../process-execution-contract.mjs";

export type WindowsSystemExecutableKey =
  | "commandShell"
  | "explorer"
  | "icacls"
  | "netstat"
  | "powerShell"
  | "taskkill"
  | "w32tm"
  | "whoami";

export type WindowsSystemPaths = Readonly<{
  systemRoot: string;
  system32: string;
  wbem: string;
  powerShellDirectory: string;
  powerShellModules: string;
  commandShell: string;
  powerShell: string;
  explorer: string;
}>;

export function windowsSystemPaths(
  source?: ProcessEnvironmentSource
): WindowsSystemPaths;
export function resolveWindowsSystemExecutable(
  key: WindowsSystemExecutableKey,
  source?: ProcessEnvironmentSource
): string;
export function createWindowsChildProcessPolicy(
  source?: ProcessEnvironmentSource
): ProcessEnvironmentPolicy;
