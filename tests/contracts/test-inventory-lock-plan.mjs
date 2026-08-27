import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDeviceAggregateLockPlan,
} from "../../quickhack_server/inventory/device-aggregate-lock.ts";
import {
  buildInventoryQuantityBalanceLockPlan,
} from "../../quickhack_server/inventory/inventory-quantity-ledger-service.ts";

assert.deepEqual(
  buildDeviceAggregateLockPlan(["PG0000000002", "pg0000000001", "PG0000000002"]),
  ["PG0000000001", "PG0000000002"]
);
assert.deepEqual(
  buildInventoryQuantityBalanceLockPlan([
    { inventorySkuId: 2, inventoryStatus: "SELLABLE" },
    { inventorySkuId: 1, inventoryStatus: "RESERVED" },
    { inventorySkuId: 1, inventoryStatus: "RESERVED" },
  ]),
  ["1:RESERVED", "2:SELLABLE"]
);

const read = (file) => readFileSync(file, "utf8");
const manual = read("quickhack_server/sales-channel/coupang/manual-order-match-service.ts");
const auto = read("quickhack_server/sales-channel/coupang/order-matching-service.ts");
const rematch = read("quickhack_server/sales-channel/coupang/order-rematch-service.ts");
const instruct = read("quickhack_server/sales-channel/coupang/order-instruct-finalizer.ts");
const returns = read("quickhack_server/returns/return-write-finalizer.ts");

for (const source of [manual, auto, rematch, instruct, returns]) {
  assert.match(source, /lockDeviceAggregates/);
}
for (const source of [manual, rematch, instruct, returns]) {
  assert.match(source, /lockInventoryQuantityBalanceKeys/);
}
assert.ok(
  manual.indexOf("FROM order_matching_work_queue") <
    manual.indexOf("FROM coupang_order_raw")
);
assert.ok(
  auto.indexOf("lockOrderMatchingWorkItem") < auto.indexOf("FROM coupang_order_raw")
);
assert.ok(
  rematch.indexOf("FROM order_matching_work_queue") <
    rematch.indexOf("FROM coupang_order_raw")
);
for (const source of [instruct, returns]) {
  assert.ok(
    source.lastIndexOf("lockDeviceAggregates") <
      source.lastIndexOf("lockInventoryQuantityBalanceKeys")
  );
}

console.log("Canonical device, allocation, and balance lock plans verified.");
