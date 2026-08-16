export type UserPreferences = {
  keyboardShortcutsEnabled: boolean;
  windowsNotificationsEnabled: boolean;
  inspectionCompleteNotificationEnabled: boolean;
  shipmentChangeNotificationEnabled: boolean;
  returnNotificationEnabled: boolean;
};

export type UserPreferenceKey = keyof UserPreferences;

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  keyboardShortcutsEnabled: true,
  windowsNotificationsEnabled: false,
  inspectionCompleteNotificationEnabled: true,
  shipmentChangeNotificationEnabled: true,
  returnNotificationEnabled: true,
};

export const USER_PREFERENCE_KEYS = Object.keys(
  DEFAULT_USER_PREFERENCES
) as UserPreferenceKey[];

export const SHORTCUT_MODIFIERS = ["NONE", "CTRL", "SHIFT", "ALT"] as const;
export type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number];

export const SHORTCUT_ACTION_DEFINITIONS = [
  {
    actionCode: "NAVIGATE_MAIN",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F1",
  },
  {
    actionCode: "NAVIGATE_INBOUND",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F2",
  },
  {
    actionCode: "NAVIGATE_INVENTORY",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F3",
  },
  {
    actionCode: "NAVIGATE_SHIPMENT",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F4",
  },
  {
    actionCode: "NAVIGATE_RETURNS",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F5",
  },
  {
    actionCode: "NAVIGATE_INVOICE",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F6",
  },
  {
    actionCode: "NAVIGATE_SUPPLIES",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F7",
  },
  {
    actionCode: "NAVIGATE_STATS",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F8",
  },
  {
    actionCode: "NAVIGATE_SYSTEM_ADMIN",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F9",
  },
  {
    actionCode: "NAVIGATE_DEVELOPER",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F10",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_01",
    defaultModifier: "NONE",
    defaultKeyCode: "F1",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_02",
    defaultModifier: "NONE",
    defaultKeyCode: "F2",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_03",
    defaultModifier: "NONE",
    defaultKeyCode: "F3",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_04",
    defaultModifier: "NONE",
    defaultKeyCode: "F4",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_05",
    defaultModifier: "NONE",
    defaultKeyCode: "F5",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_06",
    defaultModifier: "NONE",
    defaultKeyCode: "F6",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_07",
    defaultModifier: "NONE",
    defaultKeyCode: "F7",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_08",
    defaultModifier: "NONE",
    defaultKeyCode: "F8",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_09",
    defaultModifier: "NONE",
    defaultKeyCode: "F9",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_10",
    defaultModifier: "NONE",
    defaultKeyCode: "F10",
  },
  {
    actionCode: "NAVIGATE_CURRENT_GROUP_ITEM_11",
    defaultModifier: "NONE",
    defaultKeyCode: "F11",
  },
  {
    actionCode: "FOCUS_SEARCH",
    defaultModifier: "CTRL",
    defaultKeyCode: "KeyF",
  },
  {
    actionCode: "CLOSE_WINDOW",
    defaultModifier: "NONE",
    defaultKeyCode: "Escape",
  },
  {
    actionCode: "REFRESH_LIST",
    defaultModifier: "ALT",
    defaultKeyCode: "KeyR",
  },
  {
    actionCode: "OPEN_PERSONAL_SETTINGS",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F11",
  },
  {
    actionCode: "OPEN_SHORTCUT_GUIDE",
    defaultModifier: "SHIFT",
    defaultKeyCode: "F12",
  },
] as const satisfies ReadonlyArray<{
  actionCode: string;
  defaultModifier: ShortcutModifier;
  defaultKeyCode: string;
}>;

export type ShortcutActionCode =
  (typeof SHORTCUT_ACTION_DEFINITIONS)[number]["actionCode"];

export const TOP_LEVEL_SHORTCUT_ACTION_CODES = [
  "NAVIGATE_MAIN",
  "NAVIGATE_INBOUND",
  "NAVIGATE_INVENTORY",
  "NAVIGATE_SHIPMENT",
  "NAVIGATE_RETURNS",
  "NAVIGATE_INVOICE",
  "NAVIGATE_SUPPLIES",
  "NAVIGATE_STATS",
  "NAVIGATE_SYSTEM_ADMIN",
  "NAVIGATE_DEVELOPER",
] as const satisfies ReadonlyArray<ShortcutActionCode>;

export const CURRENT_GROUP_SHORTCUT_ACTION_CODES = [
  "NAVIGATE_CURRENT_GROUP_ITEM_01",
  "NAVIGATE_CURRENT_GROUP_ITEM_02",
  "NAVIGATE_CURRENT_GROUP_ITEM_03",
  "NAVIGATE_CURRENT_GROUP_ITEM_04",
  "NAVIGATE_CURRENT_GROUP_ITEM_05",
  "NAVIGATE_CURRENT_GROUP_ITEM_06",
  "NAVIGATE_CURRENT_GROUP_ITEM_07",
  "NAVIGATE_CURRENT_GROUP_ITEM_08",
  "NAVIGATE_CURRENT_GROUP_ITEM_09",
  "NAVIGATE_CURRENT_GROUP_ITEM_10",
  "NAVIGATE_CURRENT_GROUP_ITEM_11",
] as const satisfies ReadonlyArray<ShortcutActionCode>;

