"use client";

import * as React from "react";
import { Button } from "@/quickhack_client/components/ui/button";

type Device = { serial: string; connectionState: string; modelCode?: string; product?: string };
export function DesktopAdbWindow() {
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [revision, setRevision] = React.useState("");
  const [message, setMessage] = React.useState("");
  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/desktop/native", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "adb.list", payload: {} }) });
    const payload = await response.json() as { ok: boolean; result?: { devices?: Device[]; revision?: string }; message?: string };
    if (!payload.ok) { setMessage(payload.message ?? "ADB 목록을 불러오지 못했습니다."); return; }
    setDevices(payload.result?.devices ?? []); setRevision(payload.result?.revision ?? ""); setMessage("");
  }, []);
  React.useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  async function check(device: Device) {
    const response = await fetch("/api/desktop/native", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "adb.action", payload: { action: "get-state", serial: device.serial, enumerationRevision: revision } }) });
    const payload = await response.json() as { ok: boolean; result?: { state?: string }; message?: string };
    setMessage(payload.ok ? `${device.serial}: ${payload.result?.state ?? "unknown"}` : payload.message ?? "장치 상태 확인 실패");
    if (!payload.ok) void refresh();
  }
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-5xl space-y-4">
    <div className="flex items-center justify-between"><div><h1 className="text-xl font-semibold">ADB 장치 도구</h1><p className="text-sm text-muted-foreground">목록 revision이 바뀌면 선택 작업을 거부합니다.</p></div><Button onClick={() => void refresh()}>새로고침</Button></div>
    {message ? <p className="rounded border p-3 text-sm">{message}</p> : null}
    <div className="rounded border">{devices.length === 0 ? <p className="p-4 text-sm text-muted-foreground">연결된 장치가 없습니다.</p> : devices.map((device) => <div key={device.serial} className="flex items-center justify-between border-b p-4 last:border-b-0"><div><strong className="font-mono">{device.serial}</strong><p className="text-sm text-muted-foreground">{device.connectionState} · {[device.modelCode, device.product].filter(Boolean).join(" ")}</p></div><Button variant="outline" disabled={device.connectionState !== "device"} onClick={() => void check(device)}>상태 확인</Button></div>)}</div>
  </div></main>;
}
