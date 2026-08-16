import {
  QUICKHACK_PACKAGE_TARGETS,
  packageArtifactContractForTarget,
  packageArtifactPlatformIdentity,
} from "../package-artifact-contract.mjs";

export const WINDOWS_PACKAGE_TARGETS = QUICKHACK_PACKAGE_TARGETS;

export function windowsArtifactConfig(target) {
  const artifact = packageArtifactContractForTarget(target);
  const identity = packageArtifactPlatformIdentity(artifact.artifactKind, "win32");
  const qualifier = artifact.packageFlavor === "DEMONSTRATION" ? "Demo" : "Operational";
  const role = artifact.role === "server" ? "Server" : "Client";
  return Object.freeze({
    ...artifact,
    ...identity,
    launcherFileName: `QuickHack-${qualifier}-${role}.exe`,
    installerFilePrefix: `QuickHack-${qualifier}-${role}`,
    stagingRoot: `release/windows/${artifact.packageTarget}`,
    distributionRoot: `release/distribution/windows/${artifact.packageTarget}`,
    installerSource: artifact.role === "server"
      ? "packaging/quickhack.iss"
      : "packaging/quickhack-demo-client.iss",
  });
}
