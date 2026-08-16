export function linuxPackageDependencies(artifactValue: unknown): readonly string[];
export function createLinuxPackageLifecycle(options?: Readonly<{ runtime?: Record<string, unknown> }>): Readonly<{
  setup(input: Record<string, unknown>): Promise<unknown>;
  repair(input: Record<string, unknown>): Promise<unknown>;
  uninstall(input: Record<string, unknown>): unknown;
  purge(input: Record<string, unknown>): Promise<unknown>;
}>;
