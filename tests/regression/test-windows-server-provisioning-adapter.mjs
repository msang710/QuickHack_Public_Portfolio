import assert from "node:assert/strict";
import { windowsServerProvisioningArtifactConfig } from "../../tools/platform/windows/server-provisioning-artifact-config.mjs";
import { planExistingBootstrapLeader } from "../../tools/platform/windows/server-provisioning-leader-policy.mjs";

const demonstration = windowsServerProvisioningArtifactConfig("DEMONSTRATION_SERVER");
const operational = windowsServerProvisioningArtifactConfig("operational-server");

assert.deepEqual(
  [demonstration.artifactKind, demonstration.packageTarget, demonstration.expectedFlavor, demonstration.mutableRootName],
  ["DEMONSTRATION_SERVER", "demo-server", "DEMONSTRATION", "demonstration-server"]
);
assert.deepEqual(demonstration.services, {
  postgresql: "QuickHackDemoPostgreSQL",
  console: "QuickHackDemoServerConsole",
});
assert.equal(demonstration.opposite.identityName, "QuickHack.Operational.Server");
assert.deepEqual(
  Object.keys(demonstration.runtimeDatabase).filter((key) => /Mock/u.test(key)).sort(),
  ["coupangMockName", "coupangMockUser", "logenMockName", "logenMockUser"]
);

assert.deepEqual(
  [operational.artifactKind, operational.packageTarget, operational.expectedFlavor, operational.mutableRootName],
  ["OPERATIONAL_SERVER", "operational-server", "OPERATIONAL", "operational-server"]
);
assert.deepEqual(operational.services, {
  postgresql: "QuickHackOperationalPostgreSQL",
  console: "QuickHackOperationalServerConsole",
});
assert.equal(operational.opposite.identityName, "QuickHack.Demonstration.Server");
assert.deepEqual(Object.keys(operational.runtimeDatabase).sort(), [
  "host",
  "migratorUser",
  "name",
  "port",
  "runtimeUser",
]);
assert.throws(
  () => windowsServerProvisioningArtifactConfig("OPERATIONAL_CLIENT"),
  (error) => error?.code === "PROVISIONING_ARTIFACT_INVALID"
);

function leader(overrides = {}) {
  return {
    user_id: 7,
    username: "admin",
    role: "LEADER",
    must_change_password: 1,
    is_active: 1,
    credential_revision: 0,
    ...overrides,
  };
}

assert.deepEqual(planExistingBootstrapLeader([]), { action: "CREATE" });
assert.deepEqual(planExistingBootstrapLeader([leader()]), {
  action: "REISSUE",
  userId: 7,
  generation: 1,
});
assert.deepEqual(
  planExistingBootstrapLeader([leader()], { allowExistingLeaderAdoption: true }),
  { action: "ADOPT", userId: 7, generation: 1 }
);
assert.deepEqual(
  planExistingBootstrapLeader(
    [leader({ must_change_password: 0, credential_revision: 3 })],
    { allowExistingLeaderAdoption: true }
  ),
  { action: "ADOPT", userId: 7, generation: 3 }
);
assert.deepEqual(planExistingBootstrapLeader([leader({ role: "ADMIN" })]), {
  action: "CONFLICT",
});
assert.deepEqual(
  planExistingBootstrapLeader([leader(), leader({ user_id: 8 })], {
    allowExistingLeaderAdoption: true,
  }),
  { action: "CONFLICT" }
);

console.log("Windows server existing LEADER provisioning decisions verified.");
