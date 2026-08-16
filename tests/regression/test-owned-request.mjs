import assert from "node:assert/strict";

const {
  createOwnedRequestTargetSnapshot,
  OwnedRequestCoordinator,
} = await import("@/quickhack_client/hooks/use-owned-request");

const coordinator = new OwnedRequestCoordinator();
const firstTarget = createOwnedRequestTargetSnapshot({
  targetId: 10,
  queryKey: "detail",
  revision: 1,
});
const first = coordinator.begin(firstTarget);
assert.equal(first.signal.aborted, false);

const second = coordinator.begin(
  createOwnedRequestTargetSnapshot({
    targetId: 11,
    queryKey: "detail",
    revision: 1,
  })
);
assert.equal(first.signal.aborted, true);
assert.equal(first.isCurrent(), false);
assert.equal(second.isCurrent(), true);

let visibleState = "initial";
assert.equal(first.commit(() => (visibleState = "stale")), false);
assert.equal(visibleState, "initial");
assert.equal(second.commit(() => (visibleState = "current")), true);
assert.equal(visibleState, "current");

const sameTargetNewRevision = coordinator.begin(
  createOwnedRequestTargetSnapshot({
    targetId: 11,
    queryKey: "detail",
    revision: 2,
  })
);
assert.equal(second.signal.aborted, true);
assert.equal(second.commit(() => (visibleState = "old revision")), false);
assert.equal(
  sameTargetNewRevision.commit(() => (visibleState = "new revision")),
  true
);
assert.equal(visibleState, "new revision");

coordinator.dispose();
assert.equal(sameTargetNewRevision.signal.aborted, true);
assert.equal(sameTargetNewRevision.isCurrent(), false);
assert.throws(
  () => createOwnedRequestTargetSnapshot({ targetId: "", queryKey: "detail" }),
  /explicit target/
);

console.log(
  "Owned request abort, generation, target, and revision guards verified."
);
