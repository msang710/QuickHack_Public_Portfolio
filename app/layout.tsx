// QuickHack note: QuickHack 앱 전체 HTML 골격과 전역 스타일을 연결하는 Next.js 루트 레이아웃입니다.
﻿import type { Metadata } from "next";
import { ClientHttpTraceProvider } from "@/quickhack_client/observability/client-http-trace-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuickHack",
  description: "Device-centered ERP/WMS workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <ClientHttpTraceProvider>{children}</ClientHttpTraceProvider>
      </body>
    </html>
  );
}
