import type { QuickHackLocale } from "@/quickhack_shared/i18n/locales";
import { enMessages } from "./en";
import { koMessages, type QuickHackMessages } from "./ko";

export { koMessages, type QuickHackMessages } from "./ko";

function mergeMessageTree(
  fallback: Record<string, unknown>,
  selected: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fallback).map(([key, fallbackValue]) => {
      const selectedValue = selected[key];
      if (
        fallbackValue &&
        selectedValue &&
        typeof fallbackValue === "object" &&
        typeof selectedValue === "object" &&
        !Array.isArray(fallbackValue) &&
        !Array.isArray(selectedValue)
      ) {
        return [
          key,
          mergeMessageTree(
            fallbackValue as Record<string, unknown>,
            selectedValue as Record<string, unknown>
          ),
        ];
      }
      return [key, typeof selectedValue === "string" ? selectedValue : fallbackValue];
    })
  );
}

export function messagesForLocale(locale: QuickHackLocale): QuickHackMessages {
  if (locale === "ko") {
    return koMessages;
  }
  return mergeMessageTree(
    koMessages as unknown as Record<string, unknown>,
    enMessages as unknown as Record<string, unknown>
  ) as QuickHackMessages;
}
