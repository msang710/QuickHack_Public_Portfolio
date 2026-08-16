import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../support/postgresql-test-scope.mjs";

function source(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

const writeRoutes = [
  "quickhack_server/api/inventory/device.ts",
  "quickhack_server/api/inventory/bulk-correction.ts",
  "quickhack_server/api/inventory/audit.ts",
  "quickhack_server/api/inbound/purchase-confirm.ts",
];

for (const route of writeRoutes) {
  assert.doesNotMatch(
    source(route),
    /getDeviceWorkspaceData|WORKSPACE_RELOAD/
  );
}

const bulkServiceSource = source(
  "quickhack_server/inventory/inventory-correction-command-service.ts"
);
assert.match(
  bulkServiceSource,
  /export async function updateExistingInventoryRecordsAtomically/
);
assert.match(bulkServiceSource, /"inventory\.correction\.bulk"/);
assert.match(
  source("quickhack_server/api/inventory/bulk-correction.ts"),
  /updateExistingInventoryRecordsAtomically/
);

const writeViews = [
  "quickhack_client/components/inventory/inventory-edit-view.tsx",
  "quickhack_client/components/inventory/inventory-manage-view.tsx",
  "quickhack_client/components/inventory/inventory-audit-view.tsx",
  "quickhack_client/components/inbound/purchase-pending-list-view.tsx",
];

for (const view of writeViews) {
  const viewSource = source(view);
  assert.match(viewSource, /POST_WRITE_REFRESH_WARNING/);
  assert.doesNotMatch(viewSource, /!payload\.data|!confirmPayload\.data/);
  assert.match(
    viewSource,
    /deviceList\.reload\(\)/,
    `${view} must refresh only its own menu list after a committed write.`
  );
}

const workspaceSource = source(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
assert.doesNotMatch(
  workspaceSource,
  /refreshWorkspaceAfterCommittedWrite|requestStartedBeforeCommit|onSaved=|onConfirmed=/,
  "The app shell must not coordinate inventory write refreshes."
);

assert.match(
  source("quickhack_client/components/inventory/inventory-edit-view.tsx"),
  /originalRecords=\{baselineRecords\}/
);

console.log("Inventory write response contract verified.");
