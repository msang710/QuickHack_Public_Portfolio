"use client";

import { MonitorCog, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { useDesktopCapability } from "./desktop-capability-provider";

export function DesktopAppearanceSettings() {
  const t = useTranslations("desktop.appearance");
  const { api, appearance, setAppearance, resetAppearance } = useDesktopCapability();
  return (
    <section className="rounded-md border bg-popover p-4">
      <div className="mb-4 flex items-center gap-2">
        <MonitorCog className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">{t("title")}</h2>
        <Badge variant={api ? "success" : "neutral"}>{api ? "Electron" : t("browser")}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">{t("theme")}
          <select className="h-10 rounded-md border bg-background px-3" value={appearance.theme} onChange={(event) => setAppearance({ ...appearance, theme: event.target.value as typeof appearance.theme })}>
            <option value="system">{t("system")}</option><option value="light">{t("light")}</option><option value="dark">{t("dark")}</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">{t("font")}
          <select className="h-10 rounded-md border bg-background px-3" value={appearance.fontFamily} onChange={(event) => setAppearance({ ...appearance, fontFamily: event.target.value as typeof appearance.fontFamily })}>
            <option value="system">{t("systemFont")}</option><option value="compact">{t("compactFont")}</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm">{t("fontSize", { size: String(appearance.fontSize) })}
          <input type="range" min="13" max="20" step="1" value={appearance.fontSize} onChange={(event) => setAppearance({ ...appearance, fontSize: Number(event.target.value) })} />
        </label>
        <label className="grid gap-2 text-sm">{t("scale", { percent: String(Math.round(appearance.scale * 100)) })}
          <input type="range" min="0.85" max="1.25" step="0.05" value={appearance.scale} onChange={(event) => setAppearance({ ...appearance, scale: Number(event.target.value) })} />
        </label>
      </div>
      <div className="mt-4 flex justify-end"><Button type="button" variant="outline" onClick={resetAppearance}><RotateCcw className="size-4" />{t("reset")}</Button></div>
      <p className="mt-3 text-xs text-muted-foreground">{t("note")}</p>
    </section>
  );
}
