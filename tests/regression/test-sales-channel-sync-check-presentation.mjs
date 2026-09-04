import assert from "node:assert/strict";
import {
  formatSalesChannelDifference,
  formatSalesChannelInventoryOption,
  formatSalesChannelQuantity,
  isInventoryVerificationRecheckable,
  salesChannelInventoryRecheckOutcomeKey,
  salesChannelSyncCheckItemKey,
  salesChannelSyncCheckStatusOptions,
} from "../../quickhack_client/components/admin/sales-channel-sync-check-presentation.ts";

assert.notEqual(
  salesChannelSyncCheckItemKey({ kind: "WRITE_REQUEST", id: 1 }),
  salesChannelSyncCheckItemKey({ kind: "INVENTORY_VERIFICATION", id: 1 }),
  "Different sync-check kinds must not share a selection key."
);

assert.deepEqual(
  salesChannelSyncCheckStatusOptions("INVENTORY_VERIFICATION").map(
    ({ value }) => value
  ),
  [
    "UNRESOLVED",
    "ALL",
    "PENDING",
    "CHECKING",
    "MATCHED",
    "MISMATCH",
    "CHECK_FAILED",
    "SKIPPED",
  ],
  "Inventory status choices must be limited to the inventory state machine."
);
assert(
  salesChannelSyncCheckStatusOptions("WRITE_REQUEST").some(
    ({ value }) => value === "REVIEW_REQUIRED"
  ),
  "Write status choices must preserve manual review states."
);
assert(
  salesChannelSyncCheckStatusOptions("ALL").some(
    ({ value }) => value === "CHECK_FAILED"
  ),
  "The combined filter must expose inventory failure states."
);

const formatOptions = { locale: "ko-KR", unknownLabel: "미확인", anyLabel: "전체", randomLabel: "무작위" };
assert.equal(formatSalesChannelInventoryOption("ANY", "256GB", formatOptions), "전체");
assert.equal(formatSalesChannelInventoryOption("RANDOM", "검정", formatOptions), "무작위");
assert.equal(formatSalesChannelInventoryOption("EXACT", "512GB", formatOptions), "512GB");
assert.equal(formatSalesChannelInventoryOption("EXACT", "", formatOptions), "-");

assert.equal(formatSalesChannelQuantity(null, formatOptions), "미확인");
assert.equal(formatSalesChannelQuantity(0, formatOptions), "0");
assert.equal(formatSalesChannelDifference(null, formatOptions), "미확인");
assert.equal(formatSalesChannelDifference(4, formatOptions), "+4");
assert.equal(formatSalesChannelDifference(0, formatOptions), "0");
assert.equal(formatSalesChannelDifference(-3, formatOptions), "-3");

assert.equal(isInventoryVerificationRecheckable("MISMATCH"), true);
assert.equal(isInventoryVerificationRecheckable("CHECK_FAILED"), true);
assert.equal(isInventoryVerificationRecheckable("PENDING"), false);
assert.equal(isInventoryVerificationRecheckable("MATCHED"), false);
assert.equal(isInventoryVerificationRecheckable("CHECKING"), false);

for (const outcome of [
  "MATCHED",
  "MISMATCH",
  "CHECK_FAILED",
  "SKIPPED",
  "ALREADY_CLAIMED",
  "CLAIM_LOST",
]) {
  assert(
    salesChannelInventoryRecheckOutcomeKey(outcome).length > 3,
    `${outcome} must map to a localized recheck-result key.`
  );
}

console.log("Sales-channel sync-check presentation contracts verified.");
