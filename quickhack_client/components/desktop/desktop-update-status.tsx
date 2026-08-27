"use client";

import * as React from "react";
import { Download, RefreshCcw } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { useDesktopCapability } from "@/quickhack_client/components/desktop/desktop-capability-provider";
import type { DesktopUpdateSnapshot } from "@/quickhack_desktop/shared/update-contract";

export function DesktopUpdateStatus() {
  const { api } = useDesktopCapability();
  const [snapshot, setSnapshot] = React.useState<DesktopUpdateSnapshot | null>(null);
  React.useEffect(() => {
    if (!api) return;
    void api.updateState().then((current) => {
      setSnapshot(current);
      if (current.state === "IDLE") {
        void api.checkForUpdates().then(setSnapshot).catch(() => undefined);
      }
    }).catch(() => undefined);
    return api.onUpdateChanged(setSnapshot);
  }, [api]);
  if (!api || !snapshot || (snapshot.state === "IDLE" && !snapshot.message)) return null;
  const busy = snapshot.state === "CHECKING" || snapshot.state === "APPLYING";
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-5 py-2 text-xs">
      <span className="font-medium">데스크톱 {snapshot.currentVersion}</span>
      <span className="text-muted-foreground">{snapshot.message || snapshot.state}</span>
      {snapshot.state === "DOWNLOADED" ? (
        <Button size="sm" variant="outline" onClick={() => { void api.applyUpdate().then(setSnapshot); }}><Download className="size-3.5" />업데이트 적용</Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void api.checkForUpdates().then(setSnapshot); }}><RefreshCcw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />다시 확인</Button>
      )}
    </div>
  );
}
