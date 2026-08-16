import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectIntegrationArray,
  expectIntegrationDecimalId,
  expectIntegrationNonnegativeSafeInteger,
  expectIntegrationObject,
  expectIntegrationSafeInteger,
  expectIntegrationString,
  IntegrationSchemaValidationError,
  parseLosslessIntegrationJson,
  quoteUnsafeJsonIntegers,
  schemaError,
  validateIntegrationJson,
} from "@/quickhack_server/integration/schema-validation";
import { validateCoupangOrdersheetPage } from "@/quickhack_server/sales-channel/coupang/ordersheet-schema";

const parsed = parseLosslessIntegrationJson({
  provider: "COUPANG",
  endpoint: "ordersheets",
  rawText:
    '{"safe":9007199254740991,"boundary":9007199254740992,"first":123456789012345678,"second":123456789012345679,"text":"123456789012345680","negative":-123456789012345681,"fraction":123456789012345678.5,"exponent":1e20}',
});
assert.equal(parsed.safe, Number.MAX_SAFE_INTEGER);
assert.equal(parsed.boundary, "9007199254740992");
assert.equal(parsed.first, "123456789012345678");
assert.equal(parsed.second, "123456789012345679");
assert.equal(parsed.text, "123456789012345680");
assert.equal(parsed.negative, "-123456789012345681");
assert.equal(typeof parsed.fraction, "number");
assert.equal(typeof parsed.exponent, "number");
assert.equal(
  quoteUnsafeJsonIntegers('{"escaped":"value \\" 123456789012345678","id":123456789012345678}'),
  '{"escaped":"value \\" 123456789012345678","id":"123456789012345678"}'
);

const valid = validateIntegrationJson({
  provider: "COUPANG",
  endpoint: "ordersheets",
  rawText:
    '{"code":"200","data":[{"shipmentBoxId":123456789012345678,"quantity":2}]}',
  validate(payload, context) {
    const root = expectIntegrationObject(payload, context);
    const code = expectIntegrationString(root.code, context, "$.code");
    if (code !== "200") {
      return schemaError({
        ...context,
        path: "$.code",
        reason: "APPLICATION_ERROR",
      });
    }
    const rows = expectIntegrationArray(root.data, context, "$.data");
    return rows.map((value, index) => {
      const row = expectIntegrationObject(value, context, `$.data[${index}]`);
      return {
        shipmentBoxId: expectIntegrationDecimalId(
          row.shipmentBoxId,
          context,
          `$.data[${index}].shipmentBoxId`
        ),
        quantity: expectIntegrationSafeInteger(
          row.quantity,
          context,
          `$.data[${index}].quantity`
        ),
      };
    });
  },
});
assert.deepEqual(valid.normalizedResult, [
  { shipmentBoxId: "123456789012345678", quantity: 2 },
]);
assert.match(valid.rawPayloadDigest, /^[a-f0-9]{64}$/);
assert.equal(
  expectIntegrationDecimalId(123456, {
    provider: "COUPANG",
    endpoint: "ordersheets",
  }, "$.safeId"),
  "123456"
);
assert.throws(
  () =>
    expectIntegrationNonnegativeSafeInteger(-1, {
      provider: "COUPANG",
      endpoint: "ordersheets",
    }, "$.quantity"),
  IntegrationSchemaValidationError
);

const empty = validateIntegrationJson({
  provider: "COUPANG",
  endpoint: "ordersheets",
  rawText: '{"code":"200","data":[]}',
  validate(payload, context) {
    const root = expectIntegrationObject(payload, context);
    expectIntegrationString(root.code, context, "$.code");
    return expectIntegrationArray(root.data, context, "$.data");
  },
});
assert.deepEqual(empty.normalizedResult, []);

const officialOrdersheetPage = validateIntegrationJson({
  provider: "COUPANG",
  endpoint: "ordersheets",
  rawText: JSON.stringify({
    code: 200,
    nextToken: "NEXT-1",
    data: [
      {
        orderId: 123456789012345678n.toString(),
        shipmentBoxId: 223456789012345678n.toString(),
        status: "ACCEPT",
        deliveredDate: "2026-08-12T23:30:15+09:00",
        orderItems: [
          {
            vendorItemId: 323456789012345678n.toString(),
            sellerProductId: 423456789012345678n.toString(),
            shippingCount: 2,
            holdCountForCancel: 0,
            cancelCount: 0,
            canceled: false,
          },
          {
            vendorItemId: 323456789012345679n.toString(),
            shippingCount: 1,
            holdCountForCancel: 0,
            cancelCount: 0,
            canceled: false,
          },
        ],
      },
    ],
  }),
  validate: validateCoupangOrdersheetPage,
});
assert.equal(
  officialOrdersheetPage.normalizedResult.orders[0].externalOrderId,
  "123456789012345678"
);
assert.equal(
  officialOrdersheetPage.normalizedResult.orders[0].externalShipmentId,
  "223456789012345678"
);
assert.deepEqual(
  officialOrdersheetPage.normalizedResult.orders[0].items.map(
    (item) => item.externalVendorItemId
  ),
  ["323456789012345678", "323456789012345679"]
);
assert.equal(officialOrdersheetPage.normalizedResult.nextToken, "NEXT-1");
assert.equal(
  officialOrdersheetPage.normalizedResult.orders[0].deliveredAt,
  "2026-08-12T14:30:15.000Z"
);

