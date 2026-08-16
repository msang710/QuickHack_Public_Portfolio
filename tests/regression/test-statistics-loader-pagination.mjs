import assert from "node:assert/strict";
import {
  StatisticsLoaderCursorError,
  loadStatisticsCursorPages,
} from "../../quickhack_server/statistics/statistics-loader.ts";

const fixture = Array.from({ length: 1_030 }, (_, index) => ({
  id: index + 1,
  value: `row-${index + 1}`,
}));
const requestedCursors = [];

const rows = await loadStatisticsCursorPages({
  batchSize: 200,
  loadPage: async (cursor, take) => {
    requestedCursors.push(cursor ?? null);
    const start = cursor ?? 0;
    return fixture.filter((row) => row.id > start).slice(0, take);
  },
  getCursor: (row) => row.id,
});

assert.equal(rows.length, fixture.length);
assert.deepEqual(rows, fixture);
assert.deepEqual(requestedCursors, [null, 200, 400, 600, 800, 1000]);

await assert.rejects(
  () =>
    loadStatisticsCursorPages({
      batchSize: 2,
      loadPage: async () => [
        { id: 1 },
        { id: 1 },
      ],
      getCursor: (row) => row.id,
    }),
  (error) => {
    assert.ok(error instanceof StatisticsLoaderCursorError);
    return true;
  }
);

await assert.rejects(
  () =>
    loadStatisticsCursorPages({
      batchSize: 0,
      loadPage: async () => [],
      getCursor: (row) => row.id,
    }),
  TypeError
);

console.log("Statistics cursor pagination checks passed.");
