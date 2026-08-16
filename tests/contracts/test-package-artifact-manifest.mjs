import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUICKHACK_PACKAGE_TARGETS,
  packageArtifactContractForTarget,
  packageArtifactPlatformIdentity,
} from "../../packaging/package-artifact-contract.mjs";
import {
  assertPackageManifest,
  canonicalPackageManifestJson,
  createPackageManifest,
  packageManifestSha256,
} from "../../packaging/common/package-manifest.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/pr10-package-targets.json", import.meta.url), "utf8"));
assert.equal(fixture.schemaVersion, 1);
assert.deepEqual(fixture.targets.map((target) => target.packageTarget), [...QUICKHACK_PACKAGE_TARGETS]);

const manifests = [];
for (const target of fixture.targets) {
  const artifact = packageArtifactContractForTarget(target.packageTarget);
  assert.equal(artifact.artifactKind, target.artifactKind);
  assert.equal(artifact.role, target.role);
  assert.equal(artifact.packageFlavor, target.flavor);
  for (const platform of ["win32", "linux"]) {
    const identity = packageArtifactPlatformIdentity(target.artifactKind, platform);
    assert.equal(
      identity.installedIdentity,
      platform === "win32" ? target.windowsIdentity : target.linuxIdentity
    );
    const manifest = createPackageManifest({
      packageTarget: target.packageTarget,
      platform,
      version: "1.0.0",
      contentInventorySha256: "0".repeat(64),
    });
    assert.deepEqual(assertPackageManifest(manifest), manifest);
    assert.match(packageManifestSha256(manifest), /^[a-f0-9]{64}$/u);
    assert.equal(canonicalPackageManifestJson(manifest), canonicalPackageManifestJson({ ...manifest }));
    manifests.push(manifest);
  }
}
assert.equal(manifests.length, 8);
assert.equal(new Set(manifests.map((manifest) => `${manifest.platform}:${manifest.installedIdentity}`)).size, 8);

assert.throws(
  () => createPackageManifest({ packageTarget: "unknown", platform: "win32", version: "1", contentInventorySha256: "0".repeat(64) }),
  (error) => error.code === "PACKAGE_ARTIFACT_INVALID"
);
assert.throws(
  () => assertPackageManifest({ ...manifests[0], runtimeRole: "CLIENT" }),
  (error) => error.code === "PACKAGE_ARTIFACT_INVALID"
);
assert.throws(
  () => assertPackageManifest({ ...manifests[0], extra: true }),
  (error) => error.code === "PACKAGE_ARTIFACT_INVALID"
);

console.log("QuickHack immutable four-artifact package manifests verified for both platforms.");
