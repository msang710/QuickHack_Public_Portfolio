import type { MessageShape } from "@/quickhack_shared/i18n/message-contract";
import type { NavigationMessages } from "../ko/navigation.ts";

export const navigationEn = {
  "groups": {
    "main": {
      "label": "Main",
    },
    "inbound": {
      "label": "Inbound",
    },
    "inventory": {
      "label": "Inventory",
    },
    "shipment": {
      "label": "Shipment",
    },
    "returns": {
      "label": "Returns",
    },
    "invoice": {
      "label": "Invoices",
    },
    "supplies": {
      "label": "Supplies",
    },
    "stats": {
      "label": "Statistics",
    },
    "product-management": {
      "label": "Product management",
    },
    "sales-channel": {
      "label": "Sales channels",
    },
    "system-admin": {
      "label": "System administration",
    },
    "developer": {
      "label": "Developer",
    },
  },
  "items": {
    "dashboard": {
      "label": "Dashboard",
      "description": "View the overall operational status.",
    },
    "inbound-appearance": {
      "label": "Appearance inspection",
      "description": "Open the Appearance inspection workspace.",
    },
    "inbound-function": {
      "label": "Functional inspection",
      "description": "Open the Functional inspection workspace.",
    },
    "inbound-upload-pending": {
      "label": "Pending uploads",
      "description": "Open the Pending uploads workspace.",
    },
    "inbound-batch": {
      "label": "Assign inbound batch",
      "description": "Open the Assign inbound batch workspace.",
    },
    "inbound-purchase-price": {
      "label": "Set purchase price",
      "description": "Open the Set purchase price workspace.",
    },
    "inbound-purchase-pending": {
      "label": "Pending purchases",
      "description": "Open the Pending purchases workspace.",
    },
    "inventory-search": {
      "label": "Inventory search",
      "description": "Open the Inventory search workspace.",
    },
    "inventory-audit": {
      "label": "Inventory audit",
      "description": "Open the Inventory audit workspace.",
    },
    "inventory-quantity-ledger": {
      "label": "Inventory quantity ledger",
      "description": "Open the Inventory quantity ledger workspace.",
    },
    "inventory-edit": {
      "label": "Edit existing inventory",
      "description": "Open the Edit existing inventory workspace.",
    },
    "inventory-manage": {
      "label": "Add or remove inventory",
      "description": "Open the Add or remove inventory workspace.",
    },
    "shipment-all-orders": {
      "label": "Order matching work queue",
      "description": "Open the Order matching work queue workspace.",
    },
    "shipment-matched": {
      "label": "Matched orders",
      "description": "Open the Matched orders workspace.",
    },
    "shipment-delivery-changes": {
      "label": "Delivery information changes",
      "description": "Open the Delivery information changes workspace.",
    },
    "shipment-today": {
      "label": "Today's shipments",
      "description": "Open the Today's shipments workspace.",
    },
    "shipment-in-transit": {
      "label": "Shipments in transit",
      "description": "Open the Shipments in transit workspace.",
    },
    "shipment-delivery-search": {
      "label": "Search all deliveries",
      "description": "Open the Search all deliveries workspace.",
    },
    "return-before-shipment": {
      "label": "Pre-shipment returns",
      "description": "Open the Pre-shipment returns workspace.",
    },
    "return-after-shipment": {
      "label": "Post-shipment returns",
      "description": "Open the Post-shipment returns workspace.",
    },
    "invoice-issue-history": {
      "label": "Invoice issue history",
      "description": "Open the Invoice issue history workspace.",
    },
    "invoice-manual-issue": {
      "label": "Issue invoice manually",
      "description": "Open the Issue invoice manually workspace.",
    },
    "invoice-registration-failures": {
      "label": "Invoice registration failures",
      "description": "Open the Invoice registration failures workspace.",
    },
    "invoice-carrier-dispatch-settings": {
      "label": "Carrier dispatch settings",
      "description": "Open the Carrier dispatch settings workspace.",
    },
    "supplies-inventory": {
      "label": "Supply inventory",
      "description": "Open the Supply inventory workspace.",
    },
    "supplies-forecast": {
      "label": "Supply forecast",
      "description": "Open the Supply forecast workspace.",
    },
    "supplies-repurchase": {
      "label": "Repurchase supplies",
      "description": "Open the Repurchase supplies workspace.",
    },
    "statistics-purchase": {
      "label": "Purchasing",
      "description": "Open the Purchasing workspace.",
    },
    "statistics-inventory": {
      "label": "Inventory",
      "description": "Open the Inventory workspace.",
    },
    "statistics-sales": {
      "label": "Sales",
      "description": "Open the Sales workspace.",
    },
    "statistics-returns": {
      "label": "Returns",
      "description": "Open the Returns workspace.",
    },
    "admin-product-criteria": {
      "label": "Product criteria",
      "description": "Open the Product criteria workspace.",
    },
    "admin-sales-product-combinations": {
      "label": "Sales product combinations",
      "description": "Open the Sales product combinations workspace.",
    },
    "admin-channel-products": {
      "label": "Channel products",
      "description": "Open the Channel products workspace.",
    },
    "sales-channel-manual-order-match": {
      "label": "Order change requests",
      "description": "Open the Order change requests workspace.",
    },
    "admin-channel-order-matching": {
      "label": "Channel order matching",
      "description": "Open the Channel order matching workspace.",
    },
    "admin-order-matching-policy": {
      "label": "Order matching policy",
      "description": "Open the Order matching policy workspace.",
    },
    "admin-sales-channel-sync-check": {
      "label": "Sales channel sync checks",
      "description": "Open the Sales channel sync checks workspace.",
    },
    "admin-users": {
      "label": "User accounts",
      "description": "Open the User accounts workspace.",
    },
    "admin-staff-work-history": {
      "label": "Staff activity history",
      "description": "Open the Staff activity history workspace.",
    },
    "admin-server-logs": {
      "label": "Server job logs",
      "description": "Open the Server job logs workspace.",
    },
    "admin-system-status": {
      "label": "System status",
      "description": "Open the System status workspace.",
    },
    "admin-security-status": {
      "label": "Security status",
      "description": "Open the Security status workspace.",
    },
    "developer-diagnostics": {
      "label": "Developer diagnostics",
      "description": "Open the Developer diagnostics workspace.",
    },
    "developer-response-performance": {
      "label": "Response performance",
      "description": "Open the Response performance workspace.",
    },
    "developer-api-sandbox": {
      "label": "API sandbox",
      "description": "Open the API sandbox workspace.",
    },
    "developer-adb-diagnostics": {
      "label": "ADB diagnostics",
      "description": "Open the ADB diagnostics workspace.",
    },
    "developer-db-migrations": {
      "label": "Database and migration checks",
      "description": "Open the Database and migration checks workspace.",
    },
    "personal-settings": {
      "label": "Personal settings",
      "description": "Open the Personal settings workspace.",
    },
  },
  "personalSettings": "Personal settings",
  "shortcutGuide": "Keyboard shortcuts",
  "workspace": {
    "dashboard": { "match": "Matched", "shortage": "Short by {count, number}", "excess": "Over by {count, number}", "batch": "{date} · Batch {batch, number}", "batchSummary": "Expected {expected, number} · Linked {linked, number} · Inspected today {inspected, number}", "normalInbound": "Normal inbound target", "supplierReturn": "Supplier returns", "arrivalDifference": "Arrival difference", "appearanceComplete": "Appearance inspection complete", "functionComplete": "Function inspection complete", "purchasePending": "Pending purchase", "loadFailed": "Could not load dashboard statistics.", "expectedToday": "Expected today", "currentlyLinked": "Currently linked", "loading": "Loading today's inspection progress by batch.", "title": "Today's inspection progress by batch", "basis": "As of {date} · Progress against expected quantity by batch", "empty": "No inbound batches are registered today." },
    "pending": "Screen pending implementation",
    "roles": { "viewer": "View only", "staff": "Staff", "manager": "Manager", "leader": "Leader" },
    "forms": { "account": "Account information", "preferences": "Shortcuts and notifications" },
    "account": { "loading": "Loading account information.", "role": "Role", "developer": "Developer", "contact": "Contact", "employment": "Employment", "birthday": "Birthday {date}", "hireDate": "Joined {date}", "security": "Security", "otpEnabled": "OTP configured", "otpDisabled": "OTP not configured", "recoveryCodes": "{count, plural, one {# recovery code} other {# recovery codes}}", "mobile": "Mobile", "packingAllowed": "Packing inspection app allowed", "packingDenied": "Packing inspection app not allowed", "registeredDevices": "{count, plural, one {# registered device} other {# registered devices}}", "created": "Account created", "updated": "Last updated", "personalSettings": "Personal settings", "active": "Active", "inactive": "Inactive", "loadFailed": "Could not load account information." },
    "header": { "birthday": "Happy birthday!", "account": "Account information", "refreshTitle": "Reload the current screen from the beginning", "refreshing": "Refreshing", "refresh": "Refresh", "listRefresh": "Refresh list", "logout": "Log out" },
    "area": { "account": "Account", "menu": "Menu" }, "sidebar": { "expand": "Expand menu", "collapse": "Collapse menu" },
    "message": { "logoutFailed": "Could not log out.", "windowCloseBlocked": "The browser blocked closing this window. Try again from the QuickHack client window.", "workflowBlocked": "This workflow cannot be started.", "workflowCheckFailed": "Could not check workflow admission.", "accountSaveFailed": "Could not save account information.", "accountRefreshDeferred": "Refreshing account information was deferred.", "accountVerifyFailed": "Could not verify the saved account information.", "accountSaved": "Account information was saved.", "accountSavedRefresh": "{message} Refresh the screen to verify the latest security state.", "notificationPermissionDenied": "Settings were not saved because desktop notification permission was not granted.", "preferencesSaveFailed": "Could not save personal settings.", "preferencesSaved": "Personal settings were saved." }
  }
} as const satisfies MessageShape<NavigationMessages>;
