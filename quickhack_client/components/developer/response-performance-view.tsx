// QuickHack note: 저장된 사용자 조작 trace를 개발자용 표본 통계와 요청 상세로 보여줍니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Gauge,
  RefreshCcw,
  TimerReset,
  XCircle,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  WorkspacePageFrame,
  WorkspacePanel,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  DetailRow,
  formatDate,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import type {
  ResponsePerformanceApiResponse,
  ResponsePerformanceDetailResponse,
  ResponsePerformanceDurationStats,
  ResponsePerformanceOperationSummary,
  ResponsePerformanceRange,
  ResponsePerformanceReport,
  ResponsePerformanceStatusFilter,
  ResponsePerformanceTraceDetail,
  ResponsePerformanceTraceSummary,
} from "@/quickhack_shared/observability/response-performance";
import { RESPONSE_PERFORMANCE_OPERATION_NAMES } from "@/quickhack_shared/observability/response-performance";
import { cn } from "@/quickhack_shared/core/utils";

type OperationColumnKey =
  | "operation"
  | "samples"
  | "average"
  | "p50"
  | "p95"
  | "max"
  | "query"
  | "transactionWait"
  | "clientSamples"
  | "clientAverage"
  | "outsideServer";

type TraceColumnKey =
  | "startedAt"
  | "operation"
  | "status"
  | "duration"
  | "query"
  | "transactionWait"
  | "clientTotal"
  | "outsideServer"
  | "targetCount";

function useResponsePerformancePresentation() {
  const locale = useLocale();
  const t = useTranslations("developer.responsePerformance");
  const intlLocale = locale;
  const rangeLabels: Record<ResponsePerformanceRange, string> = {
    "1h": t("range.h1"), "6h": t("range.h6"), "24h": t("range.h24"), "7d": t("range.d7"),
  };
  const statusLabels: Record<ResponsePerformanceStatusFilter, string> = {
    ALL: t("status.all"), SUCCESS: t("status.success"), FAILED: t("status.failed"),
  };
  const formatDuration = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "-";
    if (value < 1_000) return t("duration.ms", { value });
    if (value < 60_000) return t("duration.seconds", { value: Number((value / 1_000).toFixed(1)) });
    return t("duration.minutesSeconds", { minutes: Math.floor(value / 60_000), seconds: Math.round((value % 60_000) / 1_000) });
  };
  const knownOperations = new Set<string>(RESPONSE_PERFORMANCE_OPERATION_NAMES);
  const operationLabel = (operationName: string) => knownOperations.has(operationName)
    ? t(`operation.${operationName.replaceAll(".", "_").replaceAll("-", "_")}` as never)
    : operationName;
  return { formatDuration, formatNumber: (value: number) => value.toLocaleString(intlLocale), operationLabel, rangeLabels, statusLabel: (status: string) => status === "SUCCESS" ? t("status.success") : t("status.failed"), statusLabels, t };
}

function statusVariant(status: string) {
  return status === "SUCCESS" ? ("success" as const) : ("danger" as const);
}


