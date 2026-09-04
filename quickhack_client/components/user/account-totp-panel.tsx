"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import Image from "next/image";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useUnsavedChanges } from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import { AccountFieldLabel } from "@/quickhack_client/components/user/account-information-fields";
import {
  ONE_TIME_RESULT_FORM_IDS,
} from "@/quickhack_client/components/user/mobile-registration-draft-state";
import {
  RecoveryCodeResult,
  useOneTimeRecoveryCodes,
} from "@/quickhack_client/components/security/recovery-code-result";

export type AccountTotpStatus = {
  configured: boolean;
  enabled: boolean;
  verifiedAt: string | null;
  lockedUntil: string | null;
  unusedRecoveryCodeCount: number;
  server: {
    configured: boolean;
    state:
      | "READY"
      | "CREDENTIALS_REQUIRE_EXISTING_KEY"
      | "INVALID_KEY_FILE"
      | "CREATE_FAILED"
      | "UNSUPPORTED_PLATFORM";
    protection: "WINDOWS_DPAPI_CURRENT_USER" | null;
    periodSeconds: number;
    digits: number;
    issuer: string;
  };
};

type TotpApiResponse = {
  ok: boolean;
  code?: string;
  details?: { remainingSeconds?: number };
  resultCode?: "OTP_DISABLED" | "OTP_RECOVERY_CODES_ISSUED";
  message?: string;
  status?: AccountTotpStatus;
  setup?: {
    secret: string;
    otpauthUri: string;
    enrollmentToken: string;
    periodSeconds: number;
    digits: number;
  };
  confirmed?: boolean;
  disabled?: boolean;
  recoveryCodes?: string[];
};

type AccountTotpPanelProps = {
  onStatusChange?: (status: AccountTotpStatus) => void;
};

function formatDateTime(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text.replace("T", " ").slice(0, 19) : "-";
}

