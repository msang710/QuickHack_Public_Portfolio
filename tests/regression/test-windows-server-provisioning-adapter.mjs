import assert from "node:assert/strict";
import { planExistingBootstrapLeader } from "../../tools/platform/windows/server-provisioning-leader-policy.mjs";

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
