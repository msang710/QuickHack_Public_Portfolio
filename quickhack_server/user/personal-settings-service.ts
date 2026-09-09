import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { normalizeQuickHackLocale } from "@/quickhack_shared/i18n/locales";
import {
  DEFAULT_USER_PREFERENCES,
  DEFAULT_USER_SHORTCUT_BINDINGS,
  SHORTCUT_ACTION_CODES,
  USER_PREFERENCE_KEYS,
  isReservedShortcut,
  isShortcutActionCode,
  isShortcutModifier,
  isSupportedShortcutKeyCode,
  shortcutCombinationKey,
  type PersonalSettings,
  type ShortcutActionCode,
  type UserPreferences,
  type UserShortcutBinding,
} from "@/quickhack_shared/user/personal-settings";

type PreferenceRow = Prisma.user_preferencesGetPayload<object> | null;
type ShortcutRow = Prisma.user_shortcut_bindingsGetPayload<object>;

export class PersonalSettingsValidationError extends Error {
  readonly status: number;
  readonly actionCode?: ShortcutActionCode;

  constructor(
    message: string,
    options: { status?: number; actionCode?: ShortcutActionCode } = {}
  ) {
    super(message);
    this.name = "PersonalSettingsValidationError";
    this.status = options.status ?? 400;
    this.actionCode = options.actionCode;
  }
}

function objectValue(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalSettingsValidationError(message);
  }

  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  message: string
) {
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw new PersonalSettingsValidationError(message);
  }
}

function preferencesFromRow(row: PreferenceRow): UserPreferences {
  if (!row) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  return {
    keyboardShortcutsEnabled: row.keyboard_shortcuts_enabled === 1,
    windowsNotificationsEnabled: row.windows_notifications_enabled === 1,
    inspectionCompleteNotificationEnabled:
      row.inspection_complete_notification_enabled === 1,
    shipmentChangeNotificationEnabled:
      row.shipment_change_notification_enabled === 1,
    returnNotificationEnabled: row.return_notification_enabled === 1,
  };
}

function preferencesToDatabase(preferences: UserPreferences) {
  return {
    keyboard_shortcuts_enabled: preferences.keyboardShortcutsEnabled ? 1 : 0,
    windows_notifications_enabled: preferences.windowsNotificationsEnabled
      ? 1
      : 0,
    inspection_complete_notification_enabled:
      preferences.inspectionCompleteNotificationEnabled ? 1 : 0,
    shipment_change_notification_enabled:
      preferences.shipmentChangeNotificationEnabled ? 1 : 0,
    return_notification_enabled: preferences.returnNotificationEnabled ? 1 : 0,
  };
}

function localeFromRow(row: PreferenceRow) {
  return normalizeQuickHackLocale(row?.locale);
}

function shortcutBindingsFromRows(rows: ShortcutRow[]): UserShortcutBinding[] {
  const rowByAction = new Map(
    rows
      .filter((row) => isShortcutActionCode(row.action_code))
      .map((row) => [row.action_code as ShortcutActionCode, row])
  );

  return DEFAULT_USER_SHORTCUT_BINDINGS.map((defaultBinding) => {
    const row = rowByAction.get(defaultBinding.actionCode);

    if (!row || !isShortcutModifier(row.modifier)) {
      return { ...defaultBinding };
    }

    return {
      actionCode: defaultBinding.actionCode,
      modifier: row.modifier,
      keyCode:
        row.key_code === null || isSupportedShortcutKeyCode(row.key_code)
          ? row.key_code
          : null,
    };
  });
}

function parsePreferences(value: unknown): UserPreferences {
  const input = objectValue(value, "개인 설정 값이 올바르지 않습니다.");
  assertOnlyKeys(
    input,
    USER_PREFERENCE_KEYS,
    "지원하지 않는 개인 설정 항목이 포함되어 있습니다."
  );

  const preferences = {} as UserPreferences;

  for (const key of USER_PREFERENCE_KEYS) {
    if (typeof input[key] !== "boolean") {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED"
      );
    }
    preferences[key] = input[key];
  }

  return preferences;
}

