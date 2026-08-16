// QuickHack note: 최초 변경 화면과 개인 설정에서 공통으로 사용하는 본인 비밀번호 변경 폼입니다.
"use client";

import * as React from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  PASSWORD_MIN_LENGTH,
  passwordChangeValidationError,
} from "@/quickhack_shared/auth/password-policy";

type PasswordChangeResponse = {
  ok: boolean;
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

    const validationError = passwordChangeValidationError({
      currentPassword,
      newPassword,
      newPasswordConfirm,
    });

    if (validationError) {
      setIsError(true);
      setMessage(validationError);
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
        throw new Error(
          payload?.message || "비밀번호를 변경하지 못했습니다."
        );
      }

      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setIsError(false);
      setMessage(payload.message || "비밀번호를 변경했습니다.");
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
          {forced ? "새 비밀번호 설정" : "비밀번호 변경"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {forced
            ? "임시 비밀번호를 본인만 아는 새 비밀번호로 변경해야 업무 화면을 사용할 수 있습니다."
            : "변경이 완료되면 다른 PC를 포함한 기존 로그인 세션이 모두 종료됩니다."}
        </p>
      </div>

      <form className="grid gap-3" onSubmit={submitPasswordChange}>
        <label className="grid gap-1.5 text-sm font-medium">
          현재 비밀번호
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
            새 비밀번호
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
            새 비밀번호 확인
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
          새 비밀번호는 {PASSWORD_MIN_LENGTH}자 이상이어야 합니다.
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
            {isSubmitting ? "변경 중" : "비밀번호 변경"}
          </Button>
        </div>
      </form>
    </section>
  );
}
