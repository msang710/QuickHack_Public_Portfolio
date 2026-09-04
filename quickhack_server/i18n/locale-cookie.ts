import type { NextRequest, NextResponse } from "next/server";
import {
  LOCALE_COOKIE_NAME,
  type QuickHackLocale,
} from "@/quickhack_shared/i18n/locales";

const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function setLocaleSnapshotCookie(
  request: NextRequest,
  response: NextResponse,
  locale: QuickHackLocale
) {
  response.cookies.set(LOCALE_COOKIE_NAME, locale, {
    httpOnly: false,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
  });
}
