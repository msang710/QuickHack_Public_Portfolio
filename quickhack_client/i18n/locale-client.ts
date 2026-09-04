"use client";

import {
  LOCALE_COOKIE_NAME,
  normalizeQuickHackLocale,
  type QuickHackLocale,
} from "@/quickhack_shared/i18n/locales";

export const LOCALE_BROADCAST_CHANNEL = "quickhack.locale.v1";

export type LocaleBroadcast = Readonly<{
  locale: QuickHackLocale;
  revision: number;
  source: string;
}>;

export function writeLocaleCookie(locale: QuickHackLocale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function publishLocale(input: LocaleBroadcast) {
  writeLocaleCookie(input.locale);
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(LOCALE_BROADCAST_CHANNEL);
  channel.postMessage(input);
  channel.close();
}

export function parseLocaleBroadcast(value: unknown): LocaleBroadcast | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<LocaleBroadcast>;
  const locale = normalizeQuickHackLocale(input.locale);
  if (
    locale !== input.locale ||
    !Number.isInteger(input.revision) ||
    Number(input.revision) < 0 ||
    typeof input.source !== "string" ||
    !input.source.trim()
  ) {
    return null;
  }
  return { locale, revision: Number(input.revision), source: input.source };
}
