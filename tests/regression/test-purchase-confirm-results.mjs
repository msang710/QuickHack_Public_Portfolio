import assert from "node:assert/strict";
import { reconcilePurchaseConfirmResults } from "../../quickhack_shared/inbound/purchase-confirm.ts";

const requested = ["PG-A", "PG-B"];

{
  const result = reconcilePurchaseConfirmResults(requested, [
    { pgNo: "PG-A", mode: "CONFIRMED" },
    { pgNo: "PG-B", mode: "CONFLICT", reason: "stale inbound" },
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual([...result.completedPgNos], ["PG-A"]);
  assert.deepEqual(result.conflicts, [
    { pgNo: "PG-B", mode: "CONFLICT", reason: "stale inbound" },
  ]);
}

for (const incomplete of [
  [{ pgNo: "PG-A", mode: "CONFIRMED" }],
  [
    { pgNo: "PG-A", mode: "CONFIRMED" },
    { pgNo: "PG-A", mode: "SKIPPED" },
  ],
  [
    { pgNo: "PG-A", mode: "CONFIRMED" },
    { pgNo: "PG-X", mode: "SKIPPED" },
  ],
  [
    { pgNo: "PG-A", mode: "UNKNOWN" },
    { pgNo: "PG-B", mode: "SKIPPED" },
  ],
  [null, { pgNo: "PG-B", mode: "SKIPPED" }],
]) {
  const result = reconcilePurchaseConfirmResults(requested, incomplete);
  assert.equal(result.complete, false);
  assert.deepEqual([...result.completedPgNos], []);
  assert.deepEqual(result.conflicts, []);
}

console.log("Purchase confirmation result reconciliation verified.");
