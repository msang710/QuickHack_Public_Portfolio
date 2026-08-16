import type {
  ProcessEnvironmentPolicy,
  ProcessEnvironmentSource,
} from "../process-execution-contract.mjs";

export type LinuxSystemExecutableKey =
  | "adb"
  | "env"
  | "lp"
  | "lpstat"
  | "systemdCreds";

export function resolveLinuxSystemExecutable(
  key: LinuxSystemExecutableKey
): string;
export function createLinuxChildProcessPolicy(
  source?: ProcessEnvironmentSource
): ProcessEnvironmentPolicy;
