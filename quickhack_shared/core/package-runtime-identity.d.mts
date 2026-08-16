export const QUICKHACK_RUNTIME_CONTRACT_VERSION: 1;
export const QUICKHACK_PACKAGE_MANIFEST_FILENAME: "quickhack-package.json";
export type QuickHackArtifactKind =
  | "DEMONSTRATION_SERVER"
  | "DEMONSTRATION_CLIENT"
  | "OPERATIONAL_SERVER"
  | "OPERATIONAL_CLIENT";
export type PackageRuntimeIdentity = Readonly<{
  runtimeContractVersion: 1;
  artifactKind: QuickHackArtifactKind;
  deploymentFlavor: "DEMONSTRATION" | "OPERATIONAL";
  runtimeRole: "SERVER" | "CLIENT";
  packageTarget: "demo-server" | "demo-client" | "operational-server" | "operational-client";
  platform: "win32" | "linux";
  architecture: "x64" | "x86_64";
  version: string;
  entrypoint: string;
  installedIdentity: string;
  manifestPath: string;
  localRuntimePort?: 3001 | 3002;
  mutableRootName?: "demonstration-client" | "operational-client";
}>;
export function packageRuntimeIdentityContract(value: unknown): Readonly<{
  artifactKind: QuickHackArtifactKind;
  deploymentFlavor: "DEMONSTRATION" | "OPERATIONAL";
  runtimeRole: "SERVER" | "CLIENT";
  packageTarget: string;
  expectedPeerArtifactKind: QuickHackArtifactKind;
  localRuntimePort?: 3001 | 3002;
  mutableRootName?: "demonstration-client" | "operational-client";
}>;
export function packageManifestArgument(argv?: readonly string[]): string;
export function assertPackageRuntimeIdentity(
  value: unknown,
  expected?: Readonly<{
    artifactKind?: QuickHackArtifactKind;
    runtimeRole?: "SERVER" | "CLIENT";
    deploymentFlavor?: "DEMONSTRATION" | "OPERATIONAL";
    manifestPath?: string;
  }>
): PackageRuntimeIdentity;
export function readPackageRuntimeIdentitySync(input?: Readonly<{
  manifestPath?: string;
  artifactKind?: QuickHackArtifactKind;
  runtimeRole?: "SERVER" | "CLIENT";
  deploymentFlavor?: "DEMONSTRATION" | "OPERATIONAL";
  required?: boolean;
}>): PackageRuntimeIdentity | null;
export function activatePackageRuntimeIdentity(input?: Readonly<{
  argv?: readonly string[];
  manifestPath?: string;
  artifactKind?: QuickHackArtifactKind;
  runtimeRole?: "SERVER" | "CLIENT";
  deploymentFlavor?: "DEMONSTRATION" | "OPERATIONAL";
  required?: boolean;
}>): PackageRuntimeIdentity | null;
export function assertClientServerPackagePair(
  clientIdentity: Pick<PackageRuntimeIdentity, "artifactKind">,
  serverRuntime: unknown
): Readonly<{
  clientArtifactKind: QuickHackArtifactKind;
  serverArtifactKind: QuickHackArtifactKind;
  deploymentFlavor: "DEMONSTRATION" | "OPERATIONAL";
}>;
