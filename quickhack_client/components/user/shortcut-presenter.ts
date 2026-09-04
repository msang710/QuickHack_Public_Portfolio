import {
  formatShortcutKeyCode,
  type ShortcutActionCode,
  type ShortcutModifier,
  type UserShortcutBinding,
} from "@/quickhack_shared/user/personal-settings";

export const SHORTCUT_MODIFIER_MESSAGE_KEYS = {
  NONE: "none",
  CTRL: "ctrl",
  SHIFT: "shift",
  ALT: "alt",
} as const satisfies Record<ShortcutModifier, string>;

export const SHORTCUT_ACTION_MESSAGE_KEYS = {
  NAVIGATE_MAIN: "navigateMain", NAVIGATE_INBOUND: "navigateInbound", NAVIGATE_INVENTORY: "navigateInventory", NAVIGATE_SHIPMENT: "navigateShipment", NAVIGATE_RETURNS: "navigateReturns", NAVIGATE_INVOICE: "navigateInvoice", NAVIGATE_SUPPLIES: "navigateSupplies", NAVIGATE_STATS: "navigateStats", NAVIGATE_SYSTEM_ADMIN: "navigateSystemAdmin", NAVIGATE_DEVELOPER: "navigateDeveloper",
  NAVIGATE_CURRENT_GROUP_ITEM_01: "currentItem01", NAVIGATE_CURRENT_GROUP_ITEM_02: "currentItem02", NAVIGATE_CURRENT_GROUP_ITEM_03: "currentItem03", NAVIGATE_CURRENT_GROUP_ITEM_04: "currentItem04", NAVIGATE_CURRENT_GROUP_ITEM_05: "currentItem05", NAVIGATE_CURRENT_GROUP_ITEM_06: "currentItem06", NAVIGATE_CURRENT_GROUP_ITEM_07: "currentItem07", NAVIGATE_CURRENT_GROUP_ITEM_08: "currentItem08", NAVIGATE_CURRENT_GROUP_ITEM_09: "currentItem09", NAVIGATE_CURRENT_GROUP_ITEM_10: "currentItem10", NAVIGATE_CURRENT_GROUP_ITEM_11: "currentItem11",
  FOCUS_SEARCH: "focusSearch", CLOSE_WINDOW: "closeWindow", REFRESH_LIST: "refreshList", OPEN_PERSONAL_SETTINGS: "openPersonalSettings", OPEN_SHORTCUT_GUIDE: "openShortcutGuide",
} as const satisfies Record<ShortcutActionCode, string>;

export function formatShortcutBinding(
  binding: UserShortcutBinding,
  labels: { unset: string; modifier: (modifier: ShortcutModifier) => string }
) {
  if (!binding.keyCode) {
    return labels.unset;
  }

  const keyLabel = formatShortcutKeyCode(binding.keyCode);

  return binding.modifier === "NONE"
    ? keyLabel
    : `${labels.modifier(binding.modifier)} + ${keyLabel}`;
}
