"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Download, RefreshCcw } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { useDesktopCapability } from "@/quickhack_client/components/desktop/desktop-capability-provider";
import type {
  DesktopUpdateMessageCode,
  DesktopUpdateSnapshot,
} from "@/quickhack_desktop/shared/update-contract";

const UPDATE_MESSAGE_KEYS = {
  UPDATE_CHECKING: "checking",
  UPDATE_LATEST: "latest",
  UPDATE_DOWNLOADING: "downloading",
  UPDATE_READY: "ready",
  UPDATE_APPLYING: "applying",
  UPDATE_FAILED: "failed",
  PACKAGE_ADAPTER_UNAVAILABLE: "unavailable",
} as const satisfies Record<DesktopUpdateMessageCode, string>;

export function DesktopUpdateStatus() {
  const t = useTranslations("desktop.updateStatus");
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
  if (!api || !snapshot || (snapshot.state === "IDLE" && !snapshot.messageCode)) return null;
  const busy = snapshot.state === "CHECKING" || snapshot.state === "APPLYING";
  const message = snapshot.messageCode
    ? t(UPDATE_MESSAGE_KEYS[snapshot.messageCode])
    : t("unknown");
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-5 py-2 text-xs">
      <span className="font-medium">{t("desktop")} {snapshot.currentVersion}</span>
      <span className="text-muted-foreground">{message}</span>
      {snapshot.state === "DOWNLOADED" ? (
        <Button size="sm" variant="outline" onClick={() => { void api.applyUpdate().then(setSnapshot); }}><Download className="size-3.5" />{t("apply")}</Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void api.checkForUpdates().then(setSnapshot); }}><RefreshCcw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />{t("checkAgain")}</Button>
      )}
    </div>
  );
}
