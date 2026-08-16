import crypto from "node:crypto";

export const SYNTHETIC_CATALOG_VERSION = "quickhack-synthetic-v1";
export const SYNTHETIC_SELLER_PRODUCT_COUNT = 88;
export const SYNTHETIC_VENDOR_ITEM_COUNT = 806;
export const SYNTHETIC_PRODUCT_COUNT = 88;

const MODEL_COUNT = 44;
const COLORS = Object.freeze(["블랙", "화이트", "블루", "그린", "핑크"]);
const CAPACITIES = Object.freeze(["128GB", "256GB"]);

function defaultRandomInteger(maxExclusive) {
  return crypto.randomInt(0, maxExclusive);
}

function numericIdFactory(length, randomInteger) {
  const used = new Set();

  return () => {
    let candidate;
    do {
      const digits = [String(1 + randomInteger(9))];
      for (let index = 1; index < length; index += 1) {
        digits.push(String(randomInteger(10)));
      }
      candidate = digits.join("");
    } while (used.has(candidate));

    used.add(candidate);
    return candidate;
  };
}

function modelCode(modelIndex) {
  return `QH-M${String(modelIndex).padStart(3, "0")}`;
}

function catalogItem({
  sourceRowIndex,
  sellerProductId,
  productId,
  vendorItemId,
  model,
  color,
  capacity,
  warrantyYears,
}) {
  const warrantyLabel = `${warrantyYears}년 보증`;
  const grade = warrantyYears === 2 ? "A" : "B";
  const gradeGroupCode = warrantyYears === 2 ? "2Y" : "1Y";
  const sellerProductName = `${model} ${warrantyLabel}`;
  const itemName = `${model} ${color} ${capacity} ${warrantyLabel}`;
  const vendorSkuCode = ["QH", model, capacity, color, grade].join("_");

  return {
    sourceRowIndex,
    productId,
    sellerProductId,
    sellerProductName,
    sellerProductItemName: itemName,
    vendorItemId,
    vendorItemName: itemName,
    vendorSkuCode,
    quickhackModel: model,
    quickhackColor: color,
    quickhackCapacity: capacity,
    quickhackGrade: grade,
    currentQuantitySnapshot: 0,
    averagePriceSnapshot: 0,
    quickhackGradeGroupCode: gradeGroupCode,
    quickhackGradeGroupLabel: warrantyLabel,
    rawJson: JSON.stringify({
      catalogVersion: SYNTHETIC_CATALOG_VERSION,
      model,
      color,
      capacity,
      warrantyYears,
    }),
  };
}

export function createSyntheticProductCatalog({
  randomInteger = defaultRandomInteger,
} = {}) {
  const nextSellerProductId = numericIdFactory(11, randomInteger);
  const nextVendorItemId = numericIdFactory(11, randomInteger);
  const nextProductId = numericIdFactory(10, randomInteger);
  const products = [];

  for (
    let groupIndex = 0;
    groupIndex < SYNTHETIC_SELLER_PRODUCT_COUNT;
    groupIndex += 1
  ) {
    const model = modelCode((groupIndex % MODEL_COUNT) + 1);
    const warrantyYears = groupIndex < MODEL_COUNT ? 1 : 2;
    const sellerProductId = nextSellerProductId();
    const productId = nextProductId();
    const variantCount = groupIndex < 14 ? 10 : 9;

    for (let variantIndex = 0; variantIndex < variantCount; variantIndex += 1) {
      products.push(
        catalogItem({
          sourceRowIndex: products.length + 1,
          sellerProductId,
          productId,
          vendorItemId: nextVendorItemId(),
          model,
          color: COLORS[variantIndex % COLORS.length],
          capacity: CAPACITIES[Math.floor(variantIndex / COLORS.length)],
          warrantyYears,
        })
      );
    }
  }

  if (products.length !== SYNTHETIC_VENDOR_ITEM_COUNT) {
    throw new Error(
      `Synthetic Coupang catalog count mismatch: ${products.length}.`
    );
  }

  return products;
}
