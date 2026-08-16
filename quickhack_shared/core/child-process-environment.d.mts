import type {
  ProcessEnvironmentPolicy,
  ProcessEnvironmentSource,
} from "../platform/process-execution-contract.mjs";

export type ChildProcessEnvironmentOptions = {
  policy: ProcessEnvironmentPolicy;
  source?: ProcessEnvironmentSource;
  executableDirectories?: readonly string[];
  overrides?: Record<string, string | number | boolean | undefined>;
};

export function createChildProcessEnvironment(
  options: ChildProcessEnvironmentOptions
): NodeJS.ProcessEnv;