function SummaryMetric({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 rounded-md border bg-popover px-4">
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary",
          tone === "warning" && "bg-amber-50 text-amber-700",
          tone === "danger" && "bg-red-50 text-red-700"
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function durationStatsForSelection(
  report: ResponsePerformanceReport,
  operationName: string
): {
  sampleCount: number;
  successSampleCount: number;
  failedSampleCount: number;
  slowSampleCount: number;
  duration: ResponsePerformanceDurationStats;
} {
  if (!operationName) {
    return {
      sampleCount: report.sample.analyzedCount,
      successSampleCount: report.overview.successSampleCount,
      failedSampleCount: report.overview.failedSampleCount,
      slowSampleCount: report.overview.slowSampleCount,
      duration: report.overview.duration,
    };
  }

  const matches = report.operations.filter(
    (operation) => operation.operationName === operationName
  );

  if (matches.length === 0) {
    return {
      sampleCount: 0,
      successSampleCount: 0,
      failedSampleCount: 0,
      slowSampleCount: 0,
      duration: {
        sampleCount: 0,
        averageMs: null,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
      },
    };
  }

  // 현재 operation은 하나의 route/method 조합을 사용합니다. 복수 조합이 생기면
  // 서버 집계 계약에서 operation 단위 통계를 함께 내려주도록 확장합니다.
  const selected = matches[0];
  return {
    sampleCount: selected.sampleCount,
    successSampleCount: selected.successSampleCount,
    failedSampleCount: selected.failedSampleCount,
    slowSampleCount: selected.slowSampleCount,
    duration: selected.duration,
  };
}

function traceSearchText(trace: ResponsePerformanceTraceSummary, operationLabel: (name: string) => string) {
  return [
    operationLabel(trace.operationName),
    trace.operationName,
    trace.route,
    trace.method,
    trace.status,
    trace.traceId,
    trace.displayName,
    trace.username,
    trace.errorCode,
    trace.errorMessage,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function SpanList({ detail }: { detail: ResponsePerformanceTraceDetail }) {
  const { formatDuration, t } = useResponsePerformancePresentation();
  if (detail.spans.length === 0) {
    return <div className="text-sm text-muted-foreground">{t("span.empty")}</div>;
  }

  return (
    <div className="grid gap-2">
      {detail.spans.map((span) => {
        const ratio = detail.durationMs
          ? Math.round((span.totalMs / detail.durationMs) * 100)
          : 0;

        return (
          <div key={span.name} className="grid gap-1 rounded-md border p-2.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium" title={span.name}>
                {span.name}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatDuration(span.totalMs)} · {t("span.count", { count: span.count })}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, Math.max(2, ratio))}%` }}
              />
            </div>
          </div>
        );
      })}
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t("span.note")}
      </p>
    </div>
  );
}

export function ResponsePerformanceView() {
  const { formatDuration, formatNumber: formatLocalizedNumber, operationLabel, rangeLabels, statusLabel, statusLabels, t } = useResponsePerformancePresentation();
  const [range, setRange] = React.useState<ResponsePerformanceRange>("24h");
  const [status, setStatus] =
    React.useState<ResponsePerformanceStatusFilter>("ALL");
  const [operation, setOperation] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [report, setReport] = React.useState<ResponsePerformanceReport | null>(
    null
  );
  const [detail, setDetail] =
    React.useState<ResponsePerformanceTraceDetail | null>(null);
  const [selectedLogId, setSelectedLogId] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [detailErrorLogId, setDetailErrorLogId] = React.useState<number | null>(
    null
  );
  const [message, setMessage] = React.useState("");

  const loadReport = React.useCallback(async () => {
    setIsLoading(true);
    setMessage("");

    try {
      const params = new URLSearchParams({ range, status });
      const response = await fetch(
        `/api/developer/response-performance?${params.toString()}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | ResponsePerformanceApiResponse
        | null;

      if (!response.ok || !payload?.ok || payload.mode !== "REPORT") {
        throw new Error(legacyApiMessage(payload, t("error.report")));
      }

      setReport(payload);
      setOperation((current) =>
        current &&
        payload.operations.some((item) => item.operationName === current)
          ? current
          : ""
      );
      setSelectedLogId((current) =>
        current && payload.traces.some((trace) => trace.logId === current)
          ? current
          : payload.traces[0]?.logId ?? null
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [range, status, t]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void loadReport(), 0);
    return () => window.clearTimeout(timer);
  }, [loadReport]);

  const operationOptions = React.useMemo(() => {
    const byName = new Map<string, string>();

    for (const item of report?.operations ?? []) {
      byName.set(item.operationName, operationLabel(item.operationName));
    }

    return Array.from(byName.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [operationLabel, report]);

  const filteredOperations = React.useMemo(
    () =>
      (report?.operations ?? []).filter(
        (item) => !operation || item.operationName === operation
      ),
    [operation, report]
  );
  const filteredTraces = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return (report?.traces ?? []).filter(
      (trace) =>
        (!operation || trace.operationName === operation) &&
        (!normalizedQuery || traceSearchText(trace, operationLabel).includes(normalizedQuery))
    );
  }, [operation, operationLabel, query, report]);

  const activeSelectedLogId = React.useMemo(() => {
    if (
      selectedLogId &&
      filteredTraces.some((trace) => trace.logId === selectedLogId)
    ) {
      return selectedLogId;
    }

    return filteredTraces[0]?.logId ?? null;
  }, [filteredTraces, selectedLogId]);

  React.useEffect(() => {
    if (!activeSelectedLogId) return;

    let canceled = false;

    void fetch(`/api/developer/response-performance?logId=${activeSelectedLogId}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | ResponsePerformanceApiResponse
          | null;

        if (!response.ok || !payload?.ok || payload.mode !== "DETAIL") {
          throw new Error(legacyApiMessage(payload, t("error.detail")));
        }

        if (!canceled) {
          setDetail((payload as ResponsePerformanceDetailResponse).item);
          setDetailErrorLogId(null);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDetail(null);
          setDetailErrorLogId(activeSelectedLogId);
          setMessage(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      canceled = true;
    };
  }, [activeSelectedLogId, t]);

  const selectedStats = report
    ? durationStatsForSelection(report, operation)
    : null;
  const isDetailLoading = Boolean(
    activeSelectedLogId &&
      detail?.logId !== activeSelectedLogId &&
      detailErrorLogId !== activeSelectedLogId
  );

  const operationColumns = React.useMemo<
    DataGridColumn<OperationColumnKey, ResponsePerformanceOperationSummary>[]
  >(
    () => [
      {
        key: "operation",
        label: t("columns.operation"),
        width: "1.8fr",
        text: (row) => `${operationLabel(row.operationName)} ${row.operationName} ${row.route}`,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-semibold">{operationLabel(row.operationName)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.method} {row.route}
            </div>
          </div>
        ),
      },
      {
        key: "samples",
        label: t("columns.samples"),
        width: "0.8fr",
        text: (row) => row.sampleCount,
        sortValue: (row) => row.sampleCount,
        render: (row) => (
          <div className="text-xs tabular-nums">
            <div>{t("columns.count", { count: row.sampleCount })}</div>
            <div className="text-muted-foreground">
              {t("columns.sampleResult", { success: row.successSampleCount, failed: row.failedSampleCount })}
            </div>
          </div>
        ),
      },
      ...([
        ["average", t("columns.average"), (row: ResponsePerformanceOperationSummary) => row.duration.averageMs],
        ["p50", "P50", (row: ResponsePerformanceOperationSummary) => row.duration.p50Ms],
        ["p95", "P95", (row: ResponsePerformanceOperationSummary) => row.duration.p95Ms],
        ["max", t("columns.max"), (row: ResponsePerformanceOperationSummary) => row.duration.maxMs],
        ["query", t("columns.queryAverage"), (row: ResponsePerformanceOperationSummary) => row.averageQueryMs],
        [
          "transactionWait",
          t("columns.txAverage"),
          (row: ResponsePerformanceOperationSummary) => row.averageTransactionWaitMs,
        ],
      ] as const).map(([key, label, value]) => ({
        key,
        label,
        width: "0.75fr",
        text: (row: ResponsePerformanceOperationSummary) => value(row) ?? "",
        sortValue: (row: ResponsePerformanceOperationSummary) => value(row) ?? "",
        render: (row: ResponsePerformanceOperationSummary) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(value(row))}
          </span>
        ),
      })),
      {
        key: "clientSamples",
        label: t("columns.clientSamples"),
        width: "0.8fr",
        text: (row) => row.clientSampleCount,
        sortValue: (row) => row.clientSampleCount,
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {t("columns.clientCoverage", { count: row.clientSampleCount, coverage: row.clientCoveragePercent })}
          </span>
        ),
      },
      {
        key: "clientAverage",
        label: t("columns.clientAverage"),
        width: "0.8fr",
        text: (row) => row.clientDuration.averageMs ?? "",
        sortValue: (row) => row.clientDuration.averageMs ?? "",
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(row.clientDuration.averageMs)}
          </span>
        ),
      },
      {
        key: "outsideServer",
        label: t("columns.outsideAverage"),
        width: "0.85fr",
        text: (row) => row.averageOutsideServerMs ?? "",
        sortValue: (row) => row.averageOutsideServerMs ?? "",
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(row.averageOutsideServerMs)}
          </span>
        ),
      },
    ],
    [formatDuration, operationLabel, t]
  );

  const traceColumns = React.useMemo<
    DataGridColumn<TraceColumnKey, ResponsePerformanceTraceSummary>[]
  >(
    () => [
      {
        key: "startedAt",
        label: t("columns.startedAt"),
        width: "1.15fr",
        text: (row) => row.startedAt,
        render: (row) => (
          <span className="text-xs text-muted-foreground">
            {formatDate(row.startedAt)}
          </span>
        ),
      },
      {
        key: "operation",
        label: t("columns.operation"),
        width: "1.45fr",
        text: (row) => `${operationLabel(row.operationName)} ${row.operationName}`,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{operationLabel(row.operationName)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.method} {row.route}
            </div>
          </div>
        ),
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "0.65fr",
        text: (row) => row.status,
        render: (row) => (
          <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
        ),
      },
      {
        key: "duration",
        label: t("columns.total"),
        width: "0.75fr",
        text: (row) => row.durationMs,
        sortValue: (row) => row.durationMs,
        render: (row) => (
          <span className="text-sm font-medium tabular-nums">
            {formatDuration(row.durationMs)}
          </span>
        ),
      },
      {
        key: "query",
        label: t("columns.query"),
        width: "0.7fr",
        text: (row) => row.query.totalMs,
        sortValue: (row) => row.query.totalMs,
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(row.query.totalMs)}
          </span>
        ),
      },
      {
        key: "transactionWait",
        label: t("columns.tx"),
        width: "0.7fr",
        text: (row) => row.transaction.waitMs,
        sortValue: (row) => row.transaction.waitMs,
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(row.transaction.waitMs)}
          </span>
        ),
      },
      {
        key: "clientTotal",
        label: t("columns.clientTotal"),
        width: "0.75fr",
        text: (row) => row.client?.responseCompleteMs ?? "",
        sortValue: (row) => row.client?.responseCompleteMs ?? "",
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(row.client?.responseCompleteMs)}
          </span>
        ),
      },
      {
        key: "outsideServer",
        label: t("columns.outside"),
        width: "0.7fr",
        text: (row) => row.client?.outsideServerMs ?? "",
        sortValue: (row) => row.client?.outsideServerMs ?? "",
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(row.client?.outsideServerMs)}
          </span>
        ),
      },
      {
        key: "targetCount",
        label: t("columns.target"),
        width: "0.55fr",
        text: (row) => row.targetCount ?? "",
        sortValue: (row) => row.targetCount ?? "",
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {row.targetCount === null ? "-" : t("columns.count", { count: row.targetCount })}
          </span>
        ),
      },
    ],
    [formatDuration, operationLabel, statusLabel, t]
  );

  return (
    <WorkspacePageFrame className="gap-3 p-5">
      <div className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-4 2xl:grid-cols-7">
        <SummaryMetric
          icon={Activity}
          label={t("summary.measured")}
          value={formatLocalizedNumber(selectedStats?.sampleCount ?? 0)}
        />
        <SummaryMetric
          icon={CheckCircle2}
          label={t("summary.success")}
          value={formatLocalizedNumber(selectedStats?.successSampleCount ?? 0)}
        />
        <SummaryMetric
          icon={XCircle}
          label={t("summary.failed")}
          value={formatLocalizedNumber(selectedStats?.failedSampleCount ?? 0)}
          tone={selectedStats?.failedSampleCount ? "danger" : "default"}
        />
        <SummaryMetric
          icon={TimerReset}
          label={t("summary.slow")}
          value={formatLocalizedNumber(selectedStats?.slowSampleCount ?? 0)}
          tone={selectedStats?.slowSampleCount ? "warning" : "default"}
        />
        <SummaryMetric
          icon={Clock3}
          label={t("summary.p50")}
          value={formatDuration(selectedStats?.duration.p50Ms)}
        />
        <SummaryMetric
          icon={Gauge}
          label={t("summary.p95")}
          value={formatDuration(selectedStats?.duration.p95Ms)}
        />
        <SummaryMetric
          icon={AlertTriangle}
          label={t("summary.max")}
          value={formatDuration(selectedStats?.duration.maxMs)}
          tone={(selectedStats?.duration.maxMs ?? 0) >= 1_000 ? "warning" : "default"}
        />
      </div>

      {report?.sample.productionSamplingDetected ? (
        <FeedbackBanner tone="warning" size="xs" className="shrink-0">
          {t("notice.production")}
        </FeedbackBanner>
      ) : null}
      {report?.sample.truncated ? (
        <FeedbackBanner tone="warning" size="xs" className="shrink-0">
          {t("notice.truncated", { matched: report.sample.matchedCount, analyzed: report.sample.analyzedCount })}
        </FeedbackBanner>
      ) : null}
      {report &&
      (report.ingestion.pendingCount > 0 ||
        report.ingestion.droppedCount > 0 ||
        report.ingestion.lastFailure) ? (
        <FeedbackBanner tone="danger" size="xs" className="shrink-0">
          {t("notice.ingestion", { pending: report.ingestion.pendingCount, dropped: report.ingestion.droppedCount, failure: report.ingestion.lastFailure ? ` / ${report.ingestion.lastFailure}` : "" })}
        </FeedbackBanner>
      ) : null}

      <div className="grid shrink-0 grid-cols-[150px_150px_220px_minmax(260px,1fr)_auto] gap-2 rounded-md border bg-popover p-3">
        <Select value={range} onValueChange={(value) => setRange(value as ResponsePerformanceRange)}>
          <SelectTrigger aria-label={t("filter.range")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(rangeLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(value) => setStatus(value as ResponsePerformanceStatusFilter)}
        >
          <SelectTrigger aria-label={t("filter.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(statusLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={operation || "ALL"}
          onValueChange={(value) => setOperation(value === "ALL" ? "" : value)}
        >
          <SelectTrigger aria-label={t("filter.operation")}>
            <SelectValue placeholder={t("filter.allOperations")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filter.allOperations")}</SelectItem>
            {operationOptions.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          aria-label={t("filter.search")}
          placeholder={t("filter.searchPlaceholder")}
          value={query}
          onValueChange={setQuery}
        />
        <Button variant="outline" onClick={loadReport} disabled={isLoading}>
          <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
          {t("filter.refresh")}
        </Button>
      </div>

      {message ? (
        <FeedbackBanner tone="danger" className="shrink-0">
          {message}
        </FeedbackBanner>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-rows-[230px_minmax(0,1fr)] gap-3">
        <WorkspacePanel>
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
            <div>
              <h2 className="text-sm font-semibold">{t("operationPanel.title")}</h2>
              <p className="text-xs text-muted-foreground">
                {t("operationPanel.subtitle")}
              </p>
            </div>
            <Badge variant="neutral">{t("operationPanel.count", { count: filteredOperations.length })}</Badge>
          </div>
          <VirtualizedDataGrid
            rows={filteredOperations}
            columns={operationColumns}
            rowKey={(row) => row.key}
            emptyMessage={isLoading ? t("operationPanel.loading") : t("operationPanel.empty")}
            selectedRowKey={
              operation
                ? filteredOperations.find((item) => item.operationName === operation)?.key
                : null
            }
            onRowClick={(row) =>
              setOperation((current) =>
                current === row.operationName ? "" : row.operationName
              )
            }
            minWidth="1510px"
            rowHeight={54}
          />
        </WorkspacePanel>

        <div className="grid min-h-0 grid-cols-[minmax(760px,1fr)_420px] gap-3">
          <WorkspacePanel>
            <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
              <div>
                <h2 className="text-sm font-semibold">{t("tracePanel.title")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t("tracePanel.subtitle")}
                </p>
              </div>
              <Badge variant="neutral">{t("tracePanel.count", { count: filteredTraces.length })}</Badge>
            </div>
            <VirtualizedDataGrid
              rows={filteredTraces}
              columns={traceColumns}
              rowKey={(row) => row.logId}
              emptyMessage={isLoading ? t("tracePanel.loading") : t("tracePanel.empty")}
              selectedRowKey={activeSelectedLogId}
              onRowClick={(row) => setSelectedLogId(row.logId)}
              minWidth="1280px"
              rowHeight={54}
              getRowClassName={(row) =>
                cn(row.status !== "SUCCESS" && "bg-red-50/40")
              }
            />
          </WorkspacePanel>

          <WorkspacePanel as="aside">
            <div className="shrink-0 border-b p-4">
              <h2 className="text-sm font-semibold">{t("detail.title")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("detail.subtitle")}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {isDetailLoading ? (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  {t("detail.loading")}
                </div>
              ) : !detail || detail.logId !== activeSelectedLogId ? (
                <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                  {t("detail.select")}
                </div>
              ) : (
                <div className="grid gap-4">
                  <div className="grid gap-2 rounded-md border p-3">
                    <DetailRow label={t("detail.operation")} value={operationLabel(detail.operationName)} />
                    <DetailRow label="API" value={`${detail.method} ${detail.route}`} />
                    <DetailRow
                      label="Trace ID"
                      value={
                        detail.traceId ? (
                          <div className="flex items-center gap-1">
                            <span className="min-w-0 flex-1 break-all">{detail.traceId}</span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={t("detail.copyTrace")}
                              onClick={() => void navigator.clipboard.writeText(detail.traceId)}
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </div>
                        ) : (
                          "-"
                        )
                      }
                    />
                    <DetailRow label={t("detail.started")} value={formatDate(detail.startedAt)} />
                    <DetailRow label={t("detail.total")} value={formatDuration(detail.durationMs)} />
                    <DetailRow
                      label={t("detail.actor")}
                      value={
                        detail.displayName
                          ? `${detail.displayName}${detail.username ? ` (${detail.username})` : ""}`
                          : t("system")
                      }
                    />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{t("detail.status")}</span>
                      <Badge variant={statusVariant(detail.status)}>
                        {statusLabel(detail.status)}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <Gauge className="size-3.5" /> {t("detail.clientGateway")}
                    </div>
                    <DetailRow
                      label={t("detail.responseHeader")}
                      value={formatDuration(detail.client?.headerReceivedMs)}
                    />
                    <DetailRow
                      label={t("detail.responseComplete")}
                      value={formatDuration(detail.client?.responseCompleteMs)}
                    />
                    <DetailRow
                      label={t("detail.body")}
                      value={formatDuration(detail.client?.bodyProcessingMs)}
                    />
                    <DetailRow
                      label={t("detail.clientGatewayTime")}
                      value={formatDuration(detail.client?.gatewayMs)}
                    />
                    <DetailRow
                      label={t("detail.outside")}
                      value={formatDuration(detail.client?.outsideServerMs)}
                    />
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      {t("detail.outsideNote")}
                    </p>
                  </div>

                  <div className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <Database className="size-3.5" /> {t("detail.dbTx")}
                    </div>
                    <DetailRow label={t("detail.query")} value={t("span.count", { count: detail.query.count })} />
                    <DetailRow label={t("detail.totalQuery")} value={formatDuration(detail.query.totalMs)} />
                    <DetailRow label={t("detail.longestQuery")} value={formatDuration(detail.query.maxMs)} />
                    <DetailRow label={t("detail.transaction")} value={t("span.count", { count: detail.transaction.count })} />
                    <DetailRow label={t("detail.txCallback")} value={formatDuration(detail.transaction.waitMs)} />
                    <DetailRow label={t("detail.txExecution")} value={formatDuration(detail.transaction.runMs)} />
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      {t("detail.dbNote")}
                    </p>
                  </div>

                  <div className="grid gap-2 rounded-md border p-3">
                    <div className="text-xs font-semibold text-muted-foreground">{t("detail.spans")}</div>
                    <SpanList detail={detail} />
                  </div>

                  {Object.keys(detail.context).length > 0 ? (
                    <div className="grid gap-2 rounded-md border p-3">
                      <div className="text-xs font-semibold text-muted-foreground">{t("detail.environment")}</div>
                      {Object.entries(detail.context).map(([name, value]) => (
                        <DetailRow key={name} label={name} value={value || "-"} />
                      ))}
                    </div>
                  ) : null}

                  {detail.errorCode || detail.errorMessage ? (
                    <div className="grid gap-2 rounded-md border border-red-200 bg-red-50 p-3">
                      <DetailRow label={t("detail.errorCode")} value={detail.errorCode || "-"} />
                      <DetailRow label={t("detail.error")} value={detail.errorMessage || "-"} />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </WorkspacePanel>
        </div>
      </div>
    </WorkspacePageFrame>
  );
}
