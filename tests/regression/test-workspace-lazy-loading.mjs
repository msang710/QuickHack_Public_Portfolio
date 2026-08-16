import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const homePage = read("app/page.tsx");
const workspace = read(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);

assert.doesNotMatch(
  homePage,
  /api\/devices|getLocalWorkspaceData|getDeviceWorkspaceData/,
  "The root page must not load the full inventory workspace after login."
);
assert.match(homePage, /<DeviceWorkspace currentUser=\{authUser\} \/>/);
assert.doesNotMatch(
  workspace,
  /DeviceWorkspaceData|workspaceDataMenuIds|requiresWorkspaceData|fetch\("\/api\/devices"/,
  "The app shell must not own or reload the legacy full inventory workspace."
);

const menuContracts = [
  [
    "quickhack_client/components/inventory/inventory-search-view.tsx",
    "/api/inventory/devices",
  ],
  [
    "quickhack_client/components/inventory/inventory-manage-view.tsx",
    "/api/inventory/devices",
  ],
  [
    "quickhack_client/components/inventory/inventory-edit-view.tsx",
    "/api/inventory/devices",
  ],
  [
    "quickhack_client/components/inventory/inventory-audit-view.tsx",
    "/api/inventory/audit-candidates",
  ],
  [
    "quickhack_client/components/inbound/purchase-pending-list-view.tsx",
    "/api/inbound/purchase-pending",
  ],
];

for (const [relativePath, endpoint] of menuContracts) {
  const source = read(relativePath);
  assert.match(
    source,
    /useDeviceListQuery/,
    `${relativePath} must own its menu-scoped list query.`
  );
  assert.ok(
    source.includes(endpoint),
    `${relativePath} must query ${endpoint}.`
  );
  assert.doesNotMatch(source, /DeviceWorkspaceData/);
}

assert.equal(existsSync(path.join(root, "app/api/devices/route.ts")), false);
assert.equal(
  existsSync(path.join(root, "quickhack_server/api/device/devices.ts")),
  false
);
assert.doesNotMatch(
  read("quickhack_server/inventory/devices-service.ts"),
  /getDeviceWorkspaceData|buildSummary/,
  "The legacy full-workspace service must be removed."
);

console.log("Workspace lazy-loading contracts verified.");
