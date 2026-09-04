// QuickHack object: Browser print helper that renders print-only HTML in a hidden iframe.
"use client";

export function escapePrintHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildPrintHtmlDocument({
  title,
  locale,
  styles,
  body,
}: {
  title: string;
  locale: string;
  styles: string;
  body: string;
}) {
  return `<!doctype html>
<html lang="${escapePrintHtml(locale)}">
  <head>
    <meta charset="utf-8" />
    <title>${escapePrintHtml(title)}</title>
    <style>${styles}</style>
  </head>
  <body>${body}</body>
</html>`;
}

export async function printHtmlDocument({
  title,
  html,
  messages,
  cleanupDelayMs = 3000,
}: {
  title: string;
  html: string;
  messages: { browserOnly: string; documentUnavailable: string };
  cleanupDelayMs?: number;
}) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error(messages.browserOnly);
  }

  const iframe = document.createElement("iframe");
  iframe.title = title;
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";

  document.body.appendChild(iframe);

  const printWindow = iframe.contentWindow;
  const printDocument = iframe.contentDocument ?? printWindow?.document;

  if (!printWindow || !printDocument) {
    iframe.remove();
    throw new Error(messages.documentUnavailable);
  }

  const targetWindow = printWindow;

  printDocument.open();
  printDocument.write(html);
  printDocument.close();

  await new Promise<void>((resolve) => {
    let done = false;

    function cleanup() {
      if (done) {
        return;
      }

      done = true;
      window.setTimeout(() => iframe.remove(), 250);
      resolve();
    }

    function runPrint() {
      targetWindow.focus();
      targetWindow.addEventListener("afterprint", cleanup, { once: true });
      targetWindow.print();
      window.setTimeout(cleanup, cleanupDelayMs);
    }

    if (printDocument.readyState === "complete") {
      window.setTimeout(runPrint, 0);
      return;
    }

    iframe.addEventListener("load", () => window.setTimeout(runPrint, 0), {
      once: true,
    });
  });
}
