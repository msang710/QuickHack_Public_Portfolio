import assert from "node:assert/strict";

import {
  findShortcutMenuGroup,
  getAllowedMenuGroups,
  menuGroups,
} from "../../quickhack_client/components/app-shell/device-workspace-menu.ts";

const managementGroupIds = [
  "product-management",
  "sales-channel",
  "system-admin",
];

const expectedManagementGroups = {
  "product-management": [
    "admin-product-criteria",
    "admin-sales-product-combinations",
  ],
  "sales-channel": [
    "admin-channel-products",
    "admin-channel-order-matching",
    "admin-order-matching-policy",
    "admin-sales-channel-sync-check",
  ],
  "system-admin": [
    "admin-users",
    "admin-staff-work-history",
    "admin-server-logs",
    "admin-system-status",
    "admin-security-status",
  ],
};
const expectedInvoiceItems = [
  "invoice-issue-history",
  "invoice-manual-issue",
  "invoice-registration-failures",
  "invoice-carrier-dispatch-settings",
];

function authUser(role) {
  return {
    userId: 1,
    username: role.toLowerCase(),
    displayName: role,
    role,
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };
}

function managementGroupsFor(role) {
  return getAllowedMenuGroups(authUser(role))
    .filter((group) => managementGroupIds.includes(group.id))
    .map((group) => ({
      id: group.id,
      itemIds: group.items.map((item) => item.id),
    }));
}

assert.deepEqual(
  menuGroups.slice(-5).map((group) => group.id),
  [
    "stats",
    "product-management",
    "sales-channel",
    "system-admin",
    "developer",
  ],
  "The management groups are not in the approved sidebar order."
);

for (const [groupId, expectedItemIds] of Object.entries(
  expectedManagementGroups
)) {
  const group = menuGroups.find((candidate) => candidate.id === groupId);

  assert(group, `The ${groupId} menu group is missing.`);
  assert.deepEqual(
    group.items.map((item) => item.id),
    expectedItemIds,
    `The ${groupId} menu items do not match the approved grouping.`
  );
}

const invoiceGroup = menuGroups.find((candidate) => candidate.id === "invoice");
assert(invoiceGroup, "The invoice menu group is missing.");
assert.deepEqual(
  invoiceGroup.items.map((item) => item.id),
  expectedInvoiceItems,
  "The carrier dispatch settings menu must remain the last invoice item."
);

function invoiceItemsFor(role) {
  return (
    getAllowedMenuGroups(authUser(role)).find((group) => group.id === "invoice")
      ?.items.map((item) => item.id) ?? []
  );
}

assert.deepEqual(invoiceItemsFor("VIEWER"), []);
assert.deepEqual(invoiceItemsFor("STAFF"), []);
assert.deepEqual(invoiceItemsFor("MANAGER"), expectedInvoiceItems.slice(0, 3));
assert.deepEqual(invoiceItemsFor("LEADER"), expectedInvoiceItems);

const allMenuIds = menuGroups.flatMap((group) =>
  group.items.map((item) => item.id)
);
assert.equal(
  new Set(allMenuIds).size,
  allMenuIds.length,
  "Every workspace menu id must remain unique."
);

assert.deepEqual(managementGroupsFor("VIEWER"), []);
assert.deepEqual(managementGroupsFor("STAFF"), [
  {
    id: "sales-channel",
    itemIds: ["admin-sales-channel-sync-check"],
  },
]);
assert.deepEqual(managementGroupsFor("MANAGER"), [
  {
    id: "sales-channel",
    itemIds: ["admin-sales-channel-sync-check"],
  },
]);
assert.deepEqual(managementGroupsFor("LEADER"), [
  {
    id: "product-management",
    itemIds: expectedManagementGroups["product-management"],
  },
  {
    id: "sales-channel",
    itemIds: expectedManagementGroups["sales-channel"],
  },
  {
    id: "system-admin",
    itemIds: expectedManagementGroups["system-admin"],
  },
]);

for (const [role, expectedGroupId, expectedMenuId] of [
  ["VIEWER", undefined, undefined],
  ["STAFF", "sales-channel", "admin-sales-channel-sync-check"],
  ["MANAGER", "sales-channel", "admin-sales-channel-sync-check"],
  ["LEADER", "system-admin", "admin-users"],
]) {
  const targetGroup = findShortcutMenuGroup(
    getAllowedMenuGroups(authUser(role)),
    "NAVIGATE_SYSTEM_ADMIN"
  );

  assert.equal(
    targetGroup?.id,
    expectedGroupId,
    `${role} has the wrong Shift+F9 target group.`
  );
  assert.equal(
    targetGroup?.items[0]?.id,
    expectedMenuId,
    `${role} has the wrong Shift+F9 target menu.`
  );
}

console.log("Workspace menu structure and shortcut compatibility verified.");
