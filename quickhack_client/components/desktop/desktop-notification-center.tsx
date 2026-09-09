"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import type { DesktopNotificationPresentation } from "@/quickhack_shared/notifications/desktop-notifications";
import { useDesktopCapability } from "./desktop-capability-provider";

export function DesktopNotificationCenter({ enabled, onNavigate }: {
  enabled: boolean;
  onNavigate: (menuId: string) => void;
}) {
  const t = useTranslations("desktop.notificationCenter");
  const { api } = useDesktopCapability();
  const [items, setItems] = React.useState<DesktopNotificationPresentation[]>([]);
  const [unread, setUnread] = React.useState(0);
  const delivered = React.useRef(new Set<string>());
  const presentation = React.useCallback((item: DesktopNotificationPresentation) => {
    if (!item.messageKey) return { title: item.title, body: item.body };
    if (item.messageKey === "inspectionComplete") {
      const pgNo = String(item.messageArguments.pgNo ?? "");
      return { title: t("messages.inspectionComplete.title"), body: t("messages.inspectionComplete.body", { pgNo }) };
    }
    if (item.messageKey === "inspectionCompleteGrouped") {
      const count = Number(item.messageArguments.count ?? item.count);
      return { title: t("messages.inspectionCompleteGrouped.title", { count }), body: t("messages.inspectionCompleteGrouped.body", { count }) };
    }
    if (item.messageKey === "shipmentAddressChange") {
      return { title: t("messages.shipmentAddressChange.title"), body: t("messages.shipmentAddressChange.body") };
    }
    return { title: t("messages.returnRequest.title"), body: t("messages.returnRequest.body") };
  }, [t]);
  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/auth/desktop-notifications", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { presentations?: DesktopNotificationPresentation[]; unreadCount?: number };
    const next = payload.presentations ?? [];
    setItems(next);
    setUnread(Number(payload.unreadCount ?? 0));
    if (!enabled || !api) return;
    for (const item of next.filter((entry) => !entry.readAt).reverse()) {
      if (delivered.current.has(item.presentationId)) continue;
      delivered.current.add(item.presentationId);
      const message = presentation(item);
      const shown = await api.showNotification(message).catch(() => false);
      if (shown) await fetch("/api/auth/desktop-notifications", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "DELIVERED", recipientIds: item.recipientIds }) });
    }
  }, [api, enabled, presentation]);
  React.useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  const open = React.useCallback(async (item: DesktopNotificationPresentation) => {
    if (!item.readAt) await fetch("/api/auth/desktop-notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "READ", recipientIds: item.recipientIds }),
    });
    onNavigate(item.menuId);
    void refresh();
  }, [onNavigate, refresh]);
  return <details className="relative">
    <summary className="list-none"><Button type="button" variant="outline" size="sm" aria-label={t("aria", { count: unread })}><Bell className="h-4 w-4" />{unread || ""}</Button></summary>
    <div className="absolute right-0 z-50 mt-2 w-96 max-w-[80vw] rounded-md border bg-background p-2 shadow-lg">
      {items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t("empty")}</p> : items.map((item) => {
        const message = presentation(item);
        return <button key={item.presentationId} type="button" onClick={() => void open(item)} className="block w-full rounded p-3 text-left hover:bg-muted">
          <span className="block text-sm font-medium">{item.readAt ? "" : "● "}{message.title}</span>
          <span className="block text-xs text-muted-foreground">{message.body}</span>
        </button>;
      })}
    </div>
  </details>;
}