export const COMMON_SHORTCUT_ACTION_CODES = [
  "CLOSE_WINDOW",
  "REFRESH_LIST",
  "OPEN_PERSONAL_SETTINGS",
  "OPEN_SHORTCUT_GUIDE",
  "FOCUS_SEARCH",
] as const satisfies ReadonlyArray<ShortcutActionCode>;

export type CurrentGroupShortcutActionCode =
  (typeof CURRENT_GROUP_SHORTCUT_ACTION_CODES)[number];

export type UserShortcutBinding = {
  actionCode: ShortcutActionCode;
  modifier: ShortcutModifier;
  keyCode: string | null;
};

export type PersonalSettings = {
  revision: number;
  preferences: UserPreferences;
  shortcutBindings: UserShortcutBinding[];
};

export const SHORTCUT_ACTION_CODES = SHORTCUT_ACTION_DEFINITIONS.map(
  (definition) => definition.actionCode
) as ShortcutActionCode[];

export const DEFAULT_USER_SHORTCUT_BINDINGS: UserShortcutBinding[] =
  SHORTCUT_ACTION_DEFINITIONS.map((definition) => ({
    actionCode: definition.actionCode,
    modifier: definition.defaultModifier,
    keyCode: definition.defaultKeyCode,
  }));

const SUPPORTED_NAMED_KEY_CODES = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "Space",
]);

const RESERVED_SHORTCUTS = new Set([
  "ALT:F4",
  "CTRL:KeyL",
  "CTRL:KeyN",
  "CTRL:KeyR",
  "CTRL:KeyT",
  "CTRL:KeyW",
]);

export function clonePersonalSettings(settings: PersonalSettings): PersonalSettings {
  return {
    revision: settings.revision,
    preferences: { ...settings.preferences },
    shortcutBindings: settings.shortcutBindings.map((binding) => ({
      ...binding,
    })),
  };
}

export function createDefaultPersonalSettings(): PersonalSettings {
  return {
    revision: 0,
    preferences: { ...DEFAULT_USER_PREFERENCES },
    shortcutBindings: DEFAULT_USER_SHORTCUT_BINDINGS.map((binding) => ({
      ...binding,
    })),
  };
}

export function isShortcutActionCode(value: unknown): value is ShortcutActionCode {
  return (
    typeof value === "string" &&
    SHORTCUT_ACTION_CODES.includes(value as ShortcutActionCode)
  );
}

export function currentGroupShortcutIndex(
  actionCode: ShortcutActionCode
) {
  return CURRENT_GROUP_SHORTCUT_ACTION_CODES.indexOf(
    actionCode as CurrentGroupShortcutActionCode
  );
}

export function isShortcutModifier(value: unknown): value is ShortcutModifier {
  return (
    typeof value === "string" &&
    SHORTCUT_MODIFIERS.includes(value as ShortcutModifier)
  );
}

export function isSupportedShortcutKeyCode(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return (
    /^F(?:[1-9]|1[0-2])$/.test(value) ||
    /^Key[A-Z]$/.test(value) ||
    /^Digit[0-9]$/.test(value) ||
    /^Numpad(?:[0-9]|Add|Decimal|Divide|Enter|Multiply|Subtract)$/.test(value) ||
    SUPPORTED_NAMED_KEY_CODES.has(value)
  );
}

export function shortcutCombinationKey(
  modifier: ShortcutModifier,
  keyCode: string
) {
  return `${modifier}:${keyCode}`;
}

export function isReservedShortcut(
  modifier: ShortcutModifier,
  keyCode: string
) {
  return RESERVED_SHORTCUTS.has(shortcutCombinationKey(modifier, keyCode));
}

export function formatShortcutKeyCode(keyCode: string | null) {
  if (!keyCode) {
    return "";
  }

  if (keyCode.startsWith("Key")) {
    return keyCode.slice(3);
  }
  if (keyCode.startsWith("Digit")) {
    return keyCode.slice(5);
  }
  if (keyCode.startsWith("Numpad")) {
    return `Num ${keyCode.slice(6)}`;
  }

  const labels: Record<string, string> = {
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    PageDown: "Page Down",
    PageUp: "Page Up",
    Space: "Space",
  };

  return labels[keyCode] ?? keyCode;
}

export function matchesShortcutBinding(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
  binding: UserShortcutBinding
) {
  if (!binding.keyCode || event.metaKey || event.code !== binding.keyCode) {
    return false;
  }

  return (
    event.ctrlKey === (binding.modifier === "CTRL") &&
    event.shiftKey === (binding.modifier === "SHIFT") &&
    event.altKey === (binding.modifier === "ALT")
  );
}

export function personalSettingsEqual(
  left: PersonalSettings,
  right: PersonalSettings
) {
  if (
    USER_PREFERENCE_KEYS.some(
      (key) => left.preferences[key] !== right.preferences[key]
    )
  ) {
    return false;
  }

  if (left.shortcutBindings.length !== right.shortcutBindings.length) {
    return false;
  }

  const rightByAction = new Map(
    right.shortcutBindings.map((binding) => [binding.actionCode, binding])
  );

  return left.shortcutBindings.every((binding) => {
    const other = rightByAction.get(binding.actionCode);
    return (
      other?.modifier === binding.modifier && other.keyCode === binding.keyCode
    );
  });
}
