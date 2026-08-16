import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDeviceHistoryPage } from "../../quickhack_server/inventory/device-history-query-service.ts";

function inbound(id) {
  return {
    revision: 0,
    inbound_id: id,
    pg_no: "PG-HISTORY",
    inbound_batch_id: null,
    supplier_name: `supplier-${id}`,
    purchase_price: 1000 + id,
    purchase_price_reference_rate_id: null,
    purchase_price_reference_amount: null,
    purchase_price_entry_mode: null,
    received_at: new Date(`2026-08-${String((id % 20) + 1).padStart(2, "0")}T00:00:00Z`),
    price_agreed_at: null,
    supplier_returned_at: null,
    inbound_status: "RECEIVED",
    note: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
    purchase_price_updated_by_user_id: null,
    purchase_price_updated_at: null,
    inbound_batch: null,
    _count: { sales_records: 0 },
  };
}

const rows = Array.from({ length: 1_001 }, (_, index) => inbound(index + 1));
const transactions = [];

const tx = {
  $executeRawUnsafe: async (sql) => {
    transactions.at(-1).statements.push(sql);
    return 0;
  },
  devices: {
    findUnique: async ({ where }) =>
      where.pg_no === "PG-HISTORY" ? { device_id: 1 } : null,
  },
  inbounds: {
    aggregate: async () => ({
      _max: { inbound_id: Math.max(...rows.map((row) => row.inbound_id)) },
    }),
    count: async ({ where }) =>
      rows.filter(
        (row) =>
          row.pg_no === where.pg_no &&
          (where.inbound_id?.lte === undefined ||
            row.inbound_id <= where.inbound_id.lte)
      ).length,
    findMany: async ({ where, take }) =>
      rows
        .filter(
          (row) =>
            row.pg_no === where.pg_no &&
            row.inbound_id <= where.inbound_id.lte &&
            (where.inbound_id.lt === undefined ||
              row.inbound_id < where.inbound_id.lt)
        )
        .sort((left, right) => right.inbound_id - left.inbound_id)
        .slice(0, take),
  },
};

const owner = {
  $transaction: async (callback, options) => {
    transactions.push({ options, statements: [] });
    return callback(tx);
  },
};

const first = await getDeviceHistoryPage(
  { pgNo: "pg-history", section: "inbounds", limit: 20 },
  owner
);
assert.ok(first);
assert.equal(first.coverage, "COMPLETE");
assert.equal(first.totalCount, 1_001);
assert.equal(first.items.length, 20);
assert.equal(first.items[0].recordId, 1_001);
assert.equal(first.items.at(-1).recordId, 982);
assert.equal(first.hasMore, true);
assert.ok(first.nextCursor);

rows.push(inbound(1_002));
const allRecordIds = first.items.map((item) => item.recordId);
let nextCursor = first.nextCursor;
while (nextCursor) {
  const page = await getDeviceHistoryPage(
    {
      pgNo: "PG-HISTORY",
      section: "inbounds",
      cursor: nextCursor,
      limit: 20,
    },
    owner
  );
  assert.ok(page);
  assert.equal(page.totalCount, 1_001);
  allRecordIds.push(...page.items.map((item) => item.recordId));
  nextCursor = page.nextCursor;
}
assert.equal(allRecordIds.length, 1_001);
assert.equal(new Set(allRecordIds).size, 1_001);
assert.deepEqual(
  allRecordIds,
  Array.from({ length: 1_001 }, (_, index) => 1_001 - index)
);
assert.equal(allRecordIds.includes(1_002), false);

await assert.rejects(
  () =>
    getDeviceHistoryPage(
      {
        pgNo: "PG-HISTORY",
        section: "inspections",
        cursor: first.nextCursor,
      },
      owner
    ),
  (error) =>
    error?.code === "DEVICE_HISTORY_CURSOR_INVALID" && error?.status === 400
);

for (const transaction of transactions) {
  assert.equal(transaction.options.isolationLevel, "RepeatableRead");
  assert.equal(transaction.statements[0], "SET TRANSACTION READ ONLY");
}

const routeSource = readFileSync(
  "quickhack_server/api/inventory/device-history.ts",
  "utf8"
);
const detailSource = readFileSync(
  "quickhack_server/inventory/devices-service.ts",
  "utf8"
);
const sheetSource = readFileSync(
  "quickhack_client/components/shared/device-detail-sheet.tsx",
  "utf8"
);
const correctionSource = readFileSync(
  "quickhack_client/components/inventory/inventory-edit-view.tsx",
  "utf8"
);
for (const snapshotConsumer of [
  "quickhack_server/inventory/inventory-quantity-ledger-audit-service.ts",
  "quickhack_server/inventory/inventory-quantity-query-service.ts",
  "quickhack_server/inventory/inventory-consistency-audit-service.ts",
  "quickhack_server/inbound/inbound-reconciliation-service.ts",
  "quickhack_server/inbound/inbound-batch-plan-query-service.ts",
  "quickhack_server/statistics/inventory-statistics-service.ts",
  "quickhack_server/statistics/statistics-service.ts",
]) {
  assert.match(
    readFileSync(snapshotConsumer, "utf8"),
    /runConsistentReadSnapshot\(/,
    `${snapshotConsumer} must use the common read snapshot boundary.`
  );
}
assert.match(routeSource, /canAccessRole\(user\.role, "VIEWER"\)/);
assert.match(routeSource, /request\.nextUrl\.search/);
assert.doesNotMatch(detailSource, /take:\s*20|slice\(0,\s*20\)/);
assert.match(sheetSource, /requestDeviceHistoryPage\(/);
assert.match(sheetSource, /onValueChange=\{handleTabChange\}/);
assert.match(correctionSource, /requestInventoryCorrectionHistory\(/);
assert.match(correctionSource, /이전 기록 더 불러오기/);

console.log(
  "Device history keyset snapshot, query ownership, complete coverage, and read-only repeatable-read boundary verified."
);
