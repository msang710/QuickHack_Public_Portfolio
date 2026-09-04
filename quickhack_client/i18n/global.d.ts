import type { QuickHackMessages } from "@/quickhack_client/i18n/catalogs";
import type { QuickHackLocale } from "@/quickhack_shared/i18n/locales";

declare module "next-intl" {
  interface AppConfig {
    Locale: QuickHackLocale;
    Messages: QuickHackMessages;
  }
}
