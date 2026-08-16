import type { QuickHackArtifactKind } from "../package-artifact-contract.mjs";

export const QUICKHACK_PACKAGE_MANIFEST_SCHEMA_VERSION: 1;
export const QUICKHACK_PACKAGE_MANIFEST_FILENAME: "quickhack-package.json";
export type QuickHackPackageManifest = Readonly<{
  schemaVersion: 1;
  artifactKind: QuickHackArtifactKind;
  packageTarget: "demo-server" | "demo-client" | "operational-server" | "operational-client";
  deploymentFlavor: "DEMONSTRATION" | "OPERATIONAL";
  runtimeRole: "SERVER" | "CLIENT";
  platform: "win32" | "linux";
  architecture: "x64" | "x86_64";
  version: string;
  entrypoint: string;
  contentInventorySha256: string;
  installedIdentity: string;
}>;
export function createPackageManifest(input: Readonly<{
  artifactKind?: QuickHackArtifactKind;
  packageTarget?: string;
  platform: "win32" | "linux";
  architecture?: "x64" | "x86_64";
  version: string;
  entrypoint?: string;
  contentInventorySha256: string;
}>): QuickHackPackageManifest;
export function assertPackageManifest(value: unknown): QuickHackPackageManifest;
export function canonicalPackageManifestJson(manifest: unknown): string;
export function packageManifestSha256(manifest: unknown): string;
