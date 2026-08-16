import assert from "node:assert/strict";

const {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  KeysetCursorError,
  normalizeKeysetLimit,
  prepareKeysetQuery,
} = await import("@/quickhack_server/core/database/keyset-page");

const contract = "TEST_ROWS_BY_UPDATED_AT_V1";
const queryIdentity = {
  filterVersion: 1,
  status: "OPEN",
  sort: ["updatedAt", "id"],
  direction: "desc",
};
const commonTimestamp = "2026-08-13T00:00:00.000Z";
const initialRows = Array.from({ length: 1_001 }, (_, index) => ({
  id: index + 1,
  updatedAt: commonTimestamp,
  status: "OPEN",
})).sort(compareRows);
const snapshot = { maxId: initialRows[0].id, observedAt: commonTimestamp };

function compareRows(left, right) {
  const timestampOrder = right.updatedAt.localeCompare(left.updatedAt);
  return timestampOrder || right.id - left.id;
}

function pageAfter(cursor, source = initialRows, limit = 100) {
  const position = cursor
    ? decodeKeysetCursor({ cursor, contract, queryIdentity }).position
    : null;
  const rows = source
    .filter((row) => row.status === "OPEN")
    .filter((row) => row.id <= snapshot.maxId)
    .filter((row) => row.updatedAt <= snapshot.observedAt)
    .filter(
      (row) =>
        !position ||
        row.updatedAt < position.updatedAt ||
        (row.updatedAt === position.updatedAt && row.id < position.id)
    )
    .sort(compareRows)
    .slice(0, limit + 1);
  return createKeysetPage({
    rows,
    limit,
    coverage: "FILTERED",
    totalCount: initialRows.length,
    cursorFor: (last) =>
      encodeKeysetCursor({
        contract,
        queryIdentity,
        snapshot,
        position: { updatedAt: last.updatedAt, id: last.id },
      }),
  });
}

const seen = [];
let cursor = null;
do {
  const page = pageAfter(cursor);
  seen.push(...page.items.map((row) => row.id));
  cursor = page.nextCursor;
} while (cursor);
assert.equal(seen.length, 1_001);
assert.equal(new Set(seen).size, 1_001);
assert.deepEqual(seen, initialRows.map((row) => row.id));

const first = pageAfter(null);
const changedRows = [
  { id: 1_002, updatedAt: "2026-08-13T00:01:00.000Z", status: "OPEN" },
  ...initialRows.map((row) =>
    row.id === 800
      ? { ...row, updatedAt: "2026-08-13T00:02:00.000Z" }
      : row
  ),
].sort(compareRows);
const second = pageAfter(first.nextCursor, changedRows);
assert.equal(second.items.some((row) => row.id === 1_002), false);
assert.equal(second.items.some((row) => first.items.some((item) => item.id === row.id)), false);

assert.throws(
  () =>
    decodeKeysetCursor({
      cursor: first.nextCursor,
      contract,
      queryIdentity: { ...queryIdentity, status: "CLOSED" },
    }),
  KeysetCursorError
);

const tamperedEnvelope = JSON.parse(
  Buffer.from(first.nextCursor, "base64url").toString("utf8")
);
tamperedEnvelope.position.id = 1;
const tamperedCursor = Buffer.from(
  JSON.stringify(tamperedEnvelope),
  "utf8"
).toString("base64url");
assert.throws(
  () => decodeKeysetCursor({ cursor: tamperedCursor, contract, queryIdentity }),
  KeysetCursorError
);
assert.throws(
  () => decodeKeysetCursor({ cursor: "not-json", contract, queryIdentity }),
  KeysetCursorError
);

let predicateBuildCount = 0;
const prepared = prepareKeysetQuery({
  queryIdentity,
  buildPredicate: () => {
    predicateBuildCount += 1;
    return { status: "OPEN", snapshotMaxId: snapshot.maxId };
  },
});
assert.equal(predicateBuildCount, 1);
assert.equal(prepared.predicate.status, "OPEN");
assert.match(prepared.queryFingerprint, /^[a-f0-9]{64}$/);
assert.throws(
  () => prepareKeysetQuery({ queryIdentity: { status: undefined }, buildPredicate: () => ({}) }),
  /JSON-compatible/
);
const cyclicIdentity = {};
cyclicIdentity.self = cyclicIdentity;
assert.throws(
  () => prepareKeysetQuery({ queryIdentity: cyclicIdentity, buildPredicate: () => ({}) }),
  /cycle/
);
assert.equal(normalizeKeysetLimit("500", { defaultLimit: 50, maxLimit: 200 }), 200);
assert.equal(normalizeKeysetLimit("bad", { defaultLimit: 50, maxLimit: 200 }), 50);
assert.throws(
  () => normalizeKeysetLimit(10, { defaultLimit: 200, maxLimit: 100 }),
  /positive bounded range/
);
assert.throws(
  () =>
    createKeysetPage({
      rows: [],
      limit: 10,
      coverage: "COMPLETE",
      totalCount: -1,
      cursorFor: () => "unused",
    }),
  /non-negative safe integer/
);

console.log(
  "Keyset cursor query ownership, stable tie ordering, snapshot boundary, and page contract verified."
);
