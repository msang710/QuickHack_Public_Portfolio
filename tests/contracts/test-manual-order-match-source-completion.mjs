import assert from "node:assert/strict";
import {
  canPreviewManualOrderMatch,
  initialManualOrderMatchCommandDraft,
  manualOrderMatchCommandBody,
  manualOrderMatchCommandDraftReducer,
} from "@/quickhack_client/components/sales-channel/manual-order-match-command-draft";
import { manualOrderMatchShipmentSafetyBlockers } from "@/quickhack_server/sales-channel/coupang/manual-order-match-shipment-safety";

const selected = manualOrderMatchCommandDraftReducer(
  initialManualOrderMatchCommandDraft,
  { type: "CANDIDATE_SELECTED", pgNo: "PG-1", selectionReceiptId: "receipt-1" }
);
const reasoned = manualOrderMatchCommandDraftReducer(selected, {
  type: "REASON_CHANGED",
  reason: "고객 요청",
});
assert.equal(canPreviewManualOrderMatch(reasoned, true), true);

const preview = {
  eligible: true,
  reasonCodes: [],
  manifestToken: "manifest-1",
  currentAllocation: null,
  candidate: null,
};
const previewed = manualOrderMatchCommandDraftReducer(reasoned, {
  type: "PREVIEW_SUCCEEDED",
  preview,
  commandKey: "command-1",
});
assert.equal(
  manualOrderMatchCommandBody(previewed, {
    action: "EXECUTE",
    workItemId: 1,
  })?.selectionReceiptId,
  "receipt-1"
);

for (const event of [
  { type: "CANDIDATE_INVALIDATED" },
  { type: "REQUEST_CHANNEL_CHANGED", requestChannel: "PHONE" },
  { type: "REASON_CHANGED", reason: "다른 요청" },
  { type: "ALLOCATION_CHANGED", allocationId: 7 },
]) {
  const changed = manualOrderMatchCommandDraftReducer(previewed, event);
  assert.equal(changed.preview, null);
  assert.equal(changed.commandKey, "");
}

const invalidPair = manualOrderMatchCommandDraftReducer(reasoned, {
  type: "CANDIDATE_SELECTED",
  pgNo: "PG-2",
  selectionReceiptId: "",
});
assert.equal(invalidPair.pgNo, "");
assert.equal(invalidPair.selectionReceiptId, "");
assert.equal(canPreviewManualOrderMatch(invalidPair, true), false);

const release = manualOrderMatchCommandDraftReducer(reasoned, {
  type: "OPERATION_CHANGED",
  operation: "RELEASE",
  allocationId: 11,
});
assert.equal(release.pgNo, "");
assert.equal(release.selectionReceiptId, "");
assert.equal(canPreviewManualOrderMatch(release, true), true);
assert.equal(
  manualOrderMatchCommandBody(release, {
    action: "PREVIEW",
    workItemId: 1,
  })?.pgNo,
  null
);

assert.deepEqual(
  manualOrderMatchShipmentSafetyBlockers({
    memberships: [
      { removed_at: null, package_group: { group_status: "READY" } },
    ],
    carrierShipments: [],
    issueItems: [],
    registrationWorks: [],
    replacementWorks: [],
    addressWorks: [],
    carrierReturnCount: 0,
  }),
  ["ACTIVE_PACKAGE_GROUP"]
);
assert.deepEqual(
  manualOrderMatchShipmentSafetyBlockers({
    memberships: [
      { removed_at: new Date(), package_group: { group_status: "CANCELED" } },
    ],
    carrierShipments: [
      { invoice_status: "VOID_LOCAL", shipment_status: "ALLOCATED" },
    ],
    issueItems: [{ issue_batch: { batch_status: "FAILED" } }],
    registrationWorks: [{ work_status: "BLOCKED" }],
    replacementWorks: [{ work_status: "CANCELED" }],
    addressWorks: [{ change_status: "CONFIRMED" }],
    carrierReturnCount: 0,
  }),
  [],
  "Canceled or terminal history alone must not permanently block manual matching."
);
assert.deepEqual(
  manualOrderMatchShipmentSafetyBlockers({
    memberships: [],
    carrierShipments: [
      { invoice_status: "REGISTERED", shipment_status: "REGISTERED" },
    ],
    issueItems: [{ issue_batch: { batch_status: "ALLOCATING" } }],
    registrationWorks: [{ work_status: "SUBMITTING" }],
    replacementWorks: [{ work_status: "PROCESSING" }],
    addressWorks: [{ change_status: "PENDING" }],
    carrierReturnCount: 1,
  }),
  [
    "CARRIER_OPERATION_ACTIVE",
    "CARRIER_SHIPMENT_EXISTS",
    "RETURN_STARTED",
    "SHIPMENT_ADDRESS_CHANGE_ACTIVE",
  ]
);

console.log(
  "Manual command draft and shipment/carrier safety source contracts verified."
);
