import type { PackageFlavor } from "../quickhack_shared/core/package-flavor-contract.mjs";
export const QUICKHACK_ARTIFACT_KINDS: readonly [
  "DEMONSTRATION_SERVER",
  "DEMONSTRATION_CLIENT",
  "OPERATIONAL_SERVER",
  "OPERATIONAL_CLIENT"
];
export const QUICKHACK_PACKAGE_TARGETS: readonly [
  "demo-server",
  "demo-client",
  "operational-server",
  "operational-client"
];
export type QuickHackArtifactKind = (typeof QUICKHACK_ARTIFACT_KINDS)[number];
export type PackageArtifactContract = Readonly<{
  artifactKind: QuickHackArtifactKind;
  packageTarget: (typeof QUICKHACK_PACKAGE_TARGETS)[number];
  role: "server" | "client";
  packageFlavor: PackageFlavor;
  entrypoint: string;
  includesMockRuntime: boolean;
  includesPrivilegedCredentialOperator: boolean;
}>;
export function packageArtifactContract(value: unknown): PackageArtifactContract;
export function packageArtifactContractForTarget(value: unknown): PackageArtifactContract;
export function packageArtifactPlatformIdentity(
  value: unknown,
  platform: "win32" | "linux"
): Readonly<{
  artifactKind: QuickHackArtifactKind;
  packageTarget: (typeof QUICKHACK_PACKAGE_TARGETS)[number];
  platform: "win32" | "linux";
  installedIdentity: string;
  applicationName?: string;
  applicationDirectoryName?: string;
  applicationRoot?: string;
  mutableRootName?: string;
  configRoot?: string;
  dataRoot?: string;
  cacheRoot?: string;
  localRuntimePort?: number;
  services: Readonly<Record<string, string>>;
  users?: Readonly<Record<string, string>>;
}>;
export function assertArtifactRuntimePair(
  artifactKind: unknown,
  runtimeConfig: { packageFlavor: PackageFlavor; database: Record<string, unknown> }
): PackageArtifactContract & { serverSecrets?: unknown };
