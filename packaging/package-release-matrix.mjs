import { QUICKHACK_PACKAGE_TARGETS, packageArtifactContractForTarget } from "./package-artifact-contract.mjs";

export const QUICKHACK_RELEASE_PLATFORMS = Object.freeze(["windows", "linux"]);

export function packageReleaseVariant(platformValue, targetValue, version = "VERSION") {
  const platform = String(platformValue ?? "").trim().toLowerCase();
  if (!QUICKHACK_RELEASE_PLATFORMS.includes(platform)) throw new TypeError(`Unsupported release platform: ${platform}.`);
  const artifact = packageArtifactContractForTarget(targetValue);
  const qualifier = artifact.packageFlavor === "DEMONSTRATION" ? "Demo" : "Operational";
  const role = artifact.role === "server" ? "Server" : "Client";
  const baseName = platform === "windows"
    ? `QuickHack-${qualifier}-${role}`
    : `quickhack-${artifact.packageFlavor.toLowerCase()}-${artifact.role}`;
  return Object.freeze({
    platform,
    target: artifact.packageTarget,
    artifactKind: artifact.artifactKind,
    stagingRoot: `release/${platform}/${artifact.packageTarget}`,
    distributionRoot: `release/distribution/${platform}/${artifact.packageTarget}`,
    artifactFileName: platform === "windows"
      ? `${baseName}-Setup-${version}.exe`
      : `${baseName}-${version}-1-x86_64.pkg.tar.zst`,
    manifestFileName: `${baseName}-manifest-${version}.json`,
    checksumFileName: `${baseName}-SHA256SUMS.txt`,
    official: true,
  });
}

export const QUICKHACK_RELEASE_MATRIX = Object.freeze(
  QUICKHACK_RELEASE_PLATFORMS.flatMap((platform) =>
    QUICKHACK_PACKAGE_TARGETS.map((target) => packageReleaseVariant(platform, target))
  )
);