function parseShortcutBindings(value: unknown): UserShortcutBinding[] {
  if (!Array.isArray(value)) {
    throw new PersonalSettingsValidationError(
      "PERSONAL_SETTINGS_VALIDATION_FAILED"
    );
  }

  if (value.length !== SHORTCUT_ACTION_CODES.length) {
    throw new PersonalSettingsValidationError(
      "PERSONAL_SETTINGS_VALIDATION_FAILED"
    );
  }

  const actionCodes = new Set<ShortcutActionCode>();
  const combinations = new Map<string, ShortcutActionCode>();
  const bindings = value.map((rawBinding) => {
    const input = objectValue(rawBinding, "단축키 항목이 올바르지 않습니다.");
    assertOnlyKeys(
      input,
      ["actionCode", "modifier", "keyCode"],
      "지원하지 않는 단축키 값이 포함되어 있습니다."
    );

    if (!isShortcutActionCode(input.actionCode)) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED"
      );
    }
    if (actionCodes.has(input.actionCode)) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED",
        { actionCode: input.actionCode }
      );
    }
    if (!isShortcutModifier(input.modifier)) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED",
        { actionCode: input.actionCode }
      );
    }
    if (
      input.keyCode !== null &&
      !isSupportedShortcutKeyCode(input.keyCode)
    ) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED",
        { actionCode: input.actionCode }
      );
    }
    if (
      input.keyCode !== null &&
      isReservedShortcut(input.modifier, input.keyCode)
    ) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED",
        { actionCode: input.actionCode }
      );
    }

    const binding: UserShortcutBinding = {
      actionCode: input.actionCode,
      modifier: input.modifier,
      keyCode: input.keyCode,
    };

    actionCodes.add(binding.actionCode);

    if (binding.keyCode) {
      const combination = shortcutCombinationKey(
        binding.modifier,
        binding.keyCode
      );
      const duplicateAction = combinations.get(combination);

      if (duplicateAction) {
        throw new PersonalSettingsValidationError(
          "PERSONAL_SETTINGS_VALIDATION_FAILED",
          { actionCode: binding.actionCode, status: 409 }
        );
      }
      combinations.set(combination, binding.actionCode);
    }

    return binding;
  });

  if (SHORTCUT_ACTION_CODES.some((actionCode) => !actionCodes.has(actionCode))) {
    throw new PersonalSettingsValidationError(
      "PERSONAL_SETTINGS_VALIDATION_FAILED"
    );
  }

  const byAction = new Map(bindings.map((binding) => [binding.actionCode, binding]));
  return SHORTCUT_ACTION_CODES.map((actionCode) => byAction.get(actionCode)!);
}

function parseSaveInput(value: unknown) {
  const input = objectValue(value, "개인 설정 저장 요청이 올바르지 않습니다.");
  assertOnlyKeys(
    input,
    ["expectedRevision", "locale", "preferences", "shortcutBindings"],
    "지원하지 않는 개인 설정 저장 값이 포함되어 있습니다."
  );

  if (
    !Number.isInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0
  ) {
    throw new PersonalSettingsValidationError(
      "PERSONAL_SETTINGS_VALIDATION_FAILED"
    );
  }

  return {
    expectedRevision: Number(input.expectedRevision),
    locale: (() => {
      const locale = normalizeQuickHackLocale(input.locale);
      if (locale !== input.locale) {
        throw new PersonalSettingsValidationError("PERSONAL_SETTINGS_VALIDATION_FAILED");
      }
      return locale;
    })(),
    preferences: parsePreferences(input.preferences),
    shortcutBindings: parseShortcutBindings(input.shortcutBindings),
  };
}

export async function getPersonalSettings(client: PrismaClient, userId: number) {
  const [preferenceRow, shortcutRows] = await Promise.all([
    client.user_preferences.findUnique({ where: { user_id: userId } }),
    client.user_shortcut_bindings.findMany({ where: { user_id: userId } }),
  ]);

  return {
    revision: preferenceRow?.settings_revision ?? 0,
    locale: localeFromRow(preferenceRow),
    preferences: preferencesFromRow(preferenceRow),
    shortcutBindings: shortcutBindingsFromRows(shortcutRows),
  } satisfies PersonalSettings;
}

export async function savePersonalSettings(
  client: PrismaClient,
  userId: number,
  value: unknown
) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PersonalSettingsValidationError(
      "PERSONAL_SETTINGS_VALIDATION_FAILED",
      { status: 401 }
    );
  }

  const input = parseSaveInput(value);
  const timestamp = databaseNow();

  return client.$transaction(async (tx) => {
    const preferenceRow = await tx.user_preferences.findUnique({
      where: { user_id: userId },
    });
    const currentRevision = preferenceRow?.settings_revision ?? 0;

    if (currentRevision !== input.expectedRevision) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED",
        { status: 409 }
      );
    }

    const nextRevision = input.expectedRevision + 1;
    const preferenceData = preferencesToDatabase(input.preferences);

    const claimed =
      input.expectedRevision === 0
        ? await tx.user_preferences.createMany({
            data: {
              user_id: userId,
              locale: input.locale,
              ...preferenceData,
              settings_revision: nextRevision,
              created_at: timestamp,
              updated_at: timestamp,
            },
            skipDuplicates: true,
          })
        : await tx.user_preferences.updateMany({
            where: {
              user_id: userId,
              settings_revision: input.expectedRevision,
            },
            data: {
              locale: input.locale,
              ...preferenceData,
              settings_revision: nextRevision,
              updated_at: timestamp,
            },
          });

    if (claimed.count !== 1) {
      throw new PersonalSettingsValidationError(
        "PERSONAL_SETTINGS_VALIDATION_FAILED",
        { status: 409 }
      );
    }

    await tx.user_shortcut_bindings.deleteMany({ where: { user_id: userId } });
    await tx.user_shortcut_bindings.createMany({
      data: input.shortcutBindings.map((binding) => ({
        user_id: userId,
        action_code: binding.actionCode,
        modifier: binding.modifier,
        key_code: binding.keyCode,
        created_at: timestamp,
        updated_at: timestamp,
      })),
    });

    return {
      revision: nextRevision,
      locale: input.locale,
      preferences: { ...input.preferences },
      shortcutBindings: input.shortcutBindings.map((binding) => ({
        ...binding,
      })),
    } satisfies PersonalSettings;
  });
}