export function AccountTotpPanel({ onStatusChange }: AccountTotpPanelProps) {
  const t = useTranslations("settings.accountTotp");
  const { runGuardedAction } = useUnsavedChanges();
  const [status, setStatus] = React.useState<AccountTotpStatus | null>(null);
  const [setup, setSetup] = React.useState<
    NonNullable<TotpApiResponse["setup"]> | null
  >(null);
  const [qrDataUrl, setQrDataUrl] = React.useState("");
  const [setupPassword, setSetupPassword] = React.useState("");
  const [setupCode, setSetupCode] = React.useState("");
  const [managementPassword, setManagementPassword] = React.useState("");
  const [managementCode, setManagementCode] = React.useState("");
  const recovery = useOneTimeRecoveryCodes({
    formId: ONE_TIME_RESULT_FORM_IDS.personalRecoveryCodes,
    label: t("recoveryLabel"),
  });
  const recoveryCodes = recovery.codes;
  const setRecoveryCodes = recovery.setCodes;
  const [message, setMessage] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(true);
  const [busyAction, setBusyAction] = React.useState("");

  const loadStatus = React.useCallback(async () => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/totp", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | TotpApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.status) {
        throw new Error(legacyApiMessage(payload, t("message.statusFailed")));
      }

      setStatus(payload.status);
      onStatusChange?.(payload.status);
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [onStatusChange, t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timerId);
  }, [loadStatus]);

  React.useEffect(() => {
    if (!setup?.otpauthUri) {
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(setup.otpauthUri, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 6,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessage(t("message.qrFailed"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setup?.otpauthUri, t]);

  async function postAction(body: Record<string, unknown>) {
    const response = await fetch("/api/auth/totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | TotpApiResponse
      | null;

    if (!response.ok || !payload?.ok) {
      const errorKey = {
        OTP_CODE_INVALID: "codeInvalid",
        OTP_NOT_CONFIGURED: "notConfigured",
        OTP_ACTION_UNSUPPORTED: "actionUnsupported",
        AUTH_REQUIRED: "authRequired",
        INVALID_BODY: "invalidBody",
      }[payload?.code ?? ""];
      throw new Error(
        payload?.code === "OTP_RATE_LIMITED"
          ? t("message.rateLimited", {
              seconds: payload.details?.remainingSeconds ?? 0,
            })
          : errorKey
            ? t(`message.${errorKey}` as "message.codeInvalid")
            : legacyApiMessage(payload, t("message.actionFailed"))
      );
    }

    return payload;
  }

  async function startSetup() {
    if (!setupPassword || busyAction) {
      return;
    }

    setBusyAction("setup");
    setMessage("");

    try {
      const payload = await postAction({ action: "setup", password: setupPassword });

      if (!payload.setup) {
        throw new Error(t("message.setupMissing"));
      }

      setQrDataUrl("");
      setSetup(payload.setup);
      setSetupPassword("");
      setMessage(t("message.enterCode"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function confirmSetup() {
    if (!setupCode || busyAction) {
      return;
    }

    setBusyAction("confirm");
    setMessage("");

    try {
      const payload = await postAction({
        action: "confirm",
        code: setupCode,
        enrollmentToken: setup?.enrollmentToken,
      });

      if (!payload.confirmed) {
        throw new Error(t("message.confirmFailed"));
      }

      setRecoveryCodes(payload.recoveryCodes ?? []);
      setSetup(null);
      setQrDataUrl("");
      setSetupCode("");
      setMessage(t("message.confirmed"));
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function manageOtp(action: "recoveryCodes" | "disable") {
    if (!managementPassword || !managementCode || busyAction) {
      setMessage(t("message.credentialsRequired"));
      return;
    }

    setBusyAction(action);
    setMessage("");

    try {
      const payload = await postAction({
        action,
        password: managementPassword,
        code: managementCode,
      });
      setManagementPassword("");
      setManagementCode("");
      setRecoveryCodes(payload.recoveryCodes ?? []);
      setMessage(
        payload.resultCode === "OTP_DISABLED"
          ? t("message.disabled")
          : t("message.recoveryIssued")
      );
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  function requestConfirmSetup() {
    if (!setupCode || busyAction) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.personalRecoveryCodes],
      targetLabel: t("guarded.confirm"),
      action: () => {
        void confirmSetup();
      },
    });
  }

  function requestManageOtp(action: "recoveryCodes" | "disable") {
    if (!managementPassword || !managementCode || busyAction) {
      setMessage(t("message.credentialsRequired"));
      return;
    }

    if (
      action === "disable" &&
      !window.confirm(t("guarded.disableConfirm"))
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.personalRecoveryCodes],
      targetLabel:
        action === "disable" ? t("guarded.disable") : t("guarded.recovery"),
      action: () => {
        void manageOtp(action);
      },
    });
  }

  return (
    <section className="overflow-hidden rounded-md border bg-popover">
      <div className="flex items-start justify-between gap-3 p-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("title")}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Badge variant={status?.enabled ? "success" : "neutral"}>
          {isLoading ? t("status.checking") : status?.enabled ? t("status.configured") : t("status.unconfigured")}
        </Badge>
      </div>

      {message ? (
        <div className="border-t bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          {message}
        </div>
      ) : null}

      {!isLoading && status && !status.server.configured ? (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("unavailable")}
        </div>
      ) : null}

      {!isLoading && status?.server.configured && !status.enabled ? (
        <div className="grid gap-3 border-t p-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <AccountFieldLabel label={t("setup.password")}>
              <Input
                type="password"
                autoComplete="current-password"
                value={setupPassword}
                disabled={Boolean(busyAction)}
                onChange={(event) => setSetupPassword(event.target.value)}
              />
            </AccountFieldLabel>
            <Button
              type="button"
              variant="outline"
              className="self-end"
              disabled={!setupPassword || Boolean(busyAction)}
              onClick={() => void startSetup()}
            >
              <KeyRound className="size-4" />
              {t("setup.start")}
            </Button>
          </div>

          {setup ? (
            <div className="grid gap-3 border-t pt-3">
              <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
                <div className="grid justify-items-center gap-2 border bg-white p-3">
                  {qrDataUrl ? (
                    <Image
                      src={qrDataUrl}
                      alt={t("setup.qrAlt")}
                      width={176}
                      height={176}
                      unoptimized
                      className="size-44"
                    />
                  ) : (
                    <div className="grid size-44 place-items-center text-xs text-muted-foreground">
                      {t("setup.qrLoading")}
                    </div>
                  )}
                  <span className="text-center text-xs text-muted-foreground">
                    {t("setup.qrHint")}
                  </span>
                </div>
                <div className="grid min-w-0 content-start gap-3">
                  <div>
                    <div className="text-xs font-semibold">{t("setup.secret")}</div>
                    <div className="mt-1 break-all border bg-secondary px-2 py-1 font-mono text-xs">
                      {setup.secret}
                    </div>
                  </div>
                  <AccountFieldLabel label={t("setup.code")}>
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={setupCode}
                      disabled={Boolean(busyAction)}
                      onChange={(event) => setSetupCode(event.target.value)}
                    />
                  </AccountFieldLabel>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!setupCode || Boolean(busyAction)}
                    onClick={requestConfirmSetup}
                  >
                    {t("setup.confirm")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isLoading && status?.enabled ? (
        <div className="grid gap-3 border-t p-3">
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <div className="text-muted-foreground">{t("management.verifiedAt")}</div>
              <div className="mt-1 tabular-nums">{formatDateTime(status.verifiedAt)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("management.lockedUntil")}</div>
              <div className="mt-1 tabular-nums">{formatDateTime(status.lockedUntil)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("management.recoveryRemaining")}</div>
              <div className="mt-1 tabular-nums">{t("management.recoveryCount", { count: status.unusedRecoveryCodeCount })}</div>
            </div>
          </div>
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <AccountFieldLabel label={t("management.password")}>
              <Input
                type="password"
                autoComplete="current-password"
                value={managementPassword}
                disabled={Boolean(busyAction)}
                onChange={(event) => setManagementPassword(event.target.value)}
              />
            </AccountFieldLabel>
            <AccountFieldLabel label={t("management.code")}>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={managementCode}
                disabled={Boolean(busyAction)}
                onChange={(event) => setManagementCode(event.target.value)}
              />
            </AccountFieldLabel>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(busyAction)}
              onClick={() => requestManageOtp("recoveryCodes")}
            >
              <KeyRound className="size-4" />
              {t("management.reissue")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
              disabled={Boolean(busyAction)}
              onClick={() => requestManageOtp("disable")}
            >
              <ShieldOff className="size-4" />
              {t("management.disable")}
            </Button>
          </div>
        </div>
      ) : null}

      <RecoveryCodeResult
        codes={recoveryCodes}
        acknowledged={recovery.acknowledged}
        onAcknowledge={recovery.acknowledge}
      />
    </section>
  );
}
