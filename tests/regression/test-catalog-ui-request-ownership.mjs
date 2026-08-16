import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const channelProductsView = await readFile(
  path.join(
    projectRoot,
    "quickhack_client/components/sales-channel/channel-products-manager-view.tsx"
  ),
  "utf8"
);
const purchasePriceView = await readFile(
  path.join(
    projectRoot,
    "quickhack_client/components/inbound/purchase-price-criteria-rate-view.tsx"
  ),
  "utf8"
);
const purchasePendingView = await readFile(
  path.join(
    projectRoot,
    "quickhack_client/components/inbound/purchase-pending-list-view.tsx"
  ),
  "utf8"
);
const purchasePriceApi = await readFile(
  path.join(projectRoot, "quickhack_server/api/inbound/purchase-prices.ts"),
  "utf8"
);

assert.match(channelProductsView, /loadGenerationRef/);
assert.match(channelProductsView, /payload\.completeness\?\.complete/);
assert.match(
  channelProductsView,
  /generation\s*!==\s*loadGenerationRef\.current/
);
assert.match(
  channelProductsView,
  /setProducts\(nextProducts\)/,
  "A complete latest response must be the only catalog replacement path."
);

for (const source of [purchasePriceView, purchasePendingView]) {
  assert.match(source, /loadedQueryKey/);
  assert.match(source, /QueryContext|queryContext/);
  assert.match(source, /RequestGenerationRef|requestGenerationRef/i);
}
assert.match(purchasePriceView, /setRates\(\[\]\)/);
assert.match(purchasePendingView, /setRates\(\[\]\)/);
assert.match(purchasePriceApi, /PURCHASE_PRICE_QUERY_CONTEXT_REQUIRED/);
assert.match(purchasePriceApi, /queryContext/);

console.log("Catalog UI request ownership contract tests passed.");
