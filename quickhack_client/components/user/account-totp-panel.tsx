"use client";

import * as React from "react";
import Image from "next/image";
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
    label: "내 OTP 복구코드",
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
        throw new Error(payload?.message || "OTP 상태를 확인하지 못했습니다.");
      }

      setStatus(payload.status);
      onStatusChange?.(payload.status);
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [onStatusChange]);

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
          setMessage("QR 코드를 만들지 못했습니다. 등록 키를 직접 입력하세요.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setup?.otpauthUri]);

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
      throw new Error(payload?.message || "OTP 작업을 처리하지 못했습니다.");
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
        throw new Error("OTP 등록 정보를 받지 못했습니다.");
      }

      setQrDataUrl("");
      setSetup(payload.setup);
      setSetupPassword("");
      setMessage("인증 앱에 등록한 뒤 표시되는 6자리 코드를 입력하세요.");
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
        throw new Error("OTP 등록을 완료하지 못했습니다.");
      }

      setRecoveryCodes(payload.recoveryCodes ?? []);
      setSetup(null);
      setQrDataUrl("");
      setSetupCode("");
      setMessage("OTP 등록이 완료되었습니다. 복구코드는 지금 안전한 곳에 보관하세요.");
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function manageOtp(action: "recoveryCodes" | "disable") {
    if (!managementPassword || !managementCode || busyAction) {
      setMessage("현재 비밀번호와 OTP 6자리 코드를 모두 입력하세요.");
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
        payload.message ||
          (action === "disable"
            ? "OTP 2차 인증을 해제했습니다."
            : "복구코드를 새로 발급했습니다.")
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
      targetLabel: "OTP 등록 완료",
      action: () => {
        void confirmSetup();
      },
    });
  }

  function requestManageOtp(action: "recoveryCodes" | "disable") {
    if (!managementPassword || !managementCode || busyAction) {
      setMessage("현재 비밀번호와 OTP 6자리 코드를 모두 입력하세요.");
      return;
    }

    if (
      action === "disable" &&
      !window.confirm("이 계정의 OTP 2차 인증을 해제할까요?")
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.personalRecoveryCodes],
      targetLabel:
        action === "disable" ? "OTP 2차 인증 해제" : "OTP 복구코드 재발급",
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
            <h2 className="text-sm font-semibold">OTP 2차 인증</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            민감한 메뉴를 열 때 인증 앱의 6자리 코드로 본인을 확인합니다.
          </p>
        </div>
        <Badge variant={status?.enabled ? "success" : "neutral"}>
          {isLoading ? "확인 중" : status?.enabled ? "설정됨" : "미설정"}
        </Badge>
      </div>

      {message ? (
        <div className="border-t bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          {message}
        </div>
      ) : null}

      {!isLoading && status && !status.server.configured ? (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          OTP 보안 서비스를 사용할 수 없어 OTP 등록과 보호된 작업이 차단되었습니다.
          관리자는 QuickHack 본서버 콘솔에서 OTP 보안 상태를 확인해야 합니다.
        </div>
      ) : null}

      {!isLoading && status?.server.configured && !status.enabled ? (
        <div className="grid gap-3 border-t p-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <AccountFieldLabel label="현재 비밀번호">
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
              OTP 등록 시작
            </Button>
          </div>

          {setup ? (
            <div className="grid gap-3 border-t pt-3">
              <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
                <div className="grid justify-items-center gap-2 border bg-white p-3">
                  {qrDataUrl ? (
                    <Image
                      src={qrDataUrl}
                      alt="OTP 등록 QR 코드"
                      width={176}
                      height={176}
                      unoptimized
                      className="size-44"
                    />
                  ) : (
                    <div className="grid size-44 place-items-center text-xs text-muted-foreground">
                      QR 코드 생성 중
                    </div>
                  )}
                  <span className="text-center text-xs text-muted-foreground">
                    인증 앱에서 QR 코드를 스캔하세요.
                  </span>
                </div>
                <div className="grid min-w-0 content-start gap-3">
                  <div>
                    <div className="text-xs font-semibold">인증 앱 등록 키</div>
                    <div className="mt-1 break-all border bg-secondary px-2 py-1 font-mono text-xs">
                      {setup.secret}
                    </div>
                  </div>
                  <AccountFieldLabel label="인증 앱 6자리 코드">
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
                    OTP 등록 완료
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
              <div className="text-muted-foreground">등록일시</div>
              <div className="mt-1 tabular-nums">{formatDateTime(status.verifiedAt)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">잠금 만료</div>
              <div className="mt-1 tabular-nums">{formatDateTime(status.lockedUntil)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">남은 복구코드</div>
              <div className="mt-1 tabular-nums">{status.unusedRecoveryCodeCount}개</div>
            </div>
          </div>
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <AccountFieldLabel label="현재 비밀번호">
              <Input
                type="password"
                autoComplete="current-password"
                value={managementPassword}
                disabled={Boolean(busyAction)}
                onChange={(event) => setManagementPassword(event.target.value)}
              />
            </AccountFieldLabel>
            <AccountFieldLabel label="현재 OTP 6자리 코드">
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
              복구코드 재발급
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
              disabled={Boolean(busyAction)}
              onClick={() => requestManageOtp("disable")}
            >
              <ShieldOff className="size-4" />
              OTP 해제
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
