"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { RefreshCcw, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
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
  ADB_CLIENT_API_MESSAGE_KEYS,
  isAdbClientApiCode,
} from "@/quickhack_client/api/adb/client-api-codes";
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
  code?: string;
  message?: string;
  details?: string;
  items?: MobileDevice[];
  nextCursor?: string | null;
  hasMore?: boolean;
  activeCount?: number;
};

type AdbDevice = { serial?: string; connectionState?: string; modelCode?: string };
type AdbDevicesResponse = { ok: boolean; code?: string; message?: string; details?: string; devices?: AdbDevice[] };

function formatDateTime(value: string | null | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.replace("T", " ").slice(0, 19) : "-";
}

export function AccountMobileAppPanel({
  permissionEnabled,
  onActiveCountChange,
}: {
  permissionEnabled: boolean;
  onActiveCountChange?: (count: number) => void;
}) {
  const t = useTranslations("settings.mobileApp");
  const adbT = useTranslations("common.adbApi");
  const [devices, setDevices] = React.useState<MobileDevice[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [adbDevices, setAdbDevices] = React.useState<AdbDevice[]>([]);
  const [registrationDraft, setRegistrationDraft] = React.useState(emptyMobileRegistrationDraft);
  const [registrationBaseline, setRegistrationBaseline] = React.useState(emptyMobileRegistrationDraft);
  const [message, setMessage] = React.useState("");
  const [isBusy, setIsBusy] = React.useState(false);

  useUnsavedForm({
    id: MOBILE_REGISTRATION_FORM_IDS.personal,
    label: t("formLabel"),
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
        throw new Error(legacyApiMessage(payload, t("message.loadFailed")));
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
    [onActiveCountChange, t]
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
      if (!response.ok || !payload?.ok) {
        const localized = isAdbClientApiCode(payload?.code)
          ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code])
          : legacyApiMessage(payload, t("message.adbLoadFailed"));
        throw new Error(localized || t("message.adbLoadFailed"));
      }
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
      setMessage(items.length ? t("message.adbUpdated") : t("message.adbEmpty"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function provision(device?: MobileDevice) {
    if (!permissionEnabled) {
      setMessage(t("permission.message"));
      return;
    }
    if (!registrationDraft.adbSerial.trim()) {
      setMessage(t("message.selectDevice"));
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
      if (!response.ok || !payload?.ok) {
        const localized = isAdbClientApiCode(payload?.code)
          ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code])
          : legacyApiMessage(payload, t("message.provisionFailed"));
        throw new Error(
          [localized || t("message.provisionFailed"), payload?.details].filter(Boolean).join(" ")
        );
      }
      const empty = emptyMobileRegistrationDraft();
      setRegistrationDraft(empty);
      setRegistrationBaseline(empty);
      setMessage(
        isAdbClientApiCode(payload.code)
          ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code])
          : t("message.provisioned")
      );
      await loadDevices();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function revoke(device: MobileDevice) {
    if (!window.confirm(t("revokeConfirm", { device: device.label || device.adbSerialPreview }))) return;
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
      if (!response.ok || !payload?.ok) throw new Error(legacyApiMessage(payload, t("message.revokeFailed")));
      setMessage(t("message.revoked"));
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
            <h2 className="text-sm font-semibold">{t("title")}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Badge variant={permissionEnabled ? "success" : "neutral"}>
          {permissionEnabled ? t("permission.allowed") : t("permission.denied")}
        </Badge>
      </div>

      {message ? <div className="border-t bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">{message}</div> : null}

      <div className="grid gap-3 border-t p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <AccountFieldLabel label={t("device")}>
            <Select
              value={registrationDraft.adbSerial || "NONE"}
              disabled={isBusy || !permissionEnabled}
              onValueChange={(value) =>
                setRegistrationDraft((current) => ({ ...current, adbSerial: value === "NONE" ? "" : value }))
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">{t("select")}</SelectItem>
                {adbDevices.map((device) => (
                  <SelectItem key={device.serial} value={String(device.serial)}>
                    {String(device.serial)} / {String(device.modelCode ?? "-")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </AccountFieldLabel>
          <Button type="button" variant="outline" className="self-end" disabled={isBusy || !permissionEnabled} onClick={() => void loadAdbDevices()}>
            <RefreshCcw className="size-4" /> {t("refresh")}
          </Button>
        </div>
        <AccountFieldLabel label={t("label")}>
          <Input
            value={registrationDraft.label}
            placeholder={t("labelPlaceholder")}
            disabled={isBusy || !permissionEnabled}
            onChange={(event) => setRegistrationDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </AccountFieldLabel>
        <Button type="button" variant="outline" disabled={isBusy || !permissionEnabled || !registrationDraft.adbSerial} onClick={() => void provision()}>
          <Smartphone className="size-4" /> {t("register")}
        </Button>
      </div>

      <div className="grid gap-2 border-t p-3">
        {devices.length ? devices.map((device) => (
          <div key={device.deviceId} className="grid gap-2 border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold">{device.label || device.adbSerialPreview}</div>
                <div className="font-mono text-muted-foreground">
                  {device.adbSerialPreview} · {t("revision", { revision: device.registrationRevision })}
                </div>
              </div>
              <Badge variant={device.registrationState === "ACTIVE" ? "success" : device.registrationState === "REVOKED" ? "neutral" : "warning"}>
                {t(`state.${device.registrationState === "ACTIVE" ? "active" : device.registrationState === "PROVISIONING" ? "provisioning" : device.registrationState === "REAUTH_REQUIRED" ? "reauthRequired" : "revoked"}`)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>{t("activatedAt")} <span className="tabular-nums">{formatDateTime(device.activatedAt)}</span></div>
              <div>{t("lastSeenAt")} <span className="tabular-nums">{formatDateTime(device.lastSeenAt)}</span></div>
            </div>
            {device.registrationState !== "REVOKED" ? (
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" disabled={isBusy || !permissionEnabled || !registrationDraft.adbSerial} onClick={() => void provision(device)}>
                  {t("reregister")}
                </Button>
                <Button type="button" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800" disabled={isBusy} onClick={() => void revoke(device)}>
                  {t("revoke")}
                </Button>
              </div>
            ) : null}
          </div>
        )) : (
          <div className="border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">{t("empty")}</div>
        )}
        {nextCursor ? (
          <Button type="button" variant="outline" disabled={isBusy} onClick={() => void loadDevices(nextCursor, true)}>{t("loadMore")}</Button>
        ) : null}
      </div>
    </section>
  );
}