const invalidDeliveredDatePage = validateCoupangOrdersheetPage({
  code: 200,
  data: [
    {
      orderId: "123456789012345679",
      shipmentBoxId: "223456789012345679",
      status: "FINAL_DELIVERY",
      deliveredDate: "2026-02-30T10:00:00+09:00",
      orderItems: [
        {
          vendorItemId: "323456789012345680",
          shippingCount: 1,
          holdCountForCancel: 0,
          cancelCount: 0,
          canceled: false,
        },
      ],
    },
  ],
});
assert.equal(
  invalidDeliveredDatePage.orders[0].deliveredAt,
  null,
  "An impossible provider calendar date must use the observation-time fallback."
);

const emptyOfficialOrdersheetPage = validateIntegrationJson({
  provider: "COUPANG",
  endpoint: "ordersheets",
  rawText: '{"code":200,"data":[]}',
  validate: validateCoupangOrdersheetPage,
});
assert.deepEqual(emptyOfficialOrdersheetPage.normalizedResult.orders, []);

for (const [rawText, expectedPath] of [
  ['{"data":[]}', "$.code"],
  ['{"code":200,"data":{}}', "$.data"],
  [
    '{"code":200,"data":[{"orderId":"1","shipmentBoxId":"2"}]}',
    "$.data[0].orderItems",
  ],
  [
    '{"code":200,"data":[{"orderId":"ORDER-1","shipmentBoxId":"2","orderItems":[]}]}',
    "$.data[0].orderId",
  ],
  [
    '{"code":200,"data":[{"orderId":"1","shipmentBoxId":"2","orderItems":[{"vendorItemId":"3","shippingCount":-1,"holdCountForCancel":0,"cancelCount":0,"canceled":false}]}]}',
    "$.data[0].orderItems[0].shippingCount",
  ],
  [
    '{"code":200,"data":[{"orderId":"1","shipmentBoxId":"2","orderItems":[{"vendorItemId":"3","shippingCount":1,"holdCountForCancel":0,"cancelCount":0,"canceled":0}]}]}',
    "$.data[0].orderItems[0].canceled",
  ],
]) {
  assert.throws(
    () =>
      validateIntegrationJson({
        provider: "COUPANG",
        endpoint: "ordersheets",
        rawText,
        validate: validateCoupangOrdersheetPage,
      }),
    (error) =>
      error instanceof IntegrationSchemaValidationError &&
      error.path === expectedPath
  );
}

assert.throws(
  () =>
    validateIntegrationJson({
      provider: "COUPANG",
      endpoint: "ordersheets",
      rawText: '{"code":"ERROR","data":[]}',
      validate(payload, context) {
        const root = expectIntegrationObject(payload, context);
        const code = expectIntegrationString(root.code, context, "$.code");
        if (code !== "200") {
          return schemaError({
            ...context,
            path: "$.code",
            reason: "APPLICATION_ERROR",
          });
        }
        return [];
      },
    }),
  (error) =>
    error instanceof IntegrationSchemaValidationError &&
    error.path === "$.code" &&
    error.reason === "APPLICATION_ERROR"
);

const secretMarker = "DO_NOT_LEAK_THIS_RAW_VALUE";
assert.throws(
  () =>
    parseLosslessIntegrationJson({
      provider: "COUPANG",
      endpoint: "ordersheets",
      rawText: `{"secret":"${secretMarker}"`,
    }),
  (error) =>
    error instanceof IntegrationSchemaValidationError &&
    !error.message.includes(secretMarker)
);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const coupangApiClientSource = readFileSync(
  path.join(
    projectRoot,
    "quickhack_server",
    "sales-channel",
    "coupang",
    "api-client.ts"
  ),
  "utf8"
);
assert.match(
  coupangApiClientSource,
  /payload:\s*parseCoupangJson<T>\(text\)/,
  "The live Coupang transport must use the lossless parser."
);

console.log(
  "Integration lossless JSON, typed schema failure, and Coupang transport wiring verified."
);
