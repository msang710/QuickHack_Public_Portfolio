import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { koMessages } from "../../quickhack_client/i18n/catalogs/ko/index.ts";
import { enMessages } from "../../quickhack_client/i18n/catalogs/en/index.ts";

export function captureStatisticsPresentation(usePresentation, locale = "ko") {
  let presentation;
  function Capture() {
    presentation = usePresentation();
    return null;
  }
  renderToStaticMarkup(
    React.createElement(
      NextIntlClientProvider,
      { locale, messages: locale === "en" ? enMessages : koMessages, timeZone: "Asia/Seoul" },
      React.createElement(Capture)
    )
  );
  if (!presentation) throw new Error("Statistics presentation was not captured.");
  return presentation;
}
