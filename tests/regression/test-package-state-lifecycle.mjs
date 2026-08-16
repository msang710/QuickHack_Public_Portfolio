import assert from "node:assert/strict";
import {
  assertOwnedPurgeTargets,
  createPackageLifecyclePlan,
  createPackageStateRecord,
} from "../../packaging/common/package-state-lifecycle.mjs";

const uninstall = createPackageLifecyclePlan({
  operation: "UNINSTALL",
  artifactKind: "OPERATIONAL_SERVER",
  binaryPaths: ["/usr/lib/quickhack/operational-server"],
  serviceIdentities: ["quickhack-operational-console.service"],
  mutablePaths: ["/var/lib/quickhack/operational-server/data"],
});
assert.equal(uninstall.preserveMutableState, true);
assert.deepEqual(uninstall.removeMutablePaths, []);

assert.throws(
  () => createPackageLifecyclePlan({
    operation: "PURGE",
    artifactKind: "OPERATIONAL_SERVER",
    mutablePaths: ["/var/lib/quickhack/operational-server/data"],
  }),
  (error) => error.code === "PURGE_CONFIRMATION_REQUIRED"
);
const purge = createPackageLifecyclePlan({
  operation: "PURGE",
  artifactKind: "OPERATIONAL_SERVER",
  mutablePaths: ["/var/lib/quickhack/operational-server/data"],
  backupVerified: false,
  confirmation: {
    artifactKind: "OPERATIONAL_SERVER",
    irreversible: true,
    noRecoveryAcknowledged: true,
  },
});
assert.equal(purge.preserveMutableState, false);
assert.equal(purge.removeMutablePaths.length, 1);

assert.deepEqual(
  assertOwnedPurgeTargets({
    platform: "linux",
    ownedRoot: "/var/lib/quickhack/operational-server",
    targets: ["/var/lib/quickhack/operational-server/data"],
  }),
  ["/var/lib/quickhack/operational-server/data"]
);
assert.throws(
  () => assertOwnedPurgeTargets({
    platform: "linux",
    ownedRoot: "/var/lib/quickhack/operational-server",
    targets: ["/var/lib/quickhack/demonstration-server"],
  }),
  (error) => error.code === "PACKAGE_ARTIFACT_INVALID"
);
const state = createPackageStateRecord({
  artifactKind: "OPERATIONAL_SERVER",
  createdVersion: "1.0.0",
  lastSuccessfulVersion: "1.0.1",
  ownedRelativeRoots: ["data", "config", "data"],
  lastVerifiedBackup: { verified: true, verifiedAt: "2026-08-16T00:00:00Z", checksum: "a".repeat(64) },
});
assert.deepEqual(state.ownedRelativeRoots, ["config", "data"]);
assert.equal("password" in state, false);

console.log("QuickHack package preserve, purge confirmation, and containment lifecycle verified.");
