export const SUPPORTED_LOCALES = ["ko", "en"] as const;
export type QuickHackLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: QuickHackLocale = "ko";
// English stays selectable in the persistence contract for integration tests,
// but the UI must not expose it until the full catalog and regression gates pass.
export const ENGLISH_UI_READY = false;
export const LOCALE_COOKIE_NAME = "quickhack_locale";

export function isQuickHackLocale(value: unknown): value is QuickHackLocale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as QuickHackLocale);
}

export function normalizeQuickHackLocale(value: unknown): QuickHackLocale {
  return isQuickHackLocale(value) ? value : DEFAULT_LOCALE;
}
