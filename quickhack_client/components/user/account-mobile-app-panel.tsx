"use client";

import * as React from "react";
import { RefreshCcw, Smartphone } from "lucide-react";
import { useUnsavedForm } from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import { AccountFieldLabel } from "@/quickhack_client/components/user/account-information-fields";
import { isAdbVirtualSerial } from "@/quickhack_shared/adb/adb-target-policy";
import {
  applyAdbSuggestionAsCleanBaseline,
  emptyMobileRegistrationDraft,
  MOBILE_REGISTRATION_FORM_IDS,
  mobileRegistrationDraftsEqual,
} from "@/quickhack_client/components/user/mobile-registration-draft-state";

type MobileDevice = {
  deviceId: number;
  registrationRevision: number;
  registrationState: "PROVISIONING" | "ACTIVE" | "REAUTH_REQUIRED" | "REVOKED";
  label: string;
  adbSerialPreview: string;
  publicKeyFingerprint: string;
  provisioningExpiresAt: string;
  activatedAt: string;
  lastSeenAt: string;
  revokedAt: string;
};

type MobileDevicesResponse = {
  ok: boolean;
  message?: string;
  items?: MobileDevice[];
  nextCursor?: string | null;
  hasMore?: boolean;
  activeCount?: number;
};

type AdbDevice = { serial?: string; connectionState?: string; modelCode?: string };
type AdbDevicesResponse = { ok: boolean; message?: string; devices?: AdbDevice[] };

function formatDateTime(value: string | null | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.replace("T", " ").slice(0, 19) : "-";
}

function stateLabel(state: MobileDevice["registrationState"]) {
  if (state === "ACTIVE") return "활성";
  if (state === "PROVISIONING") return "앱 로그인 대기";
  if (state === "REAUTH_REQUIRED") return "재등록 필요";
  return "폐기됨";
}

