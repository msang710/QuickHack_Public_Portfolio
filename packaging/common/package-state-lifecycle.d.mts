export const QUICKHACK_PACKAGE_OPERATIONS: readonly ["INSTALL", "UPGRADE", "REPAIR", "UNINSTALL", "PURGE"];
export function assertOwnedPurgeTargets(input: Readonly<{
  platform: "win32" | "linux";
  ownedRoot: string;
  targets: readonly string[];
}>): readonly string[];
export function createPackageStateRecord(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
export function createPackageLifecyclePlan(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
