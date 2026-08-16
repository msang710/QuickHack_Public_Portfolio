import assert from "node:assert/strict";
import {
  UnsavedChangesRegistry,
  unsavedFormSnapshotsEqual,
} from "../../quickhack_client/lib/unsaved-changes.ts";

function entry({
  id,
  label = id,
  kind,
  isDirty = false,
  isBusy = false,
  discard = () => {},
}) {
  return { id, label, kind, isDirty, isBusy, discard };
}

{
  const baseline = {
    name: "QuickHack",
    enabled: true,
    rules: [
      { id: 1, value: "A" },
      { id: 2, value: "B" },
    ],
  };

  assert.equal(
    unsavedFormSnapshotsEqual(baseline, {
      rules: [
        { value: "A", id: 1 },
        { value: "B", id: 2 },
      ],
      enabled: true,
      name: "QuickHack",
    }),
    true,
    "Equivalent snapshots with different object key order were not equal."
  );
  assert.equal(
    unsavedFormSnapshotsEqual(baseline, {
      ...baseline,
      rules: [...baseline.rules].reverse(),
    }),
    false,
    "Meaningful array order changes were not detected."
  );
  assert.equal(
    unsavedFormSnapshotsEqual(
      { optionIds: [1, 2, 3] },
      { optionIds: [1, 2, 3] }
    ),
    true,
    "Normalized set snapshots were not equal."
  );
}

{
  const registry = new UnsavedChangesRegistry();
  registry.register(entry({ id: "clean" }));
  registry.register(entry({ id: "dirty", isDirty: true }));
  registry.register(
    entry({
      id: "busy",
      kind: "one-time-result",
      isBusy: true,
    })
  );

  assert.deepEqual(
    registry.getEntries().map(({ id }) => id),
    ["clean", "dirty", "busy"],
    "Registration order was not preserved."
  );
  assert.deepEqual(
    registry.getDirtyEntries().map(({ id }) => id),
    ["dirty"],
    "Dirty entries were not filtered."
  );
  assert.deepEqual(
    registry.getBusyEntries().map(({ id }) => id),
    ["busy"],
    "Busy entries were not filtered."
  );
  assert.equal(
    registry.getEntries().find(({ id }) => id === "busy")?.kind,
    "one-time-result",
    "The one-time result entry kind was not preserved."
  );
  assert.deepEqual(
    registry.getDirtyEntries(["clean", "dirty"]).map(({ id }) => id),
    ["dirty"],
    "A form id subset was not applied."
  );
}

{
  const registry = new UnsavedChangesRegistry();
  const firstToken = registry.register(
    entry({ id: "same-id", label: "old", isDirty: true })
  );
  const secondToken = registry.register(
    entry({ id: "same-id", label: "new", isDirty: true })
  );

  assert.equal(
    registry.unregister(firstToken),
    false,
    "Stale cleanup removed a newer same-id registration."
  );
  assert.equal(registry.getEntries()[0]?.label, "new");
  assert.equal(
    registry.update(
      firstToken,
      entry({ id: "same-id", label: "stale update", isDirty: false })
    ),
    false,
    "A stale token updated a newer same-id registration."
  );
  assert.equal(
    registry.update(
      secondToken,
      entry({ id: "same-id", label: "updated", isDirty: false })
    ),
    true,
    "The current token could not update its registration."
  );
  assert.equal(registry.getEntries()[0]?.label, "updated");
  assert.equal(registry.unregister(secondToken), true);
  assert.equal(registry.getEntries().length, 0);
}

{
  const registry = new UnsavedChangesRegistry();
  const discarded = [];
  registry.register(
    entry({
      id: "first",
      isDirty: true,
      discard: () => discarded.push("first"),
    })
  );
  registry.register(
    entry({
      id: "second",
      isDirty: true,
      discard: async () => {
        discarded.push("second");
      },
    })
  );

  const result = await registry.discardEntries(registry.getDirtyEntries());
  assert.equal(result.ok, true);
  assert.deepEqual(
    discarded,
    ["first", "second"],
    "Dirty entries were not discarded in registration order."
  );
}

{
  const registry = new UnsavedChangesRegistry();
  const discarded = [];
  registry.register(
    entry({
      id: "fails",
      isDirty: true,
      discard: () => {
        discarded.push("fails");
        throw new Error("expected failure");
      },
    })
  );
  registry.register(
    entry({
      id: "continues",
      isDirty: true,
      discard: () => discarded.push("continues"),
    })
  );

  const result = await registry.discardEntries(registry.getDirtyEntries());
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.entry.id, "fails");
  assert.deepEqual(
    discarded,
    ["fails", "continues"],
    "Discard stopped after the first failure."
  );
}

console.log("Unsaved changes registry verified.");