export function AccountMobileAppPanel({
  permissionEnabled,
  onActiveCountChange,
}: {
  permissionEnabled: boolean;
  onActiveCountChange?: (count: number) => void;
}) {
  const [devices, setDevices] = React.useState<MobileDevice[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [adbDevices, setAdbDevices] = React.useState<AdbDevice[]>([]);
  const [registrationDraft, setRegistrationDraft] = React.useState(emptyMobileRegistrationDraft);
  const [registrationBaseline, setRegistrationBaseline] = React.useState(emptyMobileRegistrationDraft);
  const [message, setMessage] = React.useState("");
  const [isBusy, setIsBusy] = React.useState(false);

  useUnsavedForm({
    id: MOBILE_REGISTRATION_FORM_IDS.personal,
    label: "포장 검수 USB 기기 등록",
    isDirty: !mobileRegistrationDraftsEqual(registrationBaseline, registrationDraft),
    isBusy,
    discard: () => {
      setRegistrationDraft(registrationBaseline);
      setMessage("");
    },
  });

  const loadDevices = React.useCallback(
    async (cursor?: string | null, append = false) => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(`/api/auth/mobile-devices${query}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as MobileDevicesResponse | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "모바일 기기 등록 정보를 불러오지 못했습니다.");
      }
      const items = payload.items ?? [];
      setDevices((current) => {
        const next = append ? [...current, ...items] : items;
        onActiveCountChange?.(payload.activeCount ?? next.filter(
          (device) => device.registrationState !== "REVOKED"
        ).length);
        return next;
      });
      setNextCursor(payload.hasMore ? payload.nextCursor ?? null : null);
    },
    [onActiveCountChange]
  );

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDevices().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDevices]);

  async function loadAdbDevices() {
    if (isBusy) return;
    setIsBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/adb/devices", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as AdbDevicesResponse | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "ADB 기기 목록을 불러오지 못했습니다.");
      const items = (payload.devices ?? []).filter(
        (device) =>
          device.connectionState === "device" &&
          String(device.serial ?? "").trim() &&
          !isAdbVirtualSerial(device.serial)
      );
      setAdbDevices(items);
      const suggested = String(items[0]?.serial ?? "");
      const next = applyAdbSuggestionAsCleanBaseline({
        baseline: registrationBaseline,
        current: registrationDraft,
        suggestedSerial: suggested,
      });
      setRegistrationDraft(next.current);
      setRegistrationBaseline(next.baseline);
      setMessage(items.length ? "현재 준비된 실제 USB 기기 목록을 갱신했습니다." : "현재 준비된 실제 USB 기기가 없습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function provision(device?: MobileDevice) {
    if (!permissionEnabled) {
      setMessage("포장 검수 접근 권한이 없습니다.");
      return;
    }
    if (!registrationDraft.adbSerial.trim()) {
      setMessage("ADB 목록을 갱신하고 실제 USB 기기를 선택하세요.");
      return;
    }
    setIsBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/adb/mobile-provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "SELF",
          adbSerial: registrationDraft.adbSerial,
          label: registrationDraft.label,
          ...(device
            ? {
                deviceId: device.deviceId,
                expectedRegistrationRevision: device.registrationRevision,
              }
            : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as MobileDevicesResponse | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "USB 기기 등록에 실패했습니다.");
      const empty = emptyMobileRegistrationDraft();
      setRegistrationDraft(empty);
      setRegistrationBaseline(empty);
      setMessage(payload.message || "USB 기기 등록 정보를 전달했습니다.");
      await loadDevices();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function revoke(device: MobileDevice) {
    if (!window.confirm(`${device.label || device.adbSerialPreview} 등록을 폐기할까요?`)) return;
    setIsBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/mobile-devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "revoke",
          deviceId: device.deviceId,
          expectedRegistrationRevision: device.registrationRevision,
        }),
      });
      const payload = (await response.json().catch(() => null)) as MobileDevicesResponse | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "기기 등록 폐기에 실패했습니다.");
      setMessage(payload.message || "기기 등록을 폐기했습니다.");
      await loadDevices();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border bg-popover">
      <div className="flex items-start justify-between gap-3 p-3">
        <div>
          <div className="flex items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">포장 검수 모바일 연결</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            현재 연결된 실제 USB 기기에만 등록 증명을 전달합니다. 등록 코드는 표시하지 않습니다.
          </p>
        </div>
        <Badge variant={permissionEnabled ? "success" : "neutral"}>
          {permissionEnabled ? "권한 허용" : "권한 없음"}
        </Badge>
      </div>

      {message ? <div className="border-t bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">{message}</div> : null}

      <div className="grid gap-3 border-t p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <AccountFieldLabel label="실제 USB ADB 기기">
            <Select
              value={registrationDraft.adbSerial || "NONE"}
              disabled={isBusy || !permissionEnabled}
              onValueChange={(value) =>
                setRegistrationDraft((current) => ({ ...current, adbSerial: value === "NONE" ? "" : value }))
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">ADB 기기 선택</SelectItem>
                {adbDevices.map((device) => (
                  <SelectItem key={device.serial} value={String(device.serial)}>
                    {String(device.serial)} / {String(device.modelCode ?? "-")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </AccountFieldLabel>
          <Button type="button" variant="outline" className="self-end" disabled={isBusy || !permissionEnabled} onClick={() => void loadAdbDevices()}>
            <RefreshCcw className="size-4" /> ADB 갱신
          </Button>
        </div>
        <AccountFieldLabel label="기기 라벨">
          <Input
            value={registrationDraft.label}
            placeholder="예: 포장라인 1번 기기"
            disabled={isBusy || !permissionEnabled}
            onChange={(event) => setRegistrationDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </AccountFieldLabel>
        <Button type="button" variant="outline" disabled={isBusy || !permissionEnabled || !registrationDraft.adbSerial} onClick={() => void provision()}>
          <Smartphone className="size-4" /> 선택한 USB 기기 등록
        </Button>
      </div>

      <div className="grid gap-2 border-t p-3">
        {devices.length ? devices.map((device) => (
          <div key={device.deviceId} className="grid gap-2 border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold">{device.label || device.adbSerialPreview}</div>
                <div className="font-mono text-muted-foreground">{device.adbSerialPreview} · rev {device.registrationRevision}</div>
              </div>
              <Badge variant={device.registrationState === "ACTIVE" ? "success" : device.registrationState === "REVOKED" ? "neutral" : "warning"}>
                {stateLabel(device.registrationState)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>활성화 <span className="tabular-nums">{formatDateTime(device.activatedAt)}</span></div>
              <div>마지막 호출 <span className="tabular-nums">{formatDateTime(device.lastSeenAt)}</span></div>
            </div>
            {device.registrationState !== "REVOKED" ? (
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" disabled={isBusy || !permissionEnabled || !registrationDraft.adbSerial} onClick={() => void provision(device)}>
                  선택 USB로 재등록
                </Button>
                <Button type="button" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800" disabled={isBusy} onClick={() => void revoke(device)}>
                  폐기
                </Button>
              </div>
            ) : null}
          </div>
        )) : (
          <div className="border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">이 계정에 등록된 포장 검수 기기가 없습니다.</div>
        )}
        {nextCursor ? (
          <Button type="button" variant="outline" disabled={isBusy} onClick={() => void loadDevices(nextCursor, true)}>다음 등록 불러오기</Button>
        ) : null}
      </div>
    </section>
  );
}
