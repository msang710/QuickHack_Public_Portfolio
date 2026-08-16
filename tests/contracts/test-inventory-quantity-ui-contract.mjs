import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const ledgerView = read(
  "quickhack_client/components/inventory/inventory-quantity-ledger-view.tsx"
);
const matrixTable = read(
  "quickhack_client/components/inventory/inventory-quantity-matrix-table.tsx"
);
const detailSheet = read(
  "quickhack_client/components/inventory/inventory-quantity-detail-sheet.tsx"
);
const reconciliationDetailSheet = read(
  "quickhack_client/components/inventory/inbound-reconciliation-detail-sheet.tsx"
);
const menu = read(
  "quickhack_client/components/app-shell/device-workspace-menu.ts"
);
const workspace = read(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
const inventoryManage = read(
  "quickhack_client/components/inventory/inventory-manage-view.tsx"
);
const inventoryEdit = read(
  "quickhack_client/components/inventory/inventory-edit-view.tsx"
);
const quantityService = read(
  "quickhack_server/inventory/inventory-quantity-query-service.ts"
);
const quantityTypes = read(
  "quickhack_shared/inventory/inventory-quantity.ts"
);

assert.match(
  ledgerView,
  /\/api\/inventory\/quantity-ledger\?format=matrix/,
  "The main view must use the matrix endpoint."
);
assert.doesNotMatch(
  ledgerView,
  /movementLimit=500|TabsTrigger value="balances"|TabsTrigger value="movements"/,
  "The legacy full movement preload and tabs must be removed."
);
assert.match(
  detailSheet,
  /\/api\/inventory\/quantity-ledger\/\$\{target\.balanceId\}\/movements/,
  "Movement history must be fetched only from the selected balance sheet."
);
assert.match(
  detailSheet,
  /AbortController/,
  "Rapid detail selection must cancel stale requests."
);
assert.match(
  reconciliationDetailSheet,
  /\/api\/inventory\/inbound-reconciliation\?\$\{params\.toString\(\)\}/,
  "Inbound reconciliation details must be loaded lazily from their dedicated endpoint."
);
assert.match(
  reconciliationDetailSheet,
  /AbortController/,
  "Rapid reconciliation scope selection must cancel stale requests."
);
assert.match(
  ledgerView,
  /scope: "UNASSIGNED"[\s\S]*scope: "MISMATCHED"[\s\S]*scope: "SHORTAGE"[\s\S]*scope: "EXCESS"/,
  "All four reconciliation metrics must open their matching detail scope."
);
assert.match(
  workspace,
  /requestMenuChange\("inventory-edit"[\s\S]*setFocusedInventoryEditPgNo\(pgNo\)/,
  "PG detail navigation must use the guarded workspace menu transition."
);
assert.match(
  workspace,
  /initialPgNo=\{focusedInventoryEditPgNo\}/,
  "The inventory edit view must receive the focused PG."
);
assert.match(
  inventoryEdit,
  /initialPgNo\?: string \| null/,
  "Inventory edit must expose a one-shot initial PG contract."
);
assert.match(
  inventoryEdit,
  /devices\.find\(\s*\(device\) => device\.pgNo === normalizedInitialPgNo\s*\)/,
  "Inventory edit must resolve the exact requested PG instead of defaulting to another device."
);
assert.doesNotMatch(
  quantityService,
  /getInventoryQuantityLedger|movementLimit/,
  "The legacy full-ledger read and movement preload must be removed."
);
assert.doesNotMatch(
  quantityTypes,
  /InventoryQuantityLedgerPayload/,
  "The legacy full-ledger response DTO must be removed."
);
assert.match(
  matrixTable,
  /data-inventory-quantity-matrix="true"/,
  "The dedicated grouped matrix table must remain mounted by the main view."
);
assert.match(
  workspace,
  /selectedMenuId === "inventory-quantity-ledger"/,
  "The independent workspace menu must mount the inventory ledger view."
);
assert.doesNotMatch(
  inventoryManage,
  /TabsTrigger value="quantity"|InventoryQuantityLedgerView/,
  "Inventory add/delete must not keep a duplicate quantity-ledger tab."
);

const auditPosition = menu.indexOf('id: "inventory-audit"');
const ledgerPosition = menu.indexOf('id: "inventory-quantity-ledger"');
const editPosition = menu.indexOf('id: "inventory-edit"');
assert.ok(auditPosition >= 0 && ledgerPosition >= 0 && editPosition >= 0);
assert.ok(
  auditPosition < ledgerPosition && ledgerPosition < editPosition,
  "The inventory ledger menu must appear immediately after inventory audit."
);
assert.match(
  menu.slice(ledgerPosition, editPosition),
  /minRole: "STAFF"/,
  "The independent menu must retain STAFF access."
);

console.log("Inventory quantity UI contracts verified.");
