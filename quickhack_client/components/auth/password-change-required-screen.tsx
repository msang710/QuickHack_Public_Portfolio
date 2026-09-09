// QuickHack note: 임시 비밀번호 사용자가 일반 업무 전에 반드시 완료하는 비밀번호 변경 화면입니다.
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Database, Loader2, LogOut } from "lucide-react";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { Button } from "@/quickhack_client/components/ui/button";
import { AccountPasswordPanel } from "@/quickhack_client/components/user/account-password-panel";
import { requestQuickHackLogout } from "@/quickhack_client/auth/logout";

export function PasswordChangeRequiredScreen({
  currentUser,
}: {
  currentUser: AuthUser;
}) {
  const t = useTranslations("auth.passwordRequired");
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [logoutError, setLogoutError] = React.useState("");

  async function logout() {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    setLogoutError("");

    try {
      await requestQuickHackLogout(fetch, t("logoutFailed"));
      window.location.reload();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="grid w-full max-w-[920px] overflow-hidden rounded-md border bg-popover shadow-sm md:grid-cols-[1fr_420px]">
        <div className="flex min-h-[560px] flex-col justify-between border-b bg-secondary/55 p-8 md:border-b-0 md:border-r">
          <div>
            <div className="mb-6 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Database className="size-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold">QuickHack</h1>
                <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
              </div>
            </div>

            <div className="max-w-md">
              <h2 className="text-2xl font-semibold tracking-normal">
                {t("title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {t("description", { name: currentUser.displayName })}
              </p>
            </div>
          </div>

          <div className="grid gap-3">
            {logoutError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {logoutError}
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={isLoggingOut}
              onClick={() => void logout()}
            >
              {isLoggingOut ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              {t("logout")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col justify-center p-6">
          <AccountPasswordPanel
            forced
            onChanged={() => window.location.reload()}
          />
        </div>
      </section>
    </main>
  );
}
