import fs from "node:fs";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const collectionRoute = read("app/api/inventory/devices/route.ts");
const detailRoute = read("app/api/inventory/devices/[pgNo]/route.ts");
const auditRoute = read("app/api/inventory/audit-candidates/route.ts");
const purchaseRoute = read("app/api/inbound/purchase-pending/route.ts");
const queryService = read(
  "quickhack_server/inventory/device-list-query-service.ts"
);

assert(
  collectionRoute.includes('export { GET } from "@/quickhack_server/api/inventory/device-list"') &&
    collectionRoute.includes('export { POST } from "@/quickhack_server/api/inventory/device"'),
  "The inventory device route must keep writes while adding the lightweight list read."
);
assert(
  !fs.existsSync(path.join(process.cwd(), "app/api/devices/route.ts")) &&
    !fs.existsSync(
      path.join(process.cwd(), "quickhack_server/api/device/devices.ts")
    ),
  "The legacy full-workspace route must be removed after the menu cutover."
);
assert(
  detailRoute.includes("DELETE, GET, PATCH"),
  "The PG route is missing the on-demand detail read."
);
assert(
  auditRoute.includes("audit-candidates") &&
    purchaseRoute.includes("purchase-pending"),
  "A menu-specific list route is missing."
);
assert(
  queryService.includes("const DEFAULT_LIMIT = 100") &&
    queryService.includes("parsed.limit + 1") &&
    queryService.includes("nextCursor"),
  "The lightweight list contract is not using bounded cursor pagination."
);
assert(
  !queryService.includes("order_items:") &&
    !queryService.includes("match_worker_allocations:") &&
    !queryService.includes("returnDecisions"),
  "The lightweight list query includes detail-only histories."
);

console.log("Device list API contract verified.");
