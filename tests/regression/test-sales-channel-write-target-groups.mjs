import assert from "node:assert/strict";

import {
  findSalesChannelWriteTargetGroup,
  groupSalesChannelWriteTargets,
} from "../../quickhack_server/sales-channel/write/sales-channel-write-target-group.ts";

function target(id, input = {}) {
  return {
    sales_channel_write_request_target_id: id,
    target_external_id: input.targetExternalId ?? null,
    external_shipment_id: input.externalShipmentId ?? null,
    external_vendor_item_id: input.externalVendorItemId ?? null,
    inventory_verification_state_id:
      input.inventoryVerificationStateId ?? null,
  };
}

const invoiceTargets = [
  target(11, { externalShipmentId: "SHIPMENT-1" }),
  target(12, { externalShipmentId: "SHIPMENT-1" }),
  target(13, { externalShipmentId: "SHIPMENT-2" }),
];
const invoiceGroups = groupSalesChannelWriteTargets({
  requestType: "COUPANG_INVOICE_UPLOAD",
  requestTargetExternalId: "SHIPMENT-REQUEST",
  targets: invoiceTargets,
});
assert.deepEqual(
  invoiceGroups.map((group) => ({
    groupKey: group.groupKey,
    representativeTargetId: group.representativeTargetId,
    targetIds: group.targetIds,
  })),
  [
    {
      groupKey: "SHIPMENT:SHIPMENT-1",
      representativeTargetId: 11,
      targetIds: [11, 12],
    },
    {
      groupKey: "SHIPMENT:SHIPMENT-2",
      representativeTargetId: 13,
      targetIds: [13],
    },
  ],
  "Invoice rows for one shipment must be one indivisible resolution group."
);
assert.deepEqual(
  findSalesChannelWriteTargetGroup({
    requestType: "COUPANG_INVOICE_UPLOAD",
    requestTargetExternalId: "SHIPMENT-REQUEST",
    targets: invoiceTargets,
    targetId: 12,
  }).targetIds,
  [11, 12],
  "Any target in a group must resolve to the complete group."
);

const returnTargets = [
  target(21, { targetExternalId: "101" }),
  target(22, { targetExternalId: "102" }),
  target(23, { targetExternalId: "9001" }),
];
const returnGroups = groupSalesChannelWriteTargets({
  requestType: "RETURN_APPROVAL",
  requestTargetExternalId: "RECEIPT-1",
  targets: returnTargets,
});
assert.deepEqual(
  returnGroups.map((group) => ({
    groupKey: group.groupKey,
    representativeTargetId: group.representativeTargetId,
    targetIds: group.targetIds,
  })),
  [
    {
      groupKey: "RETURN:RECEIPT-1",
      representativeTargetId: 21,
      targetIds: [21, 22, 23],
    },
  ],
  "Every allocation and supply event for one return receipt must form one group."
);
assert.deepEqual(
  findSalesChannelWriteTargetGroup({
    requestType: "RETURN_APPROVAL",
    requestTargetExternalId: "RECEIPT-1",
    targets: returnTargets,
    targetId: 22,
  }).targetIds,
  [21, 22, 23],
  "Any return target must resolve to the complete receipt group."
);
assert.throws(
  () =>
    groupSalesChannelWriteTargets({
      requestType: "RETURN_APPROVAL",
      requestTargetExternalId: null,
      targets: returnTargets,
    }),
  /external return receipt identity/,
  "Return grouping must not fall back to an allocation or supply-event identity."
);
assert.equal(
  groupSalesChannelWriteTargets({
    requestType: "COUPANG_INVENTORY_QUANTITY_UPDATE",
    requestTargetExternalId: "VENDOR-ITEM-1",
    targets: [
      target(31, {
        inventoryVerificationStateId: 901,
        externalVendorItemId: "VENDOR-ITEM-1",
      }),
    ],
  })[0].groupKey,
  "INVENTORY:901",
  "Inventory decisions must prefer the verification-state identity."
);

console.log(
  "Sales-channel write target grouping and invoice group closure verified."
);
