import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createSyntheticProductCatalog,
  SYNTHETIC_PRODUCT_COUNT,
  SYNTHETIC_SELLER_PRODUCT_COUNT,
  SYNTHETIC_VENDOR_ITEM_COUNT,
} from "../../mock_server/coupang-synthetic-catalog.mjs";

function seededRandomInteger(seed) {
  let state = seed >>> 0;
  return (maxExclusive) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % maxExclusive;
  };
}

function catalog(seed) {
  return createSyntheticProductCatalog({
    randomInteger: seededRandomInteger(seed),
  });
}

const first = catalog(7);
const second = catalog(19);
const sellerIds = new Set(first.map((item) => item.sellerProductId));
const vendorIds = new Set(first.map((item) => item.vendorItemId));
const productIds = new Set(first.map((item) => item.productId));

assert.equal(first.length, SYNTHETIC_VENDOR_ITEM_COUNT);
assert.equal(sellerIds.size, SYNTHETIC_SELLER_PRODUCT_COUNT);
assert.equal(vendorIds.size, SYNTHETIC_VENDOR_ITEM_COUNT);
assert.equal(productIds.size, SYNTHETIC_PRODUCT_COUNT);
assert.notDeepEqual(
  first.map((item) => item.vendorItemId),
  second.map((item) => item.vendorItemId)
);

for (const item of first) {
  assert.match(item.sellerProductId, /^\d{11}$/u);
  assert.match(item.vendorItemId, /^\d{11}$/u);
  assert.match(item.productId, /^\d{10}$/u);
  assert.match(item.sellerProductName, /^QH-M\d{3} [12]년 보증$/u);
  assert.match(
    item.sellerProductItemName,
    /^QH-M\d{3} (?:블랙|화이트|블루|그린|핑크) (?:128GB|256GB) [12]년 보증$/u
  );
  assert.equal(item.vendorItemName, item.sellerProductItemName);
  assert.equal(item.currentQuantitySnapshot, 0);
  assert.equal(item.averagePriceSnapshot, 0);
}

const mockSource = readFileSync(
  new URL("../../mock_server/coupang-mock-server.mjs", import.meta.url),
  "utf8"
);
const windowsStaging = readFileSync(
  new URL("../../packaging/create-staging-package.mjs", import.meta.url),
  "utf8"
);
const linuxStaging = readFileSync(
  new URL("../../packaging/linux/create-staging-package.mjs", import.meta.url),
  "utf8"
);

const removedCatalogFileArgument = ["product", "csv"].join("-");
for (const source of [mockSource, windowsStaging, linuxStaging]) {
  assert.doesNotMatch(source, /\.csv/iu);
  assert.equal(source.includes(removedCatalogFileArgument), false);
}
assert.match(
  windowsStaging,
  /if \(isDemonstrationPackage\) \{[\s\S]*coupang-synthetic-catalog\.mjs[\s\S]*\n\}/u
);
assert.match(
  linuxStaging,
  /if \(config\.includesMockRuntime\) \{[\s\S]*copyDirectory\(path\.join\(root, "mock_server"\)/u
);
assert.doesNotMatch(mockSource, /quickhack_server\/inventory|prisma\/schema/iu);
console.log(
  "Synthetic Coupang catalog counts, names, zero inventory, randomness, and file-free package contract verified."
);
