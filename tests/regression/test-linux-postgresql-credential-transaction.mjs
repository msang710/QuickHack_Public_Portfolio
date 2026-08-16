import assert from "node:assert/strict";
import { createLinuxPostgresqlCredentialTransaction } from "../../tools/platform/linux/postgresql-credential-transaction.mjs";

const calls = [];
const provisioner = {
  async prepare({ identity }) {
    calls.push(["prepare", identity.id]);
    return { state: "PREPARED", identityId: identity.id, generationId: identity.id, preparedPath: `/${identity.id}.prepared`, targetPath: `/${identity.id}` };
  },
  async commit(token) {
    calls.push(["commit", token.identityId]);
    return { ...token, state: "COMMITTED_RESTART_REQUIRED", previousExists: false, backupPath: "" };
  },
  async discard(token) { calls.push(["discard", token.identityId]); },
  async activate(token) { calls.push(["activate", token.identityId]); },
  async rollback(token) { calls.push(["rollback", token.identityId]); },
};
const config = {
  packageFlavor: "OPERATIONAL",
  database: {
    name: "quickhack",
    migratorUser: "quickhack_migrator",
    runtimeUser: "quickhack_runtime",
  },
};
const existing = Buffer.from("a".repeat(43));
const transaction = createLinuxPostgresqlCredentialTransaction({
  provisioner,
  readExisting: async (identity) => identity.postgresqlRole === "runtime" ? Buffer.from(existing) : null,
});
const prepared = await transaction.prepare(config);
assert.equal(prepared.state, "PREPARED");
assert.equal(JSON.stringify(prepared).includes("a".repeat(43)), false);
assert.equal(calls.filter(([name]) => name === "prepare").length, 3);
const committed = await transaction.commit(prepared);
assert.equal(committed.state, "COMMITTED_RESTART_REQUIRED");
await transaction.activate(committed);
assert.equal(calls.filter(([name]) => name === "activate").length, 3);
await transaction.dispose(committed);

const rollbackCalls = [];
const rollbackTransaction = createLinuxPostgresqlCredentialTransaction({
  provisioner: {
    ...provisioner,
    async prepare({ identity }) { return { state: "PREPARED", identityId: identity.id, generationId: identity.id, preparedPath: `/${identity.id}.prepared`, targetPath: `/${identity.id}` }; },
    async commit(token) {
      if (rollbackCalls.length === 1) throw new Error("commit failure");
      rollbackCalls.push(token.identityId);
      return { ...token, state: "COMMITTED_RESTART_REQUIRED", previousExists: false, backupPath: "" };
    },
    async rollback(token) { rollbackCalls.push(`rollback:${token.identityId}`); },
    async discard(token) { rollbackCalls.push(`discard:${token.identityId}`); },
  },
  readExisting: async () => null,
});
const rollbackPrepared = await rollbackTransaction.prepare(config);
await assert.rejects(() => rollbackTransaction.commit(rollbackPrepared));
assert.equal(rollbackCalls.some((value) => String(value).startsWith("rollback:")), true);
assert.equal(rollbackCalls.some((value) => String(value).startsWith("discard:")), true);
await rollbackTransaction.dispose(rollbackPrepared);
existing.fill(0);

console.log("Linux PostgreSQL credential prepare/commit/activate/rollback transaction verified.");
