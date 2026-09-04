import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { messagesForLocale } from "@/quickhack_client/i18n/catalogs";
import { LOCALE_COOKIE_NAME, normalizeQuickHackLocale } from "@/quickhack_shared/i18n/locales";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const locale = normalizeQuickHackLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  return { locale, messages: messagesForLocale(locale), timeZone: "Asia/Seoul" };
});
