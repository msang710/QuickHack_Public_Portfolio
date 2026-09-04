"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/quickhack_client/components/ui/button";

type Device = { serial: string; connectionState: string; modelCode?: string; product?: string };
export function DesktopAdbWindow() {
  const t = useTranslations("desktop.adbWindow");
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [revision, setRevision] = React.useState("");
  const [message, setMessage] = React.useState("");
  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/desktop/native", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "adb.list", payload: {} }) });
    const payload = await response.json() as { ok: boolean; result?: { devices?: Device[]; revision?: string }; code?: string };
    if (!payload.ok) { setMessage(t("loadFailed")); return; }
    setDevices(payload.result?.devices ?? []); setRevision(payload.result?.revision ?? ""); setMessage("");
  }, [t]);
  React.useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  async function check(device: Device) {
    const response = await fetch("/api/desktop/native", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "adb.action", payload: { action: "get-state", serial: device.serial, enumerationRevision: revision } }) });
    const payload = await response.json() as { ok: boolean; result?: { state?: string }; code?: string };
    setMessage(payload.ok ? t("checkResult", { serial: device.serial, state: payload.result?.state ?? "unknown" }) : t("checkFailed"));
    if (!payload.ok) void refresh();
  }
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-5xl space-y-4">
    <div className="flex items-center justify-between"><div><h1 className="text-xl font-semibold">{t("title")}</h1><p className="text-sm text-muted-foreground">{t("description")}</p></div><Button onClick={() => void refresh()}>{t("refresh")}</Button></div>
    {message ? <p className="rounded border p-3 text-sm">{message}</p> : null}
    <div className="rounded border">{devices.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("empty")}</p> : devices.map((device) => <div key={device.serial} className="flex items-center justify-between border-b p-4 last:border-b-0"><div><strong className="font-mono">{device.serial}</strong><p className="text-sm text-muted-foreground">{device.connectionState} · {[device.modelCode, device.product].filter(Boolean).join(" ")}</p></div><Button variant="outline" disabled={device.connectionState !== "device"} onClick={() => void check(device)}>{t("check")}</Button></div>)}</div>
  </div></main>;
}
