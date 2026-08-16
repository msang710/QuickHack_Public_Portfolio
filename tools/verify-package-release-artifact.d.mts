export interface VerifiedPackageReleaseArtifact {
  platform: "windows" | "linux";
  target: "demo-server" | "demo-client" | "operational-server" | "operational-client";
  releaseVersion: string;
  artifactKind: string;
  files: readonly string[];
}

export function verifyPackageReleaseArtifact(options: {
  artifactDirectory: string;
  platform: string;
  target: string;
  releaseVersion: string;
}): Readonly<VerifiedPackageReleaseArtifact>;
