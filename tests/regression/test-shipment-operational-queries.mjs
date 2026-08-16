import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const [
  orders,
  inTransit,
  addressChanges,
  deliverySearch,
  invoiceQueries,
  replacements,
  trackingEvents,
  trackingSync,
  persistence,
] = await Promise.all([
  read("quickhack_server/shipment/shipment-orders-service.ts"),
  read("quickhack_server/shipment/shipment-tracking-query-service.ts"),
  read("quickhack_server/shipment/shipment-address-change-list-service.ts"),
  read("quickhack_server/shipment/shipment-delivery-search-service.ts"),
  read("quickhack_server/shipment/carrier-integration/invoice-operation-query-service.ts"),
  read("quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service.ts"),
  read("quickhack_server/shipment/carrier-integration/tracking-event-query-service.ts"),
  read("quickhack_server/shipment/carrier-integration/logen/tracking-sync-service.ts"),
  read("quickhack_server/shipment/carrier-integration/persistence-service.ts"),
]);

for (const [name, source] of [
  ["orders", orders],
  ["in-transit", inTransit],
  ["address changes", addressChanges],
  ["delivery search", deliverySearch],
  ["invoice queries", invoiceQueries],
  ["replacements", replacements],
  ["tracking events", trackingEvents],
]) {
  assert.match(source, /decodeKeysetCursor/, `${name} must validate an owned cursor`);
  assert.match(source, /encodeKeysetCursor/, `${name} must emit an opaque cursor`);
}

assert.match(orders, /runConsistentReadSnapshot\(/);
assert.match(orders, /findShipmentPrintAllocations\(input\.client\)/);
assert.match(orders, /shipment_list_print_batch_items:[\s\S]*?none:/);
assert.match(orders, /compareMatchedGroupPosition/);
assert.doesNotMatch(orders, /take:\s*limit,\s*include:\s*workItemSalesOfferInclude/);

assert.match(inTransit, /packageGroupCount:\s*snapshot\.packageGroupCount/);
assert.match(inTransit, /reviewRequiredCount:\s*snapshot\.reviewRequiredCount/);
assert.doesNotMatch(inTransit, /take:\s*(1000|3000)/);

assert.match(addressChanges, /ACTION_REQUIRED/);
assert.match(addressChanges, /change_status:\s*\{\s*in:\s*\["PENDING",\s*"FAILED"\]/);
assert.match(addressChanges, /filteredCount/);
assert.doesNotMatch(addressChanges, /take:\s*(300|1000),/);

assert.match(deliverySearch, /operationalReviewCountsByPackage/);
for (const source of [
  "CHANNEL_WRITE",
  "CARRIER_REGISTRATION",
  "INVOICE_ISSUE",
  "INVOICE_REPLACEMENT",
]) {
  assert.match(deliverySearch, new RegExp(`source:\\s*"${source}"`));
}
assert.match(deliverySearch, /historyFilter|buildWhere/);

assert.match(invoiceQueries, /const historyFilter/);
assert.match(invoiceQueries, /count\(\{ where: historyFilter \}\)/);
assert.match(invoiceQueries, /MANUAL_CANDIDATE_CURSOR_CONTRACT/);
assert.match(replacements, /scope === "HISTORY"/);
assert.match(replacements, /ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES/);

assert.match(trackingEvents, /scan_date DESC NULLS LAST/);
assert.match(trackingEvents, /scan_time DESC NULLS LAST/);
assert.match(trackingEvents, /carrier_tracking_event_id DESC/);
assert.match(trackingEvents, /maxEventId/);

assert.match(trackingSync, /throttleCarrierTrackingAndOpenReadReview\(\{/);
assert.match(persistence, /client\?: Prisma\.TransactionClient/);
assert.match(persistence, /last_tracked_at:\s*now/);

console.log("Shipment operational keyset, completeness, review, and starvation contracts verified.");
