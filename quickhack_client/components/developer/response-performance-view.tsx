// QuickHack note: 저장된 사용자 조작 trace를 개발자용 표본 통계와 요청 상세로 보여줍니다.
"use client";

import * as React from "react";
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

const RANGE_LABELS: Record<ResponsePerformanceRange, string> = {
  "1h": "최근 1시간",
  "6h": "최근 6시간",
  "24h": "최근 24시간",
  "7d": "최근 7일",
};

const STATUS_LABELS: Record<ResponsePerformanceStatusFilter, string> = {
  ALL: "전체 상태",
  SUCCESS: "성공",
  FAILED: "실패",
};

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 1_000) return `${value.toLocaleString("ko-KR")}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}초`;

  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}분 ${seconds}초`;
}

function statusVariant(status: string) {
  return status === "SUCCESS" ? ("success" as const) : ("danger" as const);
}

function statusLabel(status: string) {
  return status === "SUCCESS" ? "성공" : "실패";
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

function traceSearchText(trace: ResponsePerformanceTraceSummary) {
  return [
    trace.operationLabel,
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
  if (detail.spans.length === 0) {
    return <div className="text-sm text-muted-foreground">기록된 세부 구간이 없습니다.</div>;
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
                {formatDuration(span.totalMs)} · {span.count}회
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
        상위 구간과 내부 구간이 함께 기록될 수 있어 span 시간의 합은 전체 시간과
        일치하지 않을 수 있습니다.
      </p>
    </div>
  );
}

export function ResponsePerformanceView() {
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
        throw new Error(
          payload && "message" in payload
            ? payload.message
            : "응답 성능 기록을 불러오지 못했습니다."
        );
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
  }, [range, status]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void loadReport(), 0);
    return () => window.clearTimeout(timer);
  }, [loadReport]);

  const operationOptions = React.useMemo(() => {
    const byName = new Map<string, string>();

    for (const item of report?.operations ?? []) {
      byName.set(item.operationName, item.operationLabel);
    }

    return Array.from(byName.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, "ko"));
  }, [report]);

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
        (!normalizedQuery || traceSearchText(trace).includes(normalizedQuery))
    );
  }, [operation, query, report]);

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
          throw new Error(
            payload && "message" in payload
              ? payload.message
              : "성능 trace 상세를 불러오지 못했습니다."
          );
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
  }, [activeSelectedLogId]);

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
        label: "조작",
        width: "1.8fr",
        text: (row) => `${row.operationLabel} ${row.operationName} ${row.route}`,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-semibold">{row.operationLabel}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.method} {row.route}
            </div>
          </div>
        ),
      },
      {
        key: "samples",
        label: "표본",
        width: "0.8fr",
        text: (row) => row.sampleCount,
        sortValue: (row) => row.sampleCount,
        render: (row) => (
          <div className="text-xs tabular-nums">
            <div>{row.sampleCount.toLocaleString("ko-KR")}건</div>
            <div className="text-muted-foreground">
              성공 {row.successSampleCount} / 실패 {row.failedSampleCount}
            </div>
          </div>
        ),
      },
      ...([
        ["average", "평균", (row: ResponsePerformanceOperationSummary) => row.duration.averageMs],
        ["p50", "P50", (row: ResponsePerformanceOperationSummary) => row.duration.p50Ms],
        ["p95", "P95", (row: ResponsePerformanceOperationSummary) => row.duration.p95Ms],
        ["max", "최장", (row: ResponsePerformanceOperationSummary) => row.duration.maxMs],
        ["query", "누적 DB 평균", (row: ResponsePerformanceOperationSummary) => row.averageQueryMs],
        [
          "transactionWait",
          "TX 진입 평균",
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
        label: "Client 표본",
        width: "0.8fr",
        text: (row) => row.clientSampleCount,
        sortValue: (row) => row.clientSampleCount,
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {row.clientSampleCount}건 / {row.clientCoveragePercent}%
          </span>
        ),
      },
      {
        key: "clientAverage",
        label: "Client 평균",
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
        label: "서버 밖 평균",
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
    []
  );

  const traceColumns = React.useMemo<
    DataGridColumn<TraceColumnKey, ResponsePerformanceTraceSummary>[]
  >(
    () => [
      {
        key: "startedAt",
        label: "시작 일시",
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
        label: "조작",
        width: "1.45fr",
        text: (row) => `${row.operationLabel} ${row.operationName}`,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.operationLabel}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.method} {row.route}
            </div>
          </div>
        ),
      },
      {
        key: "status",
        label: "상태",
        width: "0.65fr",
        text: (row) => row.status,
        render: (row) => (
          <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
        ),
      },
      {
        key: "duration",
        label: "전체",
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
        label: "누적 DB",
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
        label: "TX 진입",
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
        label: "Client 전체",
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
        label: "서버 밖",
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
        label: "대상",
        width: "0.55fr",
        text: (row) => row.targetCount ?? "",
        sortValue: (row) => row.targetCount ?? "",
        render: (row) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {row.targetCount === null ? "-" : `${row.targetCount}건`}
          </span>
        ),
      },
    ],
    []
  );

  return (
    <WorkspacePageFrame className="gap-3 p-5">
      <div className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-4 2xl:grid-cols-7">
        <SummaryMetric
          icon={Activity}
          label="측정 표본"
          value={(selectedStats?.sampleCount ?? 0).toLocaleString("ko-KR")}
        />
        <SummaryMetric
          icon={CheckCircle2}
          label="성공 표본"
          value={(selectedStats?.successSampleCount ?? 0).toLocaleString("ko-KR")}
        />
        <SummaryMetric
          icon={XCircle}
          label="실패 표본"
          value={(selectedStats?.failedSampleCount ?? 0).toLocaleString("ko-KR")}
          tone={selectedStats?.failedSampleCount ? "danger" : "default"}
        />
        <SummaryMetric
          icon={TimerReset}
          label="1초 이상"
          value={(selectedStats?.slowSampleCount ?? 0).toLocaleString("ko-KR")}
          tone={selectedStats?.slowSampleCount ? "warning" : "default"}
        />
        <SummaryMetric
          icon={Clock3}
          label="표본 P50"
          value={formatDuration(selectedStats?.duration.p50Ms)}
        />
        <SummaryMetric
          icon={Gauge}
          label="표본 P95"
          value={formatDuration(selectedStats?.duration.p95Ms)}
        />
        <SummaryMetric
          icon={AlertTriangle}
          label="최장"
          value={formatDuration(selectedStats?.duration.maxMs)}
          tone={(selectedStats?.duration.maxMs ?? 0) >= 1_000 ? "warning" : "default"}
        />
      </div>

      {report?.sample.productionSamplingDetected ? (
        <FeedbackBanner tone="warning" size="xs" className="shrink-0">
          운영 환경에서는 빠른 성공 요청이 표본 수집됩니다. 표시된 건수와 분포는 전체
          트래픽 통계가 아닙니다.
        </FeedbackBanner>
      ) : null}
      {report?.sample.truncated ? (
        <FeedbackBanner tone="warning" size="xs" className="shrink-0">
          조건에 맞는 {report.sample.matchedCount.toLocaleString("ko-KR")}건 중 최근{" "}
          {report.sample.analyzedCount.toLocaleString("ko-KR")}개 표본을 기준으로 집계했습니다.
        </FeedbackBanner>
      ) : null}
      {report &&
      (report.ingestion.pendingCount > 0 ||
        report.ingestion.droppedCount > 0 ||
        report.ingestion.lastFailure) ? (
        <FeedbackBanner tone="danger" size="xs" className="shrink-0">
          성능 로그 적재 상태: 대기 {report.ingestion.pendingCount}건 / 유실{" "}
          {report.ingestion.droppedCount}건
          {report.ingestion.lastFailure ? ` / ${report.ingestion.lastFailure}` : ""}
        </FeedbackBanner>
      ) : null}

      <div className="grid shrink-0 grid-cols-[150px_150px_220px_minmax(260px,1fr)_auto] gap-2 rounded-md border bg-popover p-3">
        <Select value={range} onValueChange={(value) => setRange(value as ResponsePerformanceRange)}>
          <SelectTrigger aria-label="성능 조회 기간">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RANGE_LABELS).map(([value, label]) => (
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
          <SelectTrigger aria-label="성능 요청 상태">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
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
          <SelectTrigger aria-label="성능 조작 종류">
            <SelectValue placeholder="전체 조작" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 조작</SelectItem>
            {operationOptions.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          aria-label="성능 trace 검색"
          placeholder="조작, API 경로, Trace ID, 오류 검색"
          value={query}
          onValueChange={setQuery}
        />
        <Button variant="outline" onClick={loadReport} disabled={isLoading}>
          <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
          새로고침
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
              <h2 className="text-sm font-semibold">조작별 서버 처리 성능</h2>
              <p className="text-xs text-muted-foreground">
                성공 표본의 지연 시간과 trace 안에서 측정된 누적 DB 구간을 비교합니다.
              </p>
            </div>
            <Badge variant="neutral">{filteredOperations.length}개 조작</Badge>
          </div>
          <VirtualizedDataGrid
            rows={filteredOperations}
            columns={operationColumns}
            rowKey={(row) => row.key}
            emptyMessage={isLoading ? "성능 표본을 불러오는 중입니다." : "측정된 조작이 없습니다."}
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
                <h2 className="text-sm font-semibold">요청 trace</h2>
                <p className="text-xs text-muted-foreground">
                  서버가 기록한 최근 요청 표본입니다.
                </p>
              </div>
              <Badge variant="neutral">{filteredTraces.length}건</Badge>
            </div>
            <VirtualizedDataGrid
              rows={filteredTraces}
              columns={traceColumns}
              rowKey={(row) => row.logId}
              emptyMessage={isLoading ? "성능 trace를 불러오는 중입니다." : "조건에 맞는 trace가 없습니다."}
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
              <h2 className="text-sm font-semibold">Trace 상세</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                전체 시간, DB, 트랜잭션과 세부 측정 구간을 확인합니다.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {isDetailLoading ? (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  상세 정보를 불러오는 중입니다.
                </div>
              ) : !detail || detail.logId !== activeSelectedLogId ? (
                <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                  왼쪽 표에서 trace를 선택하세요.
                </div>
              ) : (
                <div className="grid gap-4">
                  <div className="grid gap-2 rounded-md border p-3">
                    <DetailRow label="조작" value={detail.operationLabel} />
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
                              aria-label="Trace ID 복사"
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
                    <DetailRow label="시작" value={formatDate(detail.startedAt)} />
                    <DetailRow label="전체 시간" value={formatDuration(detail.durationMs)} />
                    <DetailRow
                      label="실행자"
                      value={
                        detail.displayName
                          ? `${detail.displayName}${detail.username ? ` (${detail.username})` : ""}`
                          : "시스템"
                      }
                    />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">상태</span>
                      <Badge variant={statusVariant(detail.status)}>
                        {statusLabel(detail.status)}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <Gauge className="size-3.5" /> Client / Gateway
                    </div>
                    <DetailRow
                      label="응답 헤더 수신"
                      value={formatDuration(detail.client?.headerReceivedMs)}
                    />
                    <DetailRow
                      label="응답 소비 완료"
                      value={formatDuration(detail.client?.responseCompleteMs)}
                    />
                    <DetailRow
                      label="본문 처리"
                      value={formatDuration(detail.client?.bodyProcessingMs)}
                    />
                    <DetailRow
                      label="Client gateway"
                      value={formatDuration(detail.client?.gatewayMs)}
                    />
                    <DetailRow
                      label="서버 밖 구간"
                      value={formatDuration(detail.client?.outsideServerMs)}
                    />
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      서버 밖 구간은 Client 응답 소비 완료에서 중앙 서버 trace 시간을 뺀
                      값입니다. 클라이언트 표본이 없으면 0이 아니라 -로 표시합니다.
                    </p>
                  </div>

                  <div className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <Database className="size-3.5" /> DB / 트랜잭션
                    </div>
                    <DetailRow label="쿼리" value={`${detail.query.count}회`} />
                    <DetailRow label="누적 DB query" value={formatDuration(detail.query.totalMs)} />
                    <DetailRow label="최장 쿼리" value={formatDuration(detail.query.maxMs)} />
                    <DetailRow label="트랜잭션" value={`${detail.transaction.count}회`} />
                    <DetailRow label="TX 콜백 진입" value={formatDuration(detail.transaction.waitMs)} />
                    <DetailRow label="TX 실행" value={formatDuration(detail.transaction.runMs)} />
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      병렬 query는 각각의 시간을 합산하므로 누적 DB 시간이 전체 응답보다
                      클 수 있습니다. TX 콜백 진입은 DB 잠금 대기 시간과 동일하지 않습니다.
                    </p>
                  </div>

                  <div className="grid gap-2 rounded-md border p-3">
                    <div className="text-xs font-semibold text-muted-foreground">세부 구간</div>
                    <SpanList detail={detail} />
                  </div>

                  {Object.keys(detail.context).length > 0 ? (
                    <div className="grid gap-2 rounded-md border p-3">
                      <div className="text-xs font-semibold text-muted-foreground">실행 환경</div>
                      {Object.entries(detail.context).map(([name, value]) => (
                        <DetailRow key={name} label={name} value={value || "-"} />
                      ))}
                    </div>
                  ) : null}

                  {detail.errorCode || detail.errorMessage ? (
                    <div className="grid gap-2 rounded-md border border-red-200 bg-red-50 p-3">
                      <DetailRow label="오류 코드" value={detail.errorCode || "-"} />
                      <DetailRow label="오류" value={detail.errorMessage || "-"} />
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
