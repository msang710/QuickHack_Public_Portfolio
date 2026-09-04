// QuickHack note: 메인 ERP/WMS 좌측 메뉴의 항목, 권한, 아이콘 구성을 정의합니다.
import type * as React from "react";
import {
  BadgeDollarSign,
  BarChart3,
  CheckCheck,
  ClipboardCheck,
  ClipboardList,
  Code2,
  Database,
  FileDown,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Menu,
  PackageCheck,
  PackagePlus,
  PanelRightOpen,
  PencilLine,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  ServerCog,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Store,
  TerminalSquare,
  Truck,
  UsersRound,
  Warehouse,
  Wrench,
} from "lucide-react";
import {
  canAccessDeveloper,
  canAccessRole,
  type AuthUser,
  type Role,
} from "@/quickhack_shared/auth/auth-constants";
import type { ShortcutActionCode } from "@/quickhack_shared/user/personal-settings";

export type MenuItemId =
  | "dashboard"
  | "personal-settings"
  | "inbound-appearance"
  | "inbound-function"
  | "inbound-upload-pending"
  | "inbound-batch"
  | "inbound-purchase-price"
  | "inbound-purchase-pending"
  | "inventory-search"
  | "inventory-audit"
  | "inventory-quantity-ledger"
  | "inventory-edit"
  | "inventory-manage"
  | "supplies-inventory"
  | "supplies-forecast"
  | "supplies-repurchase"
  | "shipment-all-orders"
  | "shipment-delivery-changes"
  | "shipment-matched"
  | "shipment-today"
  | "shipment-in-transit"
  | "shipment-delivery-search"
  | "return-before-shipment"
  | "return-after-shipment"
  | "invoice-issue-history"
  | "invoice-manual-issue"
  | "invoice-registration-failures"
  | "invoice-carrier-dispatch-settings"
  | "statistics-purchase"
  | "statistics-inventory"
  | "statistics-sales"
  | "statistics-returns"
  | "admin-users"
  | "admin-product-criteria"
  | "admin-sales-product-combinations"
  | "admin-channel-products"
  | "admin-channel-order-matching"
  | "sales-channel-manual-order-match"
  | "admin-order-matching-policy"
  | "admin-staff-work-history"
  | "admin-server-logs"
  | "admin-sales-channel-sync-check"
  | "admin-system-status"
  | "developer-response-performance"
  | "admin-security-status"
  | "developer-diagnostics"
  | "developer-api-sandbox"
  | "developer-adb-diagnostics"
  | "developer-db-migrations";

export type MenuIcon = React.ComponentType<{ className?: string }>;

export type MenuGroupId =
  | "main"
  | "inbound"
  | "inventory"
  | "shipment"
  | "returns"
  | "invoice"
  | "supplies"
  | "stats"
  | "product-management"
  | "sales-channel"
  | "system-admin"
  | "developer";

// QuickHack object: 권한, 아이콘, 설명을 포함한 좌측 메뉴 한 항목의 구조입니다.
export type MenuItem = {
  id: MenuItemId;
  label: string;
  minRole: Role;
  icon: MenuIcon;
  description: string;
  developerOnly?: boolean;
};

// QuickHack object: 좌측 메뉴를 업무 영역별로 묶는 그룹 구조입니다.
export type MenuGroup = {
  id: MenuGroupId;
  label: string;
  icon: MenuIcon;
  items: MenuItem[];
};

// Function keys stay attached to business areas even when permissions hide some menus.
export const menuShortcutActions = [
  { actionCode: "NAVIGATE_MAIN", groupIds: ["main"] },
  { actionCode: "NAVIGATE_INBOUND", groupIds: ["inbound"] },
  { actionCode: "NAVIGATE_INVENTORY", groupIds: ["inventory"] },
  { actionCode: "NAVIGATE_SHIPMENT", groupIds: ["shipment"] },
  { actionCode: "NAVIGATE_RETURNS", groupIds: ["returns"] },
  { actionCode: "NAVIGATE_INVOICE", groupIds: ["invoice"] },
  { actionCode: "NAVIGATE_SUPPLIES", groupIds: ["supplies"] },
  { actionCode: "NAVIGATE_STATS", groupIds: ["stats"] },
  {
    actionCode: "NAVIGATE_SYSTEM_ADMIN",
    // Preserve the historical Shift+F9 destination after the admin menu split.
    groupIds: ["system-admin", "product-management", "sales-channel"],
  },
  { actionCode: "NAVIGATE_DEVELOPER", groupIds: ["developer"] },
] as const satisfies ReadonlyArray<{
  actionCode: ShortcutActionCode;
  groupIds: readonly MenuGroupId[];
}>;

