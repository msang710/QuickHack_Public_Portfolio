// QuickHack note: 위험 메뉴와 위험 작업 실행 전에 2차 인증/확인 UI를 제공하는 공통 보호 컴포넌트입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import { sensitiveActionForMenu } from "@/quickhack_shared/auth/sensitive-auth";
import {
  RecoveryCodeResult,
  useOneTimeRecoveryCodes,
} from "@/quickhack_client/components/security/recovery-code-result";
import { ONE_TIME_RESULT_FORM_IDS } from "@/quickhack_client/components/user/mobile-registration-draft-state";

export type SensitiveAuthApiResponse = {
  ok: boolean;
  message?: string;
  authenticated?: boolean;
  sensitiveAuthenticated?: boolean;
  sensitiveAction?: string;
  sensitiveAuthMaxAgeSeconds?: number;
};

type TotpStatusResponse = {
  ok: boolean;
  message?: string;
  status?: {
    configured: boolean;
    enabled: boolean;
    verifiedAt: string | null;
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
};

type TotpSetupResponse = {
  ok: boolean;
  message?: string;
  setup?: {
    secret: string;
    otpauthUri: string;
    enrollmentToken: string;
    periodSeconds: number;
    digits: number;
  };
  confirmed?: boolean;
  recoveryCodes?: string[];
};

type TotpStatus = NonNullable<TotpStatusResponse["status"]>;

export const dangerousActionButtonClassName =
  "border-red-700 bg-red-600 font-bold text-white shadow-sm hover:border-red-800 hover:bg-red-700 hover:text-white focus-visible:ring-red-600";

export function SensitiveMenuGate({
  item,
  children,
}: {
  item: { id: string; label: string };
  children: React.ReactNode;
}) {
  const t = useTranslations("auth.sensitiveAction");
  const [verificationCode, setVerificationCode] = React.useState("");
  const [isChecking, setIsChecking] = React.useState(true);
  const [isVerified, setIsVerified] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [totpStatus, setTotpStatus] = React.useState<TotpStatus | null>(null);
  const [totpMessage, setTotpMessage] = React.useState("");
  const [totpSetupPassword, setTotpSetupPassword] = React.useState("");
  const [totpSetupCode, setTotpSetupCode] = React.useState("");
  const [totpSetup, setTotpSetup] = React.useState<TotpSetupResponse["setup"] | null>(null);
  const [totpQrDataUrl, setTotpQrDataUrl] = React.useState("");
  const [isTotpLoading, setIsTotpLoading] = React.useState(false);
  const [isTotpSettingUp, setIsTotpSettingUp] = React.useState(false);
  const [isTotpConfirming, setIsTotpConfirming] = React.useState(false);
  const recovery = useOneTimeRecoveryCodes({
    formId: ONE_TIME_RESULT_FORM_IDS.sensitiveRecoveryCodes,
    label: t("recoveryLabel"),
  });
  const sensitiveAction = React.useMemo(() => sensitiveActionForMenu(item.id), [item.id]);

  const loadTotpStatus = React.useCallback(async () => {
    setIsTotpLoading(true);

    try {
      const response = await fetch("/api/auth/totp", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | TotpStatusResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.status) {
        throw new Error(legacyApiMessage(payload, t("message.statusFailed")));
      }

      setTotpStatus(payload.status);
    } catch (error) {
      setTotpStatus(null);
      setTotpMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTotpLoading(false);
    }
  }, [t]);

  const checkSensitiveStatus = React.useCallback(async () => {
    setIsChecking(true);

    try {
      if (!sensitiveAction) {
        throw new Error(t("message.invalidMenu"));
      }

      const response = await fetch(
        `/api/auth/sensitive-status?action=${encodeURIComponent(sensitiveAction)}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | SensitiveAuthApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("message.authStatusFailed")));
      }

      setIsVerified(Boolean(payload.sensitiveAuthenticated));
    } catch (error) {
      setIsVerified(false);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsChecking(false);
    }
  }, [sensitiveAction, t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void checkSensitiveStatus();
      void loadTotpStatus();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [checkSensitiveStatus, item.id, loadTotpStatus]);

  React.useEffect(() => {
    let cancelled = false;

    if (!totpSetup?.otpauthUri) {
      const timerId = window.setTimeout(() => setTotpQrDataUrl(""), 0);
      return () => window.clearTimeout(timerId);
    }

    QRCode.toDataURL(totpSetup.otpauthUri, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 6,
      color: {
        dark: "#111827",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setTotpQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTotpQrDataUrl("");
          setTotpMessage(t("message.qrFailed"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [totpSetup?.otpauthUri, t]);

  async function verifySensitiveAccess() {
    if (!verificationCode || isSubmitting || !sensitiveAction) {
      return;
    }
    if (recovery.codes.length > 0 && !recovery.acknowledged) {
      setMessage(t("recoveryRequired"));
      return;
    }

    setIsSubmitting(true);
    setMessage("");

    try {
      const response = await fetch("/api/auth/sensitive-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          otpCode: verificationCode,
          sensitiveAction,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | SensitiveAuthApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.sensitiveAuthenticated) {
        throw new Error(legacyApiMessage(payload, t("message.verifyFailed")));
      }

      setVerificationCode("");
      setIsVerified(true);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function startTotpSetup() {
    if (!totpSetupPassword || isTotpSettingUp) {
      return;
    }

    setIsTotpSettingUp(true);
    setTotpMessage("");

    try {
      const response = await fetch("/api/auth/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "setup",
          password: totpSetupPassword,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | TotpSetupResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.setup) {
        throw new Error(legacyApiMessage(payload, t("message.setupStartFailed")));
      }

      setTotpSetup(payload.setup);
      setTotpSetupPassword("");
      setTotpMessage(t("message.setupCodePrompt"));
    } catch (error) {
      setTotpMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTotpSettingUp(false);
    }
  }

  async function confirmTotpSetup() {
    if (!totpSetupCode || isTotpConfirming) {
      return;
    }

    setIsTotpConfirming(true);
    setTotpMessage("");

    try {
      const response = await fetch("/api/auth/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          code: totpSetupCode,
          enrollmentToken: totpSetup?.enrollmentToken,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | TotpSetupResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.confirmed) {
        throw new Error(legacyApiMessage(payload, t("message.setupConfirmFailed")));
      }

      setTotpSetup(null);
      recovery.setCodes(payload.recoveryCodes ?? []);
      setTotpSetupCode("");
      setTotpQrDataUrl("");
      setTotpMessage(t("message.setupComplete"));
      await loadTotpStatus();
    } catch (error) {
      setTotpMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTotpConfirming(false);
    }
  }

  if (isVerified) {
    return <>{children}</>;
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-auto p-5">
      <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(360px,440px)_minmax(420px,1fr)]">
        <div className="grid self-start rounded-md border bg-popover p-6">
          <div className="grid gap-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                <ShieldCheck className="size-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">{t("title")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("description", { menu: item.label })}
                </p>
              </div>
            </div>

            <label className="grid gap-1.5 text-sm font-medium">
              {t("code")}
              <input
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                name="quickhack_sensitive_otp_username_sink"
                autoComplete="username"
                data-form-type="username"
                value="quickhack"
                readOnly
              />
              <Input
                type="text"
                inputMode="numeric"
                name="quickhack_sensitive_otp_code"
                autoComplete="one-time-code"
                data-form-type="one-time-code"
                data-lpignore="true"
                data-1p-ignore="true"
                value={verificationCode}
                disabled={isChecking || isSubmitting}
                onChange={(event) => setVerificationCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void verifySensitiveAccess();
                  }
                }}
              />
            </label>

            {message ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {message}
              </div>
            ) : null}

            <Button
              onClick={verifySensitiveAccess}
              disabled={
                !verificationCode ||
                isChecking ||
                isSubmitting ||
                (recovery.codes.length > 0 && !recovery.acknowledged)
              }
            >
              <ShieldCheck className="size-4" />
              {isChecking
                ? t("checking")
                : isSubmitting
                  ? t("submitting")
                  : t("open")}
            </Button>
          </div>
        </div>

        <aside className="grid max-h-[calc(100vh-2.5rem)] gap-3 self-start overflow-auto rounded-md border bg-popover p-4 text-sm">
          <div>
            <div className="font-semibold">{t("setup.title")}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("setup.description")}
            </p>
          </div>

          {isTotpLoading ? (
            <div className="rounded-md border bg-background px-3 py-2 text-muted-foreground">
              {t("setup.loading")}
            </div>
          ) : totpStatus?.enabled ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
              {t("setup.enabled")}
            </div>
          ) : totpStatus && !totpStatus.server.configured ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
              {t("setup.unavailable")}
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-2 rounded-md border bg-secondary/30 p-3">
                <label className="grid gap-1.5 text-xs font-medium">
                  {t("setup.password")}
                  <input
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    name="quickhack_totp_setup_username"
                    autoComplete="username"
                    data-form-type="username"
                    value="quickhack"
                    readOnly
                  />
                  <Input
                    type="password"
                    name="quickhack_totp_setup_current_password"
                    autoComplete="current-password"
                    data-form-type="password"
                    value={totpSetupPassword}
                    disabled={isTotpSettingUp}
                    onChange={(event) => setTotpSetupPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void startTotpSetup();
                      }
                    }}
                  />
                </label>
                <Button
                  variant="outline"
                  onClick={startTotpSetup}
                  disabled={!totpSetupPassword || isTotpSettingUp}
                >
                  {t("setup.start")}
                </Button>
              </div>

              {totpSetup ? (
                <div className="grid gap-3 rounded-md border bg-background p-3">
                  <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
                    <div className="grid justify-items-center gap-2 rounded-md border bg-white p-3">
                      {totpQrDataUrl ? (
                        <img
                          src={totpQrDataUrl}
                          alt={t("setup.qrAlt")}
                          className="size-44"
                        />
                      ) : (
                        <div className="grid size-44 place-items-center text-center text-xs text-muted-foreground">
                          {t("setup.qrLoading")}
                        </div>
                      )}
                      <div className="text-center text-xs text-muted-foreground">
                        {t("setup.qrHint")}
                      </div>
                    </div>

                    <div className="grid min-w-0 content-start gap-2">
                      <div className="grid gap-1">
                        <div className="text-xs font-semibold">{t("setup.secret")}</div>
                        <div className="break-all rounded border bg-secondary px-2 py-1 font-mono text-xs">
                          {totpSetup.secret}
                        </div>
                      </div>
                      <div className="grid gap-1">
                        <div className="text-xs font-semibold">{t("setup.uri")}</div>
                        <div className="max-h-20 overflow-auto break-all rounded border bg-secondary px-2 py-1 font-mono text-xs">
                          {totpSetup.otpauthUri}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <label className="grid gap-1.5 text-xs font-medium">
                      {t("setup.code")}
                      <Input
                        inputMode="numeric"
                        name="quickhack_totp_setup_code"
                        autoComplete="one-time-code"
                        data-form-type="one-time-code"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        value={totpSetupCode}
                        disabled={isTotpConfirming}
                        onChange={(event) => setTotpSetupCode(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void confirmTotpSetup();
                          }
                        }}
                      />
                    </label>
                    <Button
                      className="self-end"
                      variant="outline"
                      onClick={confirmTotpSetup}
                      disabled={!totpSetupCode || isTotpConfirming}
                    >
                      {t("setup.confirm")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {totpMessage ? (
            <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">
              {totpMessage}
            </div>
          ) : null}
          <RecoveryCodeResult
            codes={recovery.codes}
            acknowledged={recovery.acknowledged}
            onAcknowledge={recovery.acknowledge}
          />
        </aside>
      </div>
    </section>
  );
}

export function DangerousConfirmDialog({
  open,
  title,
  description,
  detail,
  confirmLabel,
  busyLabel,
  isBusy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  detail?: React.ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  isBusy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("auth.sensitiveAction.dialog");
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
      <div className="grid w-full max-w-md gap-4 rounded-md border border-red-200 bg-popover p-5 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-red-100 text-red-700">
            <AlertTriangle className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-red-700">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        {detail ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
            {detail}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isBusy}>
            {t("cancel")}
          </Button>
          <Button
            variant="outline"
            className={dangerousActionButtonClassName}
            onClick={onConfirm}
            disabled={isBusy}
          >
            <AlertTriangle className="size-4" />
            {isBusy ? busyLabel || t("busy") : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
