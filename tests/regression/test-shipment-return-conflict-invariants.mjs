import { detectShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import {
  assertReturnSelectionMatchesRequirements,
  buildReturnItemRequirements,
} from "@/quickhack_server/returns/return-item-requirement";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const allocations = [
  {
    allocationId: 1,
    externalOrderId: "ORDER-1",
    externalShipmentId: "SHIP-1",
    externalVendorItemId: "ITEM-A",
    pgNo: "PG-A1",
  },
  {
    allocationId: 2,
    externalOrderId: "ORDER-1",
    externalShipmentId: "SHIP-1",
    externalVendorItemId: "ITEM-A",
    pgNo: "PG-A2",
  },
  {
    allocationId: 3,
    externalOrderId: "ORDER-1",
    externalShipmentId: "SHIP-1",
    externalVendorItemId: "ITEM-B",
    pgNo: "PG-B1",
  },
  {
    allocationId: 4,
    externalOrderId: "ORDER-1",
    externalShipmentId: "SHIP-2",
    externalVendorItemId: "ITEM-A",
    pgNo: "PG-OTHER-SHIPMENT",
  },
];

function returnRow(overrides = {}) {
  return {
    returnRawId: 10,
    externalReceiptId: "RETURN-10",
    externalOrderId: "ORDER-1",
    externalShipmentId: "SHIP-1",
    cancelType: "RETURN",
    receiptStatus: "RU",
    releaseStatus: "N",
    cancelCount: 1,
    items: [
      {
        externalShipmentId: "SHIP-1",
        externalVendorItemId: "ITEM-A",
        sellerProductItemId: null,
        vendorItemName: "Item A",
        cancelCount: 1,
      },
    ],
    ...overrides,
  };
}

const partialReturnConflicts = detectShipmentReturnConflicts(allocations, [
  returnRow(),
]);
assert(partialReturnConflicts.length === 1, "Active return was not detected.");
assert(
  partialReturnConflicts[0].allocationIds.join(",") === "1,2",
  "A partial return must block all candidate PGs for the exact order item until selection."
);
assert(
  !partialReturnConflicts[0].allocationIds.includes(3) &&
    !partialReturnConflicts[0].allocationIds.includes(4),
  "Return matching leaked into another item or shipment."
);

assert(
  detectShipmentReturnConflicts(allocations, [
    returnRow({ receiptStatus: "RETURNS_COMPLETED" }),
  ]).length === 0,
  "Completed returns must not block shipment work."
);
assert(
  detectShipmentReturnConflicts(allocations, [
    returnRow({ cancelType: "EXCHANGE" }),
  ]).length === 0,
  "Exchange rows must not be treated as return conflicts."
);

const missingItemScope = detectShipmentReturnConflicts(allocations, [
  returnRow({ items: [] }),
]);
assert(
  missingItemScope[0].scopeIncomplete === true &&
    missingItemScope[0].allocationIds.join(",") === "1,2,3",
  "Missing item identifiers must fail closed within the exact shipment."
);

const missingShipmentScope = detectShipmentReturnConflicts(allocations, [
  returnRow({
    externalShipmentId: null,
    items: [
      {
        externalShipmentId: null,
        externalVendorItemId: "ITEM-A",
        sellerProductItemId: null,
        vendorItemName: "Item A",
        cancelCount: 1,
      },
    ],
  }),
]);
assert(
  missingShipmentScope[0].scopeIncomplete === true &&
    missingShipmentScope[0].allocationIds.length === 3,
  "A missing shipment identifier must fail closed for matching order-item candidates."
);

const mixedItemRequirements = buildReturnItemRequirements({
  rootCancelCount: 2,
  items: [
    {
      externalShipmentId: "SHIP-1",
      externalVendorItemId: "ITEM-A",
      cancelCount: 1,
    },
    {
      externalShipmentId: "SHIP-1",
      externalVendorItemId: "ITEM-B",
      cancelCount: 1,
    },
  ],
  allocations,
});
assertReturnSelectionMatchesRequirements({
  result: mixedItemRequirements,
  selectedAllocationIds: [2, 3],
});
assert(
  (() => {
    try {
      assertReturnSelectionMatchesRequirements({
        result: mixedItemRequirements,
        selectedAllocationIds: [1, 2],
      });
      return false;
    } catch {
      return true;
    }
  })(),
  "Two candidates from item A were allowed to replace the required item B allocation."
);

console.log("Shipment return conflict matching invariants verified.");
