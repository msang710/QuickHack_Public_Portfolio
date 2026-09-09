// QuickHack note: 시스템 관리의 보안 점검 메뉴에서 MFA, 백업, 운영 환경, 보안 worker 상태를 확인합니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCcw,
  ShieldCheck,
  ShieldAlert,
  ServerCog,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { formatDate } from "@/quickhack_client/components/shared/device-detail-sheet";

type SecurityCheckDto = {
  key: string;
  status: "OK" | "WARNING" | "FAIL" | string;
  value: string;
  detail: string;
  valueCode?: string;
  detailCode?: string;
  messageArguments?: Record<string, string | number>;
};

type SecurityWorkerDto = {
  workerKey: string;
  workerName: string;
  status: string;
  scheduleEnabled: boolean;
  lastRunAt: string;
  lastErrorMessage: string;
};

type SecurityStatusApiResponse = {
  ok: boolean;
  message?: string;
  summary?: {
    total: number;
    ok: number;
    warning: number;
    fail: number;
  };
  checks?: SecurityCheckDto[];
  workers?: SecurityWorkerDto[];
};

function securityStatusVariant(value: string) {
  if (value === "OK") {
    return "success" as const;
  }

  if (value === "WARNING") {
    return "warning" as const;
  }

  if (value === "FAIL") {
    return "danger" as const;
  }

  return "neutral" as const;
}

