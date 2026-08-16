export const PROCESS_ENVIRONMENT_POLICY_VERSION: 1;

export type ProcessEnvironmentSource =
  | NodeJS.ProcessEnv
  | Record<string, string | undefined>;

export type ProcessEnvironmentPolicy = Readonly<{
  version: 1;
  inheritedNames: readonly string[];
  pathName: "PATH" | "Path";
  pathDelimiter: ":" | ";";
  basePathEntries: readonly string[];
  requiredValues: Readonly<Record<string, string>>;
  caseInsensitiveNames?: boolean;
}>;

export type CommandPlan = Readonly<{
  executable: string;
  arguments: readonly string[];
}>;

export function assertProcessEnvironmentPolicy(
  policy: unknown
): ProcessEnvironmentPolicy;
export function createCommandPlan(input: {
  executable: string;
  arguments?: readonly unknown[];
}): CommandPlan;
