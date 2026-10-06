import { createHash } from "node:crypto";
import { validateLoadProfile } from "./profile.mjs";

const MODEL_COUNT = 200;
const STORAGE_COUNT = 5;
const COLOR_COUNT = 5;
const GRADE_COUNT = 4;

function hashNumber(seed, domain, index) {
  const hex = createHash("sha256").update(`${seed}\0${domain}\0${index}`).digest("hex").slice(0, 13);
  return Number.parseInt(hex, 16);
}

function numberId(base, index) { return (BigInt(base) + BigInt(index)).toString(); }

function skuFor(profile, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= profile.skuCount) throw new RangeError("SKU index out of range.");
  const grade = index % GRADE_COUNT;
  const color = Math.floor(index / GRADE_COUNT) % COLOR_COUNT;
  const storage = Math.floor(index / (GRADE_COUNT * COLOR_COUNT)) % STORAGE_COUNT;
  const model = Math.floor(index / (GRADE_COUNT * COLOR_COUNT * STORAGE_COUNT)) % MODEL_COUNT;
  return {
    index,
    skuCode: `LV-${profile.runId}-SKU-${String(index).padStart(5, "0")}`,
    modelKey: `LV-${profile.runId}-M${String(model).padStart(3, "0")}`,
    storageKey: `LV-${profile.runId}-S${storage}`,
    colorKey: `LV-${profile.runId}-C${color}`,
    gradeKey: `LV-${profile.runId}-G${grade}`,
    warrantyKey: "1Y",
    offerCode: `LV-${profile.runId}-O-${model}-${storage}-${color}`,
    vendorItemId: numberId("980000000000000000", index),
    productId: numberId("9700000000", index),
    sellerProductId: numberId("96000000000", Math.floor(index / GRADE_COUNT)),
  };
}

function orderFor(profile, index) {
  const historicalCount = profile.days * profile.ordersPerDay;
  const total = historicalCount + profile.activePackingOrders + profile.ordersPerDay * 10;
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw new RangeError("Order index out of range.");
  const historical = index < historicalCount;
  const lineCount = historical && profile.skuCount > 1 && hashNumber(profile.seed, "lines", index) % 10 === 0 ? 2 : 1;
  const skuIndexes = [];
  for (let line = 0; line < lineCount; line += 1) {
    const choice = hashNumber(profile.seed, `sku-${line}`, index);
    const hotCount = Math.max(1, Math.ceil(profile.skuCount / 5));
    const selected = choice % 5 === 0 ? choice % profile.skuCount : choice % hotCount;
    skuIndexes.push(line > 0 && selected === skuIndexes[0] ? (selected + 1) % profile.skuCount : selected);
  }
  const end = Date.parse(profile.historyEnd);
  const activeOffset = index - historicalCount;
  const orderedAt = new Date(historical
    ? end - (profile.days - Math.floor(index / profile.ordersPerDay)) * 86_400_000 + (index % profile.ordersPerDay) * (86_400_000 / profile.ordersPerDay)
    : activeOffset < profile.activePackingOrders
      ? end - 3 * 86_400_000 + activeOffset * (86_400_000 / profile.activePackingOrders)
      : end + (activeOffset - profile.activePackingOrders) * (86_400_000 / profile.ordersPerDay)).toISOString();
  return {
    index, historical, skuIndexes,
    orderId: numberId("950000000000000000", index),
    shipmentId: numberId("940000000000000000", index),
    orderedAt,
    status: historical ? "DELIVERED" : activeOffset < profile.activePackingOrders ? "INSTRUCT" : "ACCEPT",
    pgNo(line = 0) { return `LV${String(index * 2 + line).padStart(10, "0")}`; },
  };
}

export function fixtureCounts(profileInput) {
  const profile = validateLoadProfile(profileInput);
  return { skuCount: profile.skuCount, historicalOrderCount: profile.days * profile.ordersPerDay, activePackingOrderCount: profile.activePackingOrders, totalOrderCount: profile.days * profile.ordersPerDay + profile.activePackingOrders };
}

export function createFixturePlan(profileInput) {
  const profile = validateLoadProfile(profileInput);
  return Object.freeze({
    profile,
    counts: fixtureCounts(profile),
    sku: (index) => skuFor(profile, index),
    order: (index) => orderFor(profile, index),
  });
}

export function skuFixture(profile, index) { return skuFor(validateLoadProfile(profile), index); }
export function orderFixture(profile, index) { return orderFor(validateLoadProfile(profile), index); }