export function findShortcutMenuGroup(
  groups: readonly MenuGroup[],
  actionCode: ShortcutActionCode
) {
  const shortcut = menuShortcutActions.find(
    (candidate) => candidate.actionCode === actionCode
  );

  if (!shortcut) {
    return undefined;
  }

  for (const groupId of shortcut.groupIds) {
    const group = groups.find((candidate) => candidate.id === groupId);

    if (group) {
      return group;
    }
  }

  return undefined;
}

// QuickHack object: 입고/재고/출고/시스템 관리/개발자 메뉴의 전체 구성을 정의합니다.
export const menuGroups: MenuGroup[] = [
  {
    id: "main",
    label: "groups.main.label",
    icon: Menu,
    items: [
      {
        id: "dashboard",
        label: "items.dashboard.label",
        minRole: "VIEWER",
        icon: LayoutDashboard,
        description: "items.dashboard.description",
      },
    ],
  },
  {
    id: "inbound",
    label: "groups.inbound.label",
    icon: PackagePlus,
    items: [
      {
        id: "inbound-appearance",
        label: "items.inbound-appearance.label",
        minRole: "STAFF",
        icon: ClipboardCheck,
        description: "items.inbound-appearance.description",
      },
      {
        id: "inbound-function",
        label: "items.inbound-function.label",
        minRole: "STAFF",
        icon: Wrench,
        description: "items.inbound-function.description",
      },
      {
        id: "inbound-upload-pending",
        label: "items.inbound-upload-pending.label",
        minRole: "STAFF",
        icon: ListChecks,
        description: "items.inbound-upload-pending.description",
      },
      {
        id: "inbound-batch",
        label: "items.inbound-batch.label",
        minRole: "STAFF",
        icon: ClipboardList,
        description: "items.inbound-batch.description",
      },
      {
        id: "inbound-purchase-price",
        label: "items.inbound-purchase-price.label",
        minRole: "MANAGER",
        icon: BadgeDollarSign,
        description: "items.inbound-purchase-price.description",
      },
      {
        id: "inbound-purchase-pending",
        label: "items.inbound-purchase-pending.label",
        minRole: "MANAGER",
        icon: FileDown,
        description: "items.inbound-purchase-pending.description",
      },
    ],
  },
  {
    id: "inventory",
    label: "groups.inventory.label",
    icon: Warehouse,
    items: [
      {
        id: "inventory-search",
        label: "items.inventory-search.label",
        minRole: "VIEWER",
        icon: Search,
        description: "items.inventory-search.description",
      },
      {
        id: "inventory-audit",
        label: "items.inventory-audit.label",
        minRole: "STAFF",
        icon: ListChecks,
        description: "items.inventory-audit.description",
      },
      {
        id: "inventory-quantity-ledger",
        label: "items.inventory-quantity-ledger.label",
        minRole: "STAFF",
        icon: ScrollText,
        description: "items.inventory-quantity-ledger.description",
      },
      {
        id: "inventory-edit",
        label: "items.inventory-edit.label",
        minRole: "MANAGER",
        icon: PencilLine,
        description: "items.inventory-edit.description",
      },
      {
        id: "inventory-manage",
        label: "items.inventory-manage.label",
        minRole: "MANAGER",
        icon: PackageCheck,
        description: "items.inventory-manage.description",
      },
    ],
  },
  {
    id: "shipment",
    label: "groups.shipment.label",
    icon: Truck,
    items: [
      {
        id: "shipment-all-orders",
        label: "items.shipment-all-orders.label",
        minRole: "MANAGER",
        icon: ClipboardList,
        description: "items.shipment-all-orders.description",
      },
      {
        id: "shipment-matched",
        label: "items.shipment-matched.label",
        minRole: "STAFF",
        icon: CheckCheck,
        description: "items.shipment-matched.description",
      },
      {
        id: "shipment-delivery-changes",
        label: "items.shipment-delivery-changes.label",
        minRole: "MANAGER",
        icon: PanelRightOpen,
        description: "items.shipment-delivery-changes.description",
      },
      {
        id: "shipment-today",
        label: "items.shipment-today.label",
        minRole: "STAFF",
        icon: Send,
        description: "items.shipment-today.description",
      },
      {
        id: "shipment-in-transit",
        label: "items.shipment-in-transit.label",
        minRole: "STAFF",
        icon: Truck,
        description: "items.shipment-in-transit.description",
      },
      {
        id: "shipment-delivery-search",
        label: "items.shipment-delivery-search.label",
        minRole: "STAFF",
        icon: Search,
        description: "items.shipment-delivery-search.description",
      },
    ],
  },
  {
    id: "returns",
    label: "groups.returns.label",
    icon: RotateCcw,
    items: [
      {
        id: "return-before-shipment",
        label: "items.return-before-shipment.label",
        minRole: "STAFF",
        icon: ClipboardList,
        description: "items.return-before-shipment.description",
      },
      {
        id: "return-after-shipment",
        label: "items.return-after-shipment.label",
        minRole: "STAFF",
        icon: RotateCcw,
        description: "items.return-after-shipment.description",
      },
    ],
  },
  {
    id: "invoice",
    label: "groups.invoice.label",
    icon: Send,
    items: [
      {
        id: "invoice-issue-history",
        label: "items.invoice-issue-history.label",
        minRole: "MANAGER",
        icon: ScrollText,
        description: "items.invoice-issue-history.description",
      },
      {
        id: "invoice-manual-issue",
        label: "items.invoice-manual-issue.label",
        minRole: "MANAGER",
        icon: PencilLine,
        description: "items.invoice-manual-issue.description",
      },
      {
        id: "invoice-registration-failures",
        label: "items.invoice-registration-failures.label",
        minRole: "MANAGER",
        icon: ListChecks,
        description: "items.invoice-registration-failures.description",
      },
      {
        id: "invoice-carrier-dispatch-settings",
        label: "items.invoice-carrier-dispatch-settings.label",
        minRole: "LEADER",
        icon: Truck,
        description: "items.invoice-carrier-dispatch-settings.description",
      },
    ],
  },
  {
    id: "supplies",
    label: "groups.supplies.label",
    icon: PackageCheck,
    items: [
      {
        id: "supplies-inventory",
        label: "items.supplies-inventory.label",
        minRole: "STAFF",
        icon: PackageCheck,
        description: "items.supplies-inventory.description",
      },
      {
        id: "supplies-forecast",
        label: "items.supplies-forecast.label",
        minRole: "STAFF",
        icon: BarChart3,
        description: "items.supplies-forecast.description",
      },
      {
        id: "supplies-repurchase",
        label: "items.supplies-repurchase.label",
        minRole: "STAFF",
        icon: BadgeDollarSign,
        description: "items.supplies-repurchase.description",
      },
    ],
  },
  {
    id: "stats",
    label: "groups.stats.label",
    icon: BarChart3,
    items: [
      {
        id: "statistics-purchase",
        label: "items.statistics-purchase.label",
        minRole: "LEADER",
        icon: BadgeDollarSign,
        description: "items.statistics-purchase.description",
      },
      {
        id: "statistics-inventory",
        label: "items.statistics-inventory.label",
        minRole: "LEADER",
        icon: Warehouse,
        description: "items.statistics-inventory.description",
      },
      {
        id: "statistics-sales",
        label: "items.statistics-sales.label",
        minRole: "LEADER",
        icon: Store,
        description: "items.statistics-sales.description",
      },
      {
        id: "statistics-returns",
        label: "items.statistics-returns.label",
        minRole: "LEADER",
        icon: RotateCcw,
        description: "items.statistics-returns.description",
      },
    ],
  },
  {
    id: "product-management",
    label: "groups.product-management.label",
    icon: Database,
    items: [
      {
        id: "admin-product-criteria",
        label: "items.admin-product-criteria.label",
        minRole: "LEADER",
        icon: Database,
        description: "items.admin-product-criteria.description",
      },
      {
        id: "admin-sales-product-combinations",
        label: "items.admin-sales-product-combinations.label",
        minRole: "LEADER",
        icon: Store,
        description: "items.admin-sales-product-combinations.description",
      },
    ],
  },
  {
    id: "sales-channel",
    label: "groups.sales-channel.label",
    icon: Store,
    items: [
      {
        id: "admin-channel-products",
        label: "items.admin-channel-products.label",
        minRole: "LEADER",
        icon: Store,
        description: "items.admin-channel-products.description",
      },
      {
        id: "sales-channel-manual-order-match",
        label: "items.sales-channel-manual-order-match.label",
        minRole: "STAFF",
        icon: PencilLine,
        description: "items.sales-channel-manual-order-match.description",
      },
      {
        id: "admin-channel-order-matching",
        label: "items.admin-channel-order-matching.label",
        minRole: "LEADER",
        icon: ListChecks,
        description: "items.admin-channel-order-matching.description",
      },
      {
        id: "admin-order-matching-policy",
        label: "items.admin-order-matching-policy.label",
        minRole: "LEADER",
        icon: ShieldCheck,
        description: "items.admin-order-matching-policy.description",
      },
      {
        id: "admin-sales-channel-sync-check",
        label: "items.admin-sales-channel-sync-check.label",
        minRole: "STAFF",
        icon: ShieldAlert,
        description: "items.admin-sales-channel-sync-check.description",
      },
    ],
  },
  {
    id: "system-admin",
    label: "groups.system-admin.label",
    icon: Settings,
    items: [
      {
        id: "admin-users",
        label: "items.admin-users.label",
        minRole: "LEADER",
        icon: UsersRound,
        description: "items.admin-users.description",
      },
      {
        id: "admin-staff-work-history",
        label: "items.admin-staff-work-history.label",
        minRole: "LEADER",
        icon: ClipboardList,
        description: "items.admin-staff-work-history.description",
      },
      {
        id: "admin-server-logs",
        label: "items.admin-server-logs.label",
        minRole: "LEADER",
        icon: ScrollText,
        description: "items.admin-server-logs.description",
      },
      {
        id: "admin-system-status",
        label: "items.admin-system-status.label",
        minRole: "LEADER",
        icon: ServerCog,
        description: "items.admin-system-status.description",
      },
      {
        id: "admin-security-status",
        label: "items.admin-security-status.label",
        minRole: "LEADER",
        icon: ShieldCheck,
        description: "items.admin-security-status.description",
      },
    ],
  },
  {
    id: "developer",
    label: "groups.developer.label",
    icon: Code2,
    items: [
      {
        id: "developer-diagnostics",
        label: "items.developer-diagnostics.label",
        minRole: "VIEWER",
        developerOnly: true,
        icon: TerminalSquare,
        description: "items.developer-diagnostics.description",
      },
      {
        id: "developer-response-performance",
        label: "items.developer-response-performance.label",
        minRole: "VIEWER",
        developerOnly: true,
        icon: Gauge,
        description: "items.developer-response-performance.description",
      },
      {
        id: "developer-api-sandbox",
        label: "items.developer-api-sandbox.label",
        minRole: "VIEWER",
        developerOnly: true,
        icon: ServerCog,
        description: "items.developer-api-sandbox.description",
      },
      {
        id: "developer-adb-diagnostics",
        label: "items.developer-adb-diagnostics.label",
        minRole: "VIEWER",
        developerOnly: true,
        icon: Wrench,
        description: "items.developer-adb-diagnostics.description",
      },
      {
        id: "developer-db-migrations",
        label: "items.developer-db-migrations.label",
        minRole: "VIEWER",
        developerOnly: true,
        icon: Database,
        description: "items.developer-db-migrations.description",
      },
    ],
  },
];

