import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageReleaseVariant } from "../../packaging/package-release-matrix.mjs";
import {
  canonicalPackageManifestJson,
  createPackageManifest,
} from "../../packaging/common/package-manifest.mjs";
import { verifyPackageReleaseArtifact } from "../../tools/verify-package-release-artifact.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-release-artifact-"));
try {
  const platform = "windows";
  const target = "demo-server";
  const version = "1.2.3";
  const release = packageReleaseVariant(platform, target, version);
  const artifactBytes = Buffer.from("synthetic installer bytes", "utf8");
  const manifestBytes = Buffer.from(
    canonicalPackageManifestJson(
      createPackageManifest({
        packageTarget: target,
        platform: "win32",
        version,
        contentInventorySha256: "0".repeat(64),
      })
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(temporaryRoot, release.artifactFileName), artifactBytes);
  fs.writeFileSync(path.join(temporaryRoot, release.manifestFileName), manifestBytes);
  fs.writeFileSync(
    path.join(temporaryRoot, release.checksumFileName),
    `${digest(artifactBytes)}  ${release.artifactFileName}\n${digest(manifestBytes)}  ${release.manifestFileName}\n`,
    "ascii"
  );

  const verified = verifyPackageReleaseArtifact({
    artifactDirectory: temporaryRoot,
    platform,
    target,
    releaseVersion: `v${version}`,
  });
  assert.equal(verified.artifactKind, "DEMONSTRATION_SERVER");
  assert.equal(verified.files.length, 3);

  fs.appendFileSync(path.join(temporaryRoot, release.artifactFileName), "tampered", "utf8");
  assert.throws(
    () => verifyPackageReleaseArtifact({ artifactDirectory: temporaryRoot, platform, target, releaseVersion: version }),
    (error) => error.code === "PACKAGE_ARTIFACT_DIGEST_MISMATCH"
  );
  fs.writeFileSync(path.join(temporaryRoot, release.artifactFileName), artifactBytes);

  fs.writeFileSync(path.join(temporaryRoot, "unexpected.txt"), "unexpected", "utf8");
  assert.throws(
    () => verifyPackageReleaseArtifact({ artifactDirectory: temporaryRoot, platform, target, releaseVersion: version }),
    (error) => error.code === "RELEASE_FILE_SET_MISMATCH"
  );
  fs.rmSync(path.join(temporaryRoot, "unexpected.txt"));

  assert.throws(
    () => verifyPackageReleaseArtifact({ artifactDirectory: temporaryRoot, platform, target, releaseVersion: "9.9.9" }),
    (error) => ["RELEASE_FILE_SET_MISMATCH", "PACKAGE_MANIFEST_IDENTITY_MISMATCH"].includes(error.code)
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("Package release artifact manifest and SHA-256 verification contract passed.");
