// QuickHack note: 시스템 관리의 보안 점검 메뉴에서 MFA, 백업, 운영 환경, 보안 worker 상태를 확인합니다.
"use client";

import * as React from "react";
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
  label: string;
  status: "OK" | "WARNING" | "FAIL" | string;
  value: string;
  detail: string;
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

const STATUS_LABELS: Record<string, string> = {
  IDLE: "대기",
  RUNNING: "실행 중",
  SUCCESS: "성공",
  FAILED: "실패",
  RETRY_WAITING: "재시도 대기",
  DISABLED: "비활성",
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

function securityStatusLabel(value: string) {
  if (value === "OK") {
    return "정상";
  }

  if (value === "WARNING") {
    return "주의";
  }

  if (value === "FAIL") {
    return "위험";
  }

  return value || "-";
}

function workerStatusLabel(value: string) {
  return STATUS_LABELS[value] ?? (value || "-");
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
  const [checks, setChecks] = React.useState<SecurityCheckDto[]>([]);
  const [workers, setWorkers] = React.useState<SecurityWorkerDto[]>([]);
  const [summary, setSummary] =
    React.useState<SecurityStatusApiResponse["summary"] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState("보안 점검 상태를 불러오는 중입니다.");

  async function loadSecurityStatus() {
    setLoading(true);

    try {
      const response = await fetch("/api/admin/security-status", {
        cache: "no-store",
      });
      const payload = (await response.json()) as SecurityStatusApiResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "보안 점검 상태를 불러오지 못했습니다.");
      }

      setChecks(payload.checks ?? []);
      setWorkers(payload.workers ?? []);
      setSummary(payload.summary ?? null);
      setMessage("보안 점검 상태를 갱신했습니다.");
    } catch (error) {
      setChecks([
        {
          key: "security-status-load",
          label: "보안 점검 API",
          status: "FAIL",
          value: "조회 실패",
          detail: error instanceof Error ? error.message : String(error),
        },
      ]);
      setWorkers([]);
      setSummary({ total: 1, ok: 0, warning: 0, fail: 1 });
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadSecurityStatus();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, []);

  return (
    <section className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 overflow-auto p-5">
      <section className="grid gap-3 md:grid-cols-4">
        <SummaryCard
          icon={ShieldCheck}
          label="점검 항목"
          value={summary?.total ?? checks.length}
        />
        <SummaryCard
          icon={CheckCircle2}
          label="정상"
          value={summary?.ok ?? 0}
          variant="success"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="주의"
          value={summary?.warning ?? 0}
          variant="warning"
        />
        <SummaryCard
          icon={ShieldAlert}
          label="위험"
          value={summary?.fail ?? 0}
          variant="danger"
        />
      </section>

      <section className="rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">보안 점검</h2>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void loadSecurityStatus()}
          >
            <RefreshCcw className="size-4" />
            점검 갱신
          </Button>
        </div>

        <div className="grid gap-3 p-4 lg:grid-cols-2 xl:grid-cols-3">
          {checks.map((check) => (
            <div
              key={check.key}
              className="grid min-h-[126px] gap-2 rounded-md border bg-background px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{check.label}</span>
                <Badge variant={securityStatusVariant(check.status)}>
                  {securityStatusLabel(check.status)}
                </Badge>
              </div>
              <div className="text-sm font-semibold">{check.value}</div>
              <div className="text-xs leading-5 text-muted-foreground">
                {check.detail}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-md border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ServerCog className="size-4 text-primary" />
            보안 관련 worker
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            개인정보 정리, 백업 점검처럼 보안 정책을 자동으로 보조하는 작업입니다.
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
                    {workerStatusLabel(worker.status)}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {worker.scheduleEnabled ? "스케줄 활성" : "스케줄 비활성"}
                </div>
                <div className="text-xs text-muted-foreground">
                  최근 실행 {formatDate(worker.lastRunAt)}
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
              보안 관련 worker가 없습니다.
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
