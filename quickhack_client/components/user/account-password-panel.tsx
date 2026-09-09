// QuickHack note: 최초 변경 화면과 개인 설정에서 공통으로 사용하는 본인 비밀번호 변경 폼입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  PASSWORD_MIN_LENGTH,
  passwordChangeValidationIssue,
} from "@/quickhack_shared/auth/password-policy";

type PasswordChangeResponse = {
  ok: boolean;
  code?:
    | "CURRENT_PASSWORD_REQUIRED"
    | "NEW_PASSWORD_TOO_SHORT"
    | "NEW_PASSWORD_CONFIRM_MISMATCH"
    | "NEW_PASSWORD_UNCHANGED"
    | "CURRENT_PASSWORD_INVALID"
    | "ACCOUNT_SECURITY_CHANGED";
  message?: string;
  mustChangePassword?: boolean;
};

export function AccountPasswordPanel({
  forced = false,
  onChanged,
}: {
  forced?: boolean;
  onChanged?: () => void;
}) {
  const t = useTranslations("auth.passwordChange");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [isError, setIsError] = React.useState(false);

  async function submitPasswordChange(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const validationIssue = passwordChangeValidationIssue({
      currentPassword,
      newPassword,
      newPasswordConfirm,
    });

    if (validationIssue) {
      setIsError(true);
      setMessage(
        validationIssue === "CURRENT_PASSWORD_REQUIRED"
          ? t("validation.currentRequired")
          : validationIssue === "NEW_PASSWORD_TOO_SHORT"
            ? t("validation.tooShort", { count: PASSWORD_MIN_LENGTH })
            : validationIssue === "NEW_PASSWORD_CONFIRM_MISMATCH"
              ? t("validation.mismatch")
              : t("validation.unchanged")
      );
      return;
    }

    setIsSubmitting(true);
    setIsError(false);
    setMessage("");

    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          newPasswordConfirm,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | PasswordChangeResponse
        | null;

      if (!response.ok || !payload?.ok) {
        const code = payload?.code;
        throw new Error(
          code === "CURRENT_PASSWORD_REQUIRED"
            ? t("validation.currentRequired")
            : code === "NEW_PASSWORD_TOO_SHORT"
              ? t("validation.tooShort", { count: PASSWORD_MIN_LENGTH })
              : code === "NEW_PASSWORD_CONFIRM_MISMATCH"
                ? t("validation.mismatch")
                : code === "NEW_PASSWORD_UNCHANGED"
                  ? t("validation.unchanged")
                  : code === "CURRENT_PASSWORD_INVALID"
                    ? t("validation.currentInvalid")
                    : code === "ACCOUNT_SECURITY_CHANGED"
                      ? t("validation.securityChanged")
                      : legacyApiMessage(payload, t("failed"))
        );
      }

      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setIsError(false);
      setMessage(t("success"));
      onChanged?.();
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-md border bg-popover p-3">
      <div>
        <h2 className="text-sm font-semibold">
          {forced ? t("forcedTitle") : t("title")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {forced ? t("description.forced") : t("description.normal")}
        </p>
      </div>

      <form className="grid gap-3" onSubmit={submitPasswordChange}>
        <label className="grid gap-1.5 text-sm font-medium">
          {t("currentPassword")}
          <Input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            value={currentPassword}
            disabled={isSubmitting}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            {t("nextPassword")}
            <Input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              value={newPassword}
              disabled={isSubmitting}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            {t("confirmPassword")}
            <Input
              type="password"
              name="newPasswordConfirm"
              autoComplete="new-password"
              value={newPasswordConfirm}
              disabled={isSubmitting}
              onChange={(event) =>
                setNewPasswordConfirm(event.target.value)
              }
            />
          </label>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("minimum", { count: PASSWORD_MIN_LENGTH })}
        </p>

        {message ? (
          <div
            className={
              isError
                ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
            }
          >
            {message}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {isSubmitting ? t("submitting") : t("title")}
          </Button>
        </div>
      </form>
    </section>
  );
}
