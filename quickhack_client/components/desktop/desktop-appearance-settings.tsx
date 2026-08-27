"use client";

import { MonitorCog, RotateCcw } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { useDesktopCapability } from "./desktop-capability-provider";

export function DesktopAppearanceSettings() {
  const { api, appearance, setAppearance, resetAppearance } = useDesktopCapability();
  return (
    <section className="rounded-md border bg-popover p-4">
      <div className="mb-4 flex items-center gap-2">
        <MonitorCog className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">화면과 데스크톱</h2>
        <Badge variant={api ? "success" : "neutral"}>{api ? "Electron" : "개발용 웹"}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">테마
          <select className="h-10 rounded-md border bg-background px-3" value={appearance.theme} onChange={(event) => setAppearance({ ...appearance, theme: event.target.value as typeof appearance.theme })}>
            <option value="system">시스템 설정</option><option value="light">라이트</option><option value="dark">다크</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">글꼴
          <select className="h-10 rounded-md border bg-background px-3" value={appearance.fontFamily} onChange={(event) => setAppearance({ ...appearance, fontFamily: event.target.value as typeof appearance.fontFamily })}>
            <option value="system">시스템 기본</option><option value="compact">업무용 고밀도</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm">기본 글자 크기 · {appearance.fontSize}px
          <input type="range" min="13" max="20" step="1" value={appearance.fontSize} onChange={(event) => setAppearance({ ...appearance, fontSize: Number(event.target.value) })} />
        </label>
        <label className="grid gap-2 text-sm">화면 배율 · {Math.round(appearance.scale * 100)}%
          <input type="range" min="0.85" max="1.25" step="0.05" value={appearance.scale} onChange={(event) => setAppearance({ ...appearance, scale: Number(event.target.value) })} />
        </label>
      </div>
      <div className="mt-4 flex justify-end"><Button type="button" variant="outline" onClick={resetAppearance}><RotateCcw className="size-4" />기본값 복원</Button></div>
      <p className="mt-3 text-xs text-muted-foreground">이 설정은 현재 PC에만 저장되며 라벨·송장 인쇄 크기에는 적용되지 않습니다.</p>
    </section>
  );
}
