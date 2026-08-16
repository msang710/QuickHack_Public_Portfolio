import assert from "node:assert/strict";
import { assertPackageContentPolicy, findPackageContentViolations } from "../../packaging/common/package-inventory.mjs";
import { createPackageManifest } from "../../packaging/common/package-manifest.mjs";
import { QUICKHACK_PACKAGE_TARGETS, packageArtifactContractForTarget } from "../../packaging/package-artifact-contract.mjs";

const platforms = ["win32", "linux"];
const variants = [];
for (const platform of platforms) {
  for (const target of QUICKHACK_PACKAGE_TARGETS) {
    const artifact = packageArtifactContractForTarget(target);
    const entry = artifact.entrypoint;
    const entries = [
      { path: entry },
      { path: "quickhack-package.json" },
      { path: `platform/${platform}/runtime-marker` },
    ];
    assert.doesNotThrow(() => assertPackageContentPolicy(artifact.artifactKind, entries));
    variants.push(createPackageManifest({
      artifactKind: artifact.artifactKind,
      platform,
      version: "1.0.0-boundary",
      contentInventorySha256: `${platform === "win32" ? "a" : "b"}`.repeat(64),
    }));
  }
}

assert.equal(variants.length, 8);
assert.equal(new Set(variants.map((item) => `${item.platform}:${item.artifactKind}`)).size, 8);
assert.equal(new Set(variants.map((item) => item.artifactKind)).size, 4);

assert.deepEqual(
  findPackageContentViolations("OPERATIONAL_SERVER", [{ path: "mock_server/coupang.mjs" }]).map((item) => item.path),
  ["mock_server/coupang.mjs"]
);
assert.deepEqual(
  findPackageContentViolations("DEMONSTRATION_SERVER", [{ path: "tools/server-console-operational.mjs" }]).map((item) => item.path),
  ["tools/server-console-operational.mjs"]
);
assert.deepEqual(
  findPackageContentViolations("OPERATIONAL_CLIENT", [{ path: "quickhack_server/platform/linux/index.ts" }]).map((item) => item.path),
  ["quickhack_server/platform/linux/index.ts"]
);

console.log("Eight OS package variants map to exactly four logical artifacts with forbidden-content ratchets.");