function workerStatusVariant(value: string) {
  if (value === "SUCCESS" || value === "IDLE") {
    return "success" as const;
  }

  if (value === "FAILED") {
    return "danger" as const;
  }

  if (value === "RUNNING" || value === "RETRY_WAITING") {
    return "warning" as const;
  }

  return "neutral" as const;
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  variant = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  variant?: "neutral" | "success" | "warning" | "danger";
}) {
  const variantClass = {
    neutral: "bg-secondary text-primary",
    success: "bg-emerald-50 text-emerald-700",
    warning: "bg-amber-50 text-amber-700",
    danger: "bg-red-50 text-red-700",
  }[variant];

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border bg-card px-4 py-3">
      <span
        className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md ${variantClass}`}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}

export function SecurityStatusView() {
  const t = useTranslations("admin.securityStatus");
  const tw = useTranslations("admin.systemStatus.status");
  const [checks, setChecks] = React.useState<SecurityCheckDto[]>([]);
  const [workers, setWorkers] = React.useState<SecurityWorkerDto[]>([]);
  const [summary, setSummary] =
    React.useState<SecurityStatusApiResponse["summary"] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState(() => t("message.loading"));

  function statusLabel(value: string) {
    if (value === "OK") return t("status.ok");
    if (value === "WARNING") return t("status.warning");
    if (value === "FAIL") return t("status.fail");
    return value || "-";
  }

  function checkLabel(value: string) {
    if (value === "runtime") return t("checkLabel.runtime");
    if (value === "coupang-write-api-policy") return t("checkLabel.coupangWrite");
    if (value === "logen-write-api-policy") return t("checkLabel.logenWrite");
    if (value === "totp-key") return t("checkLabel.totpKey");
    if (value === "totp-users") return t("checkLabel.totpUsers");
    if (value === "backup-encryption") return t("checkLabel.backupEncryption");
    if (value === "cookie-secure") return t("checkLabel.cookieSecure");
    if (value === "coupang-auth") return t("checkLabel.coupangCredential");
    if (value === "channel-credential-store") return t("checkLabel.credentialStore");
    if (value === "logen-auth") return t("checkLabel.logenCredential");
    if (value === "external-api-destination") return t("checkLabel.externalDestination");
    if (value === "latest-backup") return t("checkLabel.latestBackup");
    if (value === "security-status-load") return t("fallback.label");
    return value;
  }

  function checkValue(check: SecurityCheckDto) {
    if (check.valueCode === "ALLOWED") return t("value.allowed");
    if (check.valueCode === "BLOCKED") return t("value.blocked");
    if (check.valueCode === "AVAILABLE") return t("value.available");
    if (check.valueCode === "UNAVAILABLE") return t("value.unavailable");
    if (check.valueCode === "ENCRYPTED") return t("value.encrypted");
    if (check.valueCode === "SECURE") return t("value.secure");
    if (check.valueCode === "HTTP_ALLOWED") return t("value.httpAllowed");
    if (check.valueCode === "NO_RECORD") return t("value.noRecord");
    return check.value;
  }

  function checkDetail(check: SecurityCheckDto) {
    const arguments_ = check.messageArguments ?? {};
    if (check.detailCode === "RUNTIME_PRODUCTION") return t("detail.runtimeProduction");
    if (check.detailCode === "RUNTIME_DEVELOPMENT") return t("detail.runtimeDevelopment");
    if (check.detailCode === "COUPANG_WRITE_ALLOWED") return t("detail.coupangWriteAllowed");
    if (check.detailCode === "COUPANG_WRITE_BLOCKED") return t("detail.coupangWriteBlocked");
    if (check.detailCode === "LOGEN_WRITE_ALLOWED") return t("detail.logenWriteAllowed");
    if (check.detailCode === "LOGEN_WRITE_BLOCKED") return t("detail.logenWriteBlocked");
    if (check.detailCode === "TOTP_KEY_AVAILABLE") {
      return t("detail.totpKeyAvailable", { protection: String(arguments_.protection ?? "-") });
    }
    if (check.detailCode === "TOTP_KEY_UNAVAILABLE") {
      return t("detail.totpKeyUnavailable", { state: String(arguments_.state ?? "-") });
    }
    if (check.detailCode === "TOTP_USERS") return t("detail.totpUsers");
    if (check.detailCode === "COOKIE_SECURE") return t("detail.cookieSecure");
    if (check.detailCode === "COOKIE_HTTP_ALLOWED") return t("detail.cookieHttpAllowed");
    if (check.detailCode === "EXTERNAL_API_MOCK") return t("detail.externalApiMock");
    if (check.detailCode === "EXTERNAL_API_LIVE") return t("detail.externalApiLive");
    if (check.detailCode === "NO_BACKUP_HISTORY") return t("detail.noBackupHistory");
    return check.detail;
  }

  function workerLabel(value: string) {
    if (value === "IDLE") return tw("idle");
    if (value === "RUNNING") return tw("running");
    if (value === "SUCCESS") return tw("success");
    if (value === "FAILED") return tw("failed");
    if (value === "RETRY_WAITING") return tw("retry");
    if (value === "DISABLED") return tw("disabled");
    return value || "-";
  }

  const loadSecurityStatus = React.useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch("/api/admin/security-status", {
        cache: "no-store",
      });
      const payload = (await response.json()) as SecurityStatusApiResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(legacyApiMessage(payload, t("message.loadFailed")));
      }

      setChecks(payload.checks ?? []);
      setWorkers(payload.workers ?? []);
      setSummary(payload.summary ?? null);
      setMessage(t("message.refreshed"));
    } catch (error) {
      setChecks([
        {
          key: "security-status-load",
          status: "FAIL",
          value: t("fallback.value"),
          detail: error instanceof Error ? error.message : String(error),
        },
      ]);
      setWorkers([]);
      setSummary({ total: 1, ok: 0, warning: 0, fail: 1 });
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadSecurityStatus();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadSecurityStatus]);

  return (
    <section className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 overflow-auto p-5">
      <section className="grid gap-3 md:grid-cols-4">
        <SummaryCard
          icon={ShieldCheck}
          label={t("summary.total")}
          value={summary?.total ?? checks.length}
        />
        <SummaryCard
          icon={CheckCircle2}
          label={t("summary.ok")}
          value={summary?.ok ?? 0}
          variant="success"
        />
        <SummaryCard
          icon={AlertTriangle}
          label={t("summary.warning")}
          value={summary?.warning ?? 0}
          variant="warning"
        />
        <SummaryCard
          icon={ShieldAlert}
          label={t("summary.fail")}
          value={summary?.fail ?? 0}
          variant="danger"
        />
      </section>

      <section className="rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t("checks.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void loadSecurityStatus()}
          >
            <RefreshCcw className="size-4" />
            {t("checks.refresh")}
          </Button>
        </div>

        <div className="grid gap-3 p-4 lg:grid-cols-2 xl:grid-cols-3">
          {checks.map((check) => (
            <div
              key={check.key}
              className="grid min-h-[126px] gap-2 rounded-md border bg-background px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{checkLabel(check.key)}</span>
                <Badge variant={securityStatusVariant(check.status)}>
                  {statusLabel(check.status)}
                </Badge>
              </div>
              <div className="text-sm font-semibold">{checkValue(check)}</div>
              <div className="text-xs leading-5 text-muted-foreground">
                {checkDetail(check)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-md border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ServerCog className="size-4 text-primary" />
            {t("workers.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("workers.description")}
          </p>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {workers.length > 0 ? (
            workers.map((worker) => (
              <div key={worker.workerKey} className="grid gap-2 rounded-md border px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {worker.workerName}
                  </span>
                  <Badge variant={workerStatusVariant(worker.status)}>
                    {workerLabel(worker.status)}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {worker.scheduleEnabled ? t("workers.scheduleEnabled") : t("workers.scheduleDisabled")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("workers.lastRun", { date: formatDate(worker.lastRunAt) })}
                </div>
                {worker.lastErrorMessage ? (
                  <div className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">
                    {worker.lastErrorMessage}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="col-span-full rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("workers.empty")}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
