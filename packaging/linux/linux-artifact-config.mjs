import {
  QUICKHACK_PACKAGE_TARGETS,
  packageArtifactContractForTarget,
  packageArtifactPlatformIdentity,
} from "../package-artifact-contract.mjs";

export const LINUX_PACKAGE_TARGETS = QUICKHACK_PACKAGE_TARGETS;

export function linuxArtifactConfig(target) {
  const artifact = packageArtifactContractForTarget(target);
  const identity = packageArtifactPlatformIdentity(artifact.artifactKind, "linux");
  const flavorSlug = artifact.packageFlavor === "DEMONSTRATION" ? "demonstration" : "operational";
  return Object.freeze({
    ...artifact,
    ...identity,
    flavorSlug,
    stagingRoot: `release/linux/${artifact.packageTarget}`,
    packageRoot: `release/linux/${artifact.packageTarget}/pkgroot`,
    launcherName: `quickhack-${flavorSlug}-${artifact.role}`,
    runtimeConfig: artifact.role === "server"
      ? `${identity.configRoot}/server-runtime.json`
      : "",
  });
}
