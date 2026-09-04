// QuickHack note: 직원 계정 로그인 폼과 로그인 실패 메시지를 표시하는 초기 화면입니다.
﻿"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { Database, Loader2, LogIn } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import { normalizeAccountUsername } from "@/quickhack_shared/auth/account-username";
import { writeLocaleCookie } from "@/quickhack_client/i18n/locale-client";
import { isQuickHackLocale } from "@/quickhack_shared/i18n/locales";

type LoginScreenProps = {
  initialError?: string;
  initialErrorCode?:
    | "INVALID_SERVER_RESPONSE"
    | "SERVER_PROXY_UNAVAILABLE"
    | "SERVER_PROXY_TIMEOUT"
    | "SERVER_PROXY_INVALID_RESPONSE"
    | "SERVER_PROXY_UPSTREAM_ERROR";
  showTestCredentials?: boolean;
};

export function LoginScreen({
  initialError = "",
  initialErrorCode,
  showTestCredentials = false,
}: LoginScreenProps) {
  const t = useTranslations("auth.login");
  const [username, setUsername] = React.useState(
    showTestCredentials ? "leader" : ""
  );
  const [password, setPassword] = React.useState(
    showTestCredentials ? "QuickHack!234" : ""
  );
  const [error, setError] = React.useState(
    initialErrorCode === "INVALID_SERVER_RESPONSE" || initialErrorCode === "SERVER_PROXY_INVALID_RESPONSE"
      ? t("errors.invalidServerResponse")
      : initialErrorCode === "SERVER_PROXY_TIMEOUT"
        ? t("errors.timeout")
        : initialErrorCode
          ? t("errors.unavailable")
          : initialError
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: normalizeAccountUsername(username),
          password,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        code?: string;
        message?: string;
        details?: { remainingSeconds?: number };
        locale?: unknown;
      } | null;

      if (!response.ok || !payload?.ok) {
        const errorKey = {
          LOGIN_INVALID_CREDENTIALS: "invalidCredentials",
          REQUEST_BODY_TOO_LARGE: "bodyTooLarge",
          LOGIN_CREDENTIALS_REQUIRED: "credentialsRequired",
          LOGIN_REQUEST_INVALID: "invalidRequest",
        }[payload?.code ?? ""];
        setError(
          payload?.code === "LOGIN_RATE_LIMITED"
            ? t("errors.rateLimited", {
                seconds: payload.details?.remainingSeconds ?? 0,
              })
            : errorKey
              ? t(`errors.${errorKey}` as "errors.invalidCredentials")
              : legacyApiMessage(payload, t("errors.failed"))
        );
        return;
      }

      if (isQuickHackLocale(payload.locale)) writeLocaleCookie(payload.locale);

      window.location.reload();
    } catch {
      setError(t("errors.unavailable"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="grid w-full max-w-[920px] overflow-hidden rounded-md border bg-popover shadow-sm md:grid-cols-[1fr_380px]">
        <div className="flex min-h-[520px] flex-col justify-between border-b bg-secondary/55 p-8 md:border-b-0 md:border-r">
          <div>
            <div className="mb-6 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Database className="size-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold">QuickHack</h1>
                <p className="text-sm text-muted-foreground">{t("brandSubtitle")}</p>
              </div>
            </div>
            <div className="max-w-md">
              <h2 className="text-2xl font-semibold tracking-normal">
                {t("heroTitle")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {t("heroDescription")}
              </p>
            </div>
          </div>

          {showTestCredentials ? (
            <div className="grid gap-2 text-xs text-muted-foreground">
              <div className="grid grid-cols-[88px_1fr]">
                <span>{t("testAccount")}</span>
                <span>leader / manager / staff / viewer</span>
              </div>
              <div className="grid grid-cols-[88px_1fr]">
                <span>{t("password")}</span>
                <span>QuickHack!234</span>
              </div>
            </div>
          ) : null}
        </div>

        <form className="flex flex-col justify-center gap-5 p-8" onSubmit={handleSubmit}>
          <div>
            <h2 className="text-base font-semibold">{t("title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("description")}
            </p>
          </div>

          <div className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium">
              {t("username")}
              <Input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) =>
                  setUsername(normalizeAccountUsername(event.target.value))
                }
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t("password")}
              <Input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </div>

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogIn className="size-4" />
            )}
            {isSubmitting ? t("pending") : t("submit")}
          </Button>
        </form>
      </section>
    </main>
  );
}
