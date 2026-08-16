import assert from "node:assert/strict";
import { assertPackageInstallPreflight } from "../../packaging/common/package-install-preflight.mjs";

assert.equal(
  assertPackageInstallPreflight({
    artifactKind: "DEMONSTRATION_SERVER",
    preservedStateKinds: ["OPERATIONAL_SERVER"],
  }).mutationAllowed,
  true,
  "Preserved opposite-flavor state alone must not block installation."
);
assert.throws(
  () => assertPackageInstallPreflight({
    artifactKind: "DEMONSTRATION_SERVER",
    installedPackageKinds: ["OPERATIONAL_SERVER"],
  }),
  (error) => error.code === "SERVER_FLAVOR_CONFLICT" && error.details.conflictingArtifactKind === "OPERATIONAL_SERVER"
);
assert.throws(
  () => assertPackageInstallPreflight({
    artifactKind: "OPERATIONAL_SERVER",
    installedServiceKinds: ["DEMONSTRATION_SERVER"],
  }),
  (error) => error.code === "SERVER_FLAVOR_CONFLICT"
);
assert.throws(
  () => assertPackageInstallPreflight({ artifactKind: "OPERATIONAL_SERVER", legacyLayoutDetected: true }),
  (error) => error.code === "LEGACY_LAYOUT_DETECTED"
);
assert.equal(
  assertPackageInstallPreflight({
    artifactKind: "OPERATIONAL_CLIENT",
    installedPackageKinds: ["DEMONSTRATION_CLIENT"],
  }).mutationAllowed,
  true
);

console.log("QuickHack package install preflight conflicts and preserved-state behavior verified.");
