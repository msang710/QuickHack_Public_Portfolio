import assert from "node:assert/strict";
import {
  validateCoupangExchangePage,
  validateCoupangReturnPage,
  validateCoupangReturnWithdrawalPage,
} from "@/quickhack_server/sales-channel/coupang/claim-schema";
import { validateIntegrationJson } from "@/quickhack_server/integration/schema-validation";

function returnRow(overrides = {}) {
  return {
    receiptId: "991230000000000111",
    orderId: "935770000000001111",
    receiptType: "RETURN",
    receiptStatus: "RETURNS_UNCHECKED",
    cancelCountSum: 2,
    returnItems: [
      {
        shipmentBoxId: "884440000000001112",
        vendorItemId: "3187044097",
        cancelCount: 1,
      },
      {
        shipmentBoxId: "884440000000001111",
        vendorItemId: "3187044096",
        cancelCount: 1,
      },
    ],
    ...overrides,
  };
}

assert.throws(
  () => validateCoupangReturnPage({ code: "ERROR", data: [] }),
  (error) => error?.reason === "APPLICATION_ERROR",
  "Application-level errors must not be projected as successful empty pages."
);
assert.throws(
  () => validateCoupangReturnPage({ data: [] }),
  (error) => error?.reason === "MISSING_SUCCESS_CODE",
  "A missing provider success code must fail closed."
);
assert.throws(
  () =>
    validateCoupangReturnPage({
      code: "200",
      data: [returnRow({ returnItems: [{ vendorItemId: "1", cancelCount: 1 }] })],
    }),
  (error) => error?.path.endsWith("shipmentBoxId"),
  "Return item identity must include its shipment scope."
);

const losslessReturn = validateIntegrationJson({
  provider: "COUPANG",
  endpoint: "RETURN_REQUESTS",
  rawText:
    '{"code":200,"data":[{"receiptId":991230000000000111,"orderId":935770000000001111,"receiptType":"RETURN","receiptStatus":"RETURNS_UNCHECKED","cancelCountSum":2,"returnItems":[{"shipmentBoxId":884440000000001112,"vendorItemId":3187044097,"cancelCount":1},{"shipmentBoxId":884440000000001111,"vendorItemId":3187044096,"cancelCount":1}]}]}',
  validate: validateCoupangReturnPage,
}).normalizedResult.returns[0];
assert.equal(losslessReturn.externalReceiptId, "991230000000000111");
assert.equal(losslessReturn.externalOrderId, "935770000000001111");
assert.equal(losslessReturn.externalShipmentId, "884440000000001111");
assert.deepEqual(
  losslessReturn.items.map((item) => item.externalShipmentId),
  ["884440000000001112", "884440000000001111"],
  "Every item shipment scope must survive normalization."
);
assert.equal(losslessReturn.itemIntegrityStatus, "VALID");

const mismatchedReturn = validateCoupangReturnPage({
  code: "SUCCESS",
  data: [returnRow({ cancelCountSum: 3 })],
}).returns[0];
assert.equal(mismatchedReturn.itemIntegrityStatus, "COUNT_MISMATCH");

const exchange = validateCoupangExchangePage({
  code: "200",
  data: [
    {
      exchangeId: "881230000000000111",
      orderId: "935770000000002222",
      exchangeStatus: "RECEIPT",
      originalShipmentBoxId: "884440000000002223",
      exchangeItemDtoV1s: [
        { originalShipmentBoxId: "884440000000002222" },
        { originalShipmentBoxId: "884440000000002223" },
      ],
    },
  ],
}).exchanges[0];
assert.deepEqual(exchange.externalShipmentIds, [
  "884440000000002222",
  "884440000000002223",
]);
assert.equal(exchange.scopeIntegrityStatus, "VALID");

const missingExchangeScope = validateCoupangExchangePage({
  code: "200",
  data: [
    {
      exchangeId: "881230000000000112",
      orderId: "935770000000002224",
      exchangeStatus: "RECEIPT",
      exchangeItemDtoV1s: [],
    },
  ],
}).exchanges[0];
assert.equal(missingExchangeScope.scopeIntegrityStatus, "MISSING_SCOPE");

const withdrawal = validateCoupangReturnWithdrawalPage({
  code: "200",
  data: [
    {
      cancelId: "991230000000000111",
      orderId: "935770000000001111",
      vendorItemIds: ["3187044097", "3187044096", "3187044097"],
    },
  ],
  nextPageIndex: "2",
});
assert.equal(withdrawal.nextPageIndex, 2);
assert.equal(withdrawal.withdrawals[0].vendorItemIds, "3187044096,3187044097");
assert.throws(
  () =>
    validateCoupangReturnWithdrawalPage({
      code: "200",
      data: [],
      nextPageIndex: "1.5",
    }),
  (error) => error?.reason === "EXPECTED_POSITIVE_PAGE_INDEX"
);

console.log("Strict Coupang claim schemas preserve IDs and reject incomplete evidence.");
