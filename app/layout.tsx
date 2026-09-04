// QuickHack note: QuickHack 앱 전체 HTML 골격과 전역 스타일을 연결하는 Next.js 루트 레이아웃입니다.
﻿import type { Metadata } from "next";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { ClientHttpTraceProvider } from "@/quickhack_client/observability/client-http-trace-provider";
import { QuickHackIntlProvider } from "@/quickhack_client/i18n/quickhack-intl-provider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.metadata");
  return { title: "QuickHack", description: t("description") };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body>
        <QuickHackIntlProvider locale={locale} messages={messages}>
          <ClientHttpTraceProvider>{children}</ClientHttpTraceProvider>
        </QuickHackIntlProvider>
      </body>
    </html>
  );
}