export function localizeMenuGroups(translate: (key: string) => string) {
  return menuGroups.map((group) => ({
    ...group,
    label: translate(group.label),
    items: group.items.map((item) => ({
      ...item,
      label: translate(item.label),
      description: translate(item.description),
    })),
  }));
}

const menuTextOverrides: Partial<
  Record<MenuItemId, Pick<MenuItem, "label" | "description">>
> = {
  "return-before-shipment": {
    label: "items.return-before-shipment.label",
    description: "items.return-before-shipment.description",
  },
  "return-after-shipment": {
    label: "items.return-after-shipment.label",
    description: "items.return-after-shipment.description",
  },
};

for (const group of menuGroups) {
  for (const item of group.items) {
    const override = menuTextOverrides[item.id];

    if (override) {
      Object.assign(item, override);
    }
  }
}

export const sensitiveMenuIds = new Set<MenuItemId>([
  "inventory-edit",
  "inventory-manage",
  "admin-channel-products",
  "admin-channel-order-matching",
  "admin-order-matching-policy",
]);

const utilityMenuItems: MenuItem[] = [
  {
    id: "personal-settings",
    label: "items.personal-settings.label",
    minRole: "VIEWER",
    icon: Settings,
    description: "items.personal-settings.description",
  },
];

export function canAccessMenuItem(user: AuthUser, item: MenuItem) {
  if (item.developerOnly && !canAccessDeveloper(user)) {
    return false;
  }

  return canAccessRole(user.role, item.minRole);
}

export function findMenuItem(
  id: MenuItemId,
  groups: readonly MenuGroup[] = menuGroups,
  translate?: (key: string) => string
) {
  const utilityItem = utilityMenuItems.find((item) => item.id === id);

  if (utilityItem) {
    return translate
      ? {
          ...utilityItem,
          label: translate(utilityItem.label),
          description: translate(utilityItem.description),
        }
      : utilityItem;
  }

  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.id === id);

    if (item) {
      return item;
    }
  }

  return groups[0]?.items[0] ?? menuGroups[0].items[0];
}

export function getAllowedMenuGroups(
  user: AuthUser,
  groups: readonly MenuGroup[] = menuGroups
) {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessMenuItem(user, item)),
    }))
    .filter((group) => group.items.length > 0);
}
