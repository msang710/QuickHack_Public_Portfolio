import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [addressView, inTransitView, deliveryDetail, orderView, invoiceView] =
  await Promise.all([
    read("quickhack_client/components/shipment/shipment-address-change-list-view.tsx"),
    read("quickhack_client/components/shipment/shipment-in-transit-list-view.tsx"),
    read("quickhack_client/components/shipment/shipment-delivery-search-detail-sheet.tsx"),
    read("quickhack_client/components/shipment/shipment-order-list-view.tsx"),
    read("quickhack_client/components/invoice/invoice-manual-issue-view.tsx"),
  ]);

assert.match(addressView, /useOwnedRequest\(\)/);
assert.match(addressView, /replacementRequests\.begin/);
assert.match(addressView, /loaded\.replacementWorkId !== replacementWorkId/);
assert.match(addressView, /loaded\.packageGroupId !== row\.packageGroupId/);
assert.match(addressView, /loaded\.shipmentAddressChangeWorkId !== row\.id/);
assert.match(addressView, /request\.commit/);
assert.match(addressView, /selectedIdRef\.current !== selected\.id/);
assert.match(addressView, /status:\s*listScope/);
assert.match(addressView, /setNextCursor/);

for (const source of [inTransitView, deliveryDetail]) {
  assert.match(source, /\/api\/shipments\/tracking-events\//);
  assert.match(source, /AbortController/);
  assert.match(source, /trackingCursor/);
}

assert.match(orderView, /nextCursor/);
assert.match(orderView, /다음 대상 불러오기/);
assert.match(invoiceView, /scope:\s*"OPEN"/);
assert.match(invoiceView, /scope:\s*"HISTORY"/);
assert.match(invoiceView, /loadMoreCandidates/);
assert.match(invoiceView, /setSelectedId\(null\)/);

console.log("Shipment target ownership, tracking history, and pagination UI contracts verified.");
