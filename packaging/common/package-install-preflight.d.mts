export function assertPackageInstallPreflight(input: Readonly<{
  artifactKind?: string;
  packageTarget?: string;
  installedPackageKinds?: readonly string[];
  installedServiceKinds?: readonly string[];
  preservedStateKinds?: readonly string[];
  legacyLayoutDetected?: boolean;
}>): Readonly<{
  requestedArtifactKind: string;
  sameKindInstalled: boolean;
  preservedStateKinds: readonly string[];
  mutationAllowed: true;
}>;
