"use client";

import * as React from "react";
import { NextIntlClientProvider } from "next-intl";
import { useRouter } from "next/navigation";
import type { QuickHackMessages } from "@/quickhack_client/i18n/catalogs";
import {
  LOCALE_BROADCAST_CHANNEL,
  parseLocaleBroadcast,
} from "@/quickhack_client/i18n/locale-client";
import type { QuickHackLocale } from "@/quickhack_shared/i18n/locales";

export function QuickHackIntlProvider({
  children,
  locale,
  messages,
}: Readonly<{
  children: React.ReactNode;
  locale: QuickHackLocale;
  messages: QuickHackMessages;
}>) {
  const router = useRouter();
  const latestRevisionRef = React.useRef(-1);

  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(LOCALE_BROADCAST_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const update = parseLocaleBroadcast(event.data);
      if (!update || update.revision <= latestRevisionRef.current) {
        return;
      }
      latestRevisionRef.current = update.revision;
      React.startTransition(() => router.refresh());
    };
    return () => channel.close();
  }, [router]);

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="Asia/Seoul"
    >
      {children}
    </NextIntlClientProvider>
  );
}
