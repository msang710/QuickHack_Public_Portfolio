import assert from "node:assert/strict";
import {
  LIFECYCLE_DAY_MS,
  defineLifecyclePolicy,
  isStrictlyBeforeLifecycleCutoff,
  lifecycleAgeMs,
  lifecycleCutoffExclusive,
  resolveLifecycleBatchSize,
} from "../../quickhack_shared/lifecycle/lifecycle-policy.mjs";

const policy = defineLifecyclePolicy({
  retentionMs: 30 * LIFECYCLE_DAY_MS,
  graceMs: 7 * LIFECYCLE_DAY_MS,
  maxBatchSize: 100,
  keepLatest: 2,
});
assert.ok(Object.isFrozen(policy));
assert.deepEqual(policy, {
  retentionMs: 30 * LIFECYCLE_DAY_MS,
  graceMs: 7 * LIFECYCLE_DAY_MS,
  maxBatchSize: 100,
  keepLatest: 2,
});

const now = new Date("2026-08-17T00:00:00.000Z");
const cutoff = lifecycleCutoffExclusive(now, policy);
assert.equal(cutoff.toISOString(), "2026-07-18T00:00:00.000Z");
assert.equal(isStrictlyBeforeLifecycleCutoff(cutoff, cutoff), false);
assert.equal(
  isStrictlyBeforeLifecycleCutoff(new Date(cutoff.getTime() - 1), cutoff),
  true
);
assert.equal(
  lifecycleCutoffExclusive(now, policy, { useGrace: true }).toISOString(),
  "2026-08-10T00:00:00.000Z"
);
assert.equal(lifecycleAgeMs(now, cutoff), 30 * LIFECYCLE_DAY_MS);
assert.equal(lifecycleAgeMs("invalid", cutoff), null);
assert.equal(resolveLifecycleBatchSize(policy), 100);
assert.equal(resolveLifecycleBatchSize(policy, 17), 17);
assert.equal(resolveLifecycleBatchSize(policy, 101), 100);
for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(
    () => resolveLifecycleBatchSize(policy, invalid),
    /positive safe integer/
  );
}

for (const input of [
  { retentionMs: -1, maxBatchSize: 1 },
  { retentionMs: 1.5, maxBatchSize: 1 },
  { retentionMs: 1, maxBatchSize: 0 },
  { retentionMs: 1, maxBatchSize: 1_001 },
  { retentionMs: 1, maxBatchSize: 1, keepLatest: -1 },
]) {
  assert.throws(() => defineLifecyclePolicy(input), TypeError);
}

console.log("Bounded strict-cutoff data lifecycle contract verified.");
