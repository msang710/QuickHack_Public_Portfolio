import assert from "node:assert/strict";
import { ensureLinuxApplicationCredentials } from "../../tools/platform/linux/application-credential-bootstrap.mjs";

const events = [];
const provisioner = {
  async prepare({ identity, secret }) {
    assert.equal(secret.length, 32);
    events.push(`prepare:${identity.kind}`);
    return { identityId: identity.id };
  },
  async commit(token) { events.push(`commit:${token.identityId}`); return token; },
  async activate(token) { events.push(`activate:${token.identityId}`); },
};
const options = {
  getuid: () => 0,
  exists: async () => false,
  assertEmpty: async () => { events.push("empty-state-verified"); },
  provisioner,
};
const result = await ensureLinuxApplicationCredentials({}, options);
assert.equal(result.created, 4);
assert.equal(events[0], "empty-state-verified");
assert.equal(events.filter((event) => event.startsWith("prepare:")).length, 4);
assert.equal(events.filter((event) => event.startsWith("commit:")).length, 4);
assert.equal(events.filter((event) => event.startsWith("activate:")).length, 4);
const ready = await ensureLinuxApplicationCredentials({}, { ...options, exists: async () => true });
assert.equal(ready.created, 0);
const beforeRecovery = events.length;
await assert.rejects(
  () => ensureLinuxApplicationCredentials({}, {
    ...options,
    assertEmpty: async () => { throw Object.assign(new Error("existing data"), { code: "APPLICATION_CREDENTIAL_RECOVERY_REQUIRED" }); },
  }),
  (error) => error.code === "APPLICATION_CREDENTIAL_RECOVERY_REQUIRED"
);
assert.equal(events.length, beforeRecovery);
await assert.rejects(
  () => ensureLinuxApplicationCredentials({}, { ...options, getuid: () => 1000 }),
  (error) => error.code === "APPLICATION_CREDENTIAL_ROOT_REQUIRED"
);

console.log("Linux application credential bootstrap is idempotent and refuses missing keys with existing data.");
