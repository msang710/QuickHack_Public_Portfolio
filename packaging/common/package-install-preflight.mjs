import { packageArtifactContract } from "../package-artifact-contract.mjs";

function failure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  return error;
}

function uniqueKinds(values) {
  return [...new Set((values ?? []).map((value) => packageArtifactContract(value).artifactKind))];
}

function oppositeServerKind(artifact) {
  if (artifact.role !== "server") return "";
  return artifact.packageFlavor === "DEMONSTRATION"
    ? "OPERATIONAL_SERVER"
    : "DEMONSTRATION_SERVER";
}

export function assertPackageInstallPreflight(input) {
  const requested = packageArtifactContract(input?.artifactKind ?? input?.packageTarget);
  const installedPackageKinds = uniqueKinds(input?.installedPackageKinds);
  const installedServiceKinds = uniqueKinds(input?.installedServiceKinds);
  const oppositeKind = oppositeServerKind(requested);

  if (input?.legacyLayoutDetected === true) {
    throw failure(
      "LEGACY_LAYOUT_DETECTED",
      "A legacy shared QuickHack installation layout requires explicit recovery.",
      { requestedArtifactKind: requested.artifactKind }
    );
  }

  if (
    oppositeKind &&
    (installedPackageKinds.includes(oppositeKind) || installedServiceKinds.includes(oppositeKind))
  ) {
    throw failure(
      "SERVER_FLAVOR_CONFLICT",
      "The opposite QuickHack server flavor is installed or registered.",
      { requestedArtifactKind: requested.artifactKind, conflictingArtifactKind: oppositeKind }
    );
  }

  const sameKindInstalled =
    installedPackageKinds.includes(requested.artifactKind) ||
    installedServiceKinds.includes(requested.artifactKind);
  return Object.freeze({
    requestedArtifactKind: requested.artifactKind,
    sameKindInstalled,
    preservedStateKinds: Object.freeze(uniqueKinds(input?.preservedStateKinds)),
    mutationAllowed: true,
  });
}
