"use client";

import * as React from "react";
import { Command, MonitorUp, Smartphone } from "lucide-react";
import type { MenuGroup, MenuItemId } from "@/quickhack_client/components/app-shell/device-workspace-menu";
import { DialogFrame } from "@/quickhack_client/components/ui/dialog-frame";
import { Input } from "@/quickhack_client/components/ui/input";
import { useDesktopCapability } from "./desktop-capability-provider";

export function DesktopCommandPalette({
  groups,
  onNavigate,
}: {
  groups: readonly MenuGroup[];
  onNavigate: (menuId: MenuItemId) => void;
}) {
  const { api } = useDesktopCapability();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const setPaletteOpen = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  }, []);
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setPaletteOpen]);

  const menus = groups.flatMap((group) => group.items.map((item) => ({ ...item, groupLabel: group.label })));
  const normalized = query.trim().toLowerCase();
  const filtered = menus.filter((item) => `${item.label} ${item.description} ${item.groupLabel}`.toLowerCase().includes(normalized)).slice(0, 30);
  const canOpenOutput = menus.some((item) => item.id === "shipment-matched" || item.id === "shipment-today");
  const canOpenAdb = menus.some((item) => item.id === "developer-adb-diagnostics" || item.id === "inbound-function");

  const selectMenu = (menuId: MenuItemId) => {
    setPaletteOpen(false);
    onNavigate(menuId);
  };
  return (
    <DialogFrame open={open} onOpenChange={setPaletteOpen} title="QuickHack 명령" description="권한이 있는 메뉴와 안전한 데스크톱 작업만 표시합니다." icon={<Command className="size-5" />} bodyClassName="p-0">
      <div className="border-b p-3"><Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="메뉴 또는 작업 검색" /></div>
      <div className="max-h-[55vh] overflow-y-auto p-2">
        {api && !normalized ? <div className="mb-2 grid gap-1">
          {canOpenOutput ? <button type="button" className="flex items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-secondary" onClick={() => { setPaletteOpen(false); void api.openOutputWindow(); }}><MonitorUp className="size-4" /><span><strong className="block text-sm">출력 미리보기 창</strong><span className="text-xs text-muted-foreground">현재 출력 작업을 별도 모니터에서 확인</span></span></button> : null}
          {canOpenAdb ? <button type="button" className="flex items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-secondary" onClick={() => { setPaletteOpen(false); void api.openAdbWindow(); }}><Smartphone className="size-4" /><span><strong className="block text-sm">ADB 장치 도구 창</strong><span className="text-xs text-muted-foreground">연결 장치 상태를 별도 창에 고정</span></span></button> : null}
        </div> : null}
        {filtered.map((item) => <button key={item.id} type="button" className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-secondary" onClick={() => selectMenu(item.id)}><item.icon className="size-4" /><span><strong className="block text-sm">{item.label}</strong><span className="text-xs text-muted-foreground">{item.groupLabel} · {item.description}</span></span></button>)}
        {filtered.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">조건에 맞는 메뉴가 없습니다.</p> : null}
      </div>
    </DialogFrame>
  );
}
