// QuickHack note: 리더급 사용자가 서버 배치, API 동기화, 실패/재시도 로그를 조회하는 화면입니다.
"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  RefreshCcw,
  ScrollText,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  SummaryMetric as SummaryCard,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import {
  MasterDetailLayout,
  PanelToolbar,
  WorkspacePageFrame,
  WorkspacePanel,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { DetailRow, formatDate } from "@/quickhack_client/components/shared/device-detail-sheet";
import { cn } from "@/quickhack_shared/core/utils";
import { downloadCsvFile } from "@/quickhack_client/lib/csv";

type ServerJobLogDto = {
  id: number;
  jobType: string;
  jobName: string;
  status: string;
  triggeredByUserId: number | null;
  username: string;
  displayName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  summaryText: string;
  summaryProcessedCount: number | null;
  summarySucceededCount: number | null;
  summaryFailedCount: number | null;
  summarySkippedCount: number | null;
  summaryCreatedCount: number | null;
  summaryUpdatedCount: number | null;
  summaryWarningCount: number | null;
  errorCode: string;
  errorMessage: string;
  fields: Array<{
    fieldName: string;
    fieldValue: string;
  }>;
  createdAt: string;
};

type ServerJobLogsApiResponse = {
  ok: boolean;
  message?: string;
  items?: ServerJobLogDto[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
  summary?: {
    total: number;
    running: number;
    success: number;
    failure: number;
  };
};

type ServerJobLogColumnKey =
  | "startedAt"
  | "job"
  | "status"
  | "duration"
  | "triggeredBy"
  | "error";

const JOB_TYPE_LABELS: Record<string, string> = {
  USER_OPERATION_TRACE: "사용자 조작 성능",
  COUPANG_ORDER_SYNC: "쿠팡 주문 수집",
  COUPANG_ORDER_MATCH: "쿠팡 주문 매칭",
  COUPANG_PRODUCT_SYNC: "쿠팡 상품 동기화",
  INVOICE_REGISTER: "송장 등록",
  DATABASE_BACKUP: "DB 백업",
  DATABASE_RESTORE: "DB 복구",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "대기",
  RUNNING: "실행 중",
  SUCCESS: "성공",
  FAILED: "실패",
  FAIL: "실패",
  ERROR: "오류",
  SKIPPED: "건너뜀",
  CANCELED: "취소",
};

const TRACE_FIELD_LABELS: Record<string, string> = {
  trace_id: "Trace ID",
  source: "실행 원천",
  route: "API 경로",
  method: "HTTP 메서드",
  target_count: "처리 대상 수",
  "query.count": "DB 쿼리 수",
  "query.read_count": "DB 읽기 수",
  "query.write_count": "DB 쓰기 수",
  "query.total_ms": "DB 쿼리 합계",
  "query.max_ms": "최장 DB 쿼리",
  "transaction.count": "트랜잭션 수",
  "transaction.wait_ms": "트랜잭션 대기",
  "transaction.run_ms": "트랜잭션 실행",
  "transaction.total_ms": "트랜잭션 전체",
  "transaction.max_ms": "최장 트랜잭션",
};

function fieldLabel(value: string) {
  return TRACE_FIELD_LABELS[value] ?? value;
}

function jobTypeLabel(value: string) {
  return JOB_TYPE_LABELS[value] ?? value;
}

function statusLabel(value: string) {
  return STATUS_LABELS[value] ?? (value || "-");
}

function statusVariant(value: string) {
  if (value === "SUCCESS") {
    return "success" as const;
  }

  if (["FAILED", "FAIL", "ERROR"].includes(value)) {
    return "danger" as const;
  }

  if (["RUNNING", "PENDING", "SKIPPED"].includes(value)) {
    return "warning" as const;
  }

  return "neutral" as const;
}

function isFailureStatus(value: string) {
  return ["FAILED", "FAIL", "ERROR"].includes(value);
}

function formatDuration(value: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  const seconds = value / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}초`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  return `${minutes}분 ${remainingSeconds}초`;
}

export function logSearchText(log: ServerJobLogDto) {
  return [
    jobTypeLabel(log.jobType),
    log.jobType,
    log.jobName,
    statusLabel(log.status),
    log.status,
    log.displayName,
    log.username,
    log.errorCode,
    log.errorMessage,
    log.startedAt,
    log.finishedAt,
    log.summaryText,
    ...log.fields.map((field) => field.fieldName),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function fileDate() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}

export function downloadCsv(rows: ServerJobLogDto[]) {
  const header = [
    "시작일시",
    "종료일시",
    "작업 유형",
    "작업명",
    "상태",
    "소요시간",
    "실행자",
    "아이디",
    "오류 코드",
    "오류 메시지",
    "요약",
    "원본 컨텍스트",
  ];
  const body = rows.map((row) => [
    row.startedAt,
    row.finishedAt,
    jobTypeLabel(row.jobType),
    row.jobName,
    statusLabel(row.status),
    formatDuration(row.durationMs),
    row.displayName,
    row.username,
    row.errorCode,
    row.errorMessage,
    row.summaryText,
    row.fields.map((field) => `${field.fieldName}=${field.fieldValue}`).join(" / "),
  ]);
  downloadCsvFile(`서버작업로그_${fileDate()}.csv`, [header, ...body]);
}

function FieldListBlock({
  label,
  fields,
}: {
  label: string;
  fields: ServerJobLogDto["fields"];
}) {
  return (
    <div className="grid gap-2">
      <div className="text-xs font-semibold text-muted-foreground">{label}</div>
      <div className="grid max-h-72 overflow-auto rounded-md border bg-secondary/40 p-3 text-xs leading-5">
        {fields.length > 0 ? (
          fields.map((field) => (
            <div
              key={`${field.fieldName}:${field.fieldValue}`}
              className="grid grid-cols-[minmax(120px,0.45fr)_1fr] gap-3 border-b py-1 last:border-b-0"
            >
              <span className="truncate text-muted-foreground">
                {fieldLabel(field.fieldName)}
              </span>
              <span className="break-words">{field.fieldValue || "-"}</span>
            </div>
          ))
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </div>
    </div>
  );
}

export function ServerJobLogView() {
  const [logs, setLogs] = React.useState<ServerJobLogDto[]>([]);
  const [query, setQuery] = React.useState("");
  const [selectedLogId, setSelectedLogId] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isExporting, setIsExporting] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [summary, setSummary] = React.useState({
    total: 0,
    running: 0,
    success: 0,
    failure: 0,
  });
  const requestRef = React.useRef<AbortController | null>(null);
  const generationRef = React.useRef(0);

  const selectedLog = React.useMemo(
    () => logs.find((log) => log.id === selectedLogId) ?? null,
    [logs, selectedLogId]
  );

  const loadLogs = React.useCallback(async (input?: {
    append?: boolean;
    cursor?: string | null;
    query?: string;
  }) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsLoading(true);
    setMessage("");

    try {
      const search = new URLSearchParams({ limit: "100" });
      const requestedQuery = input?.query?.trim() ?? "";
      if (requestedQuery) search.set("query", requestedQuery);
      if (input?.cursor) search.set("cursor", input.cursor);
      const response = await fetch(`/api/admin/server-logs?${search}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as
        | ServerJobLogsApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "서버 작업 로그를 불러오지 못했습니다.");
      }

      if (generation !== generationRef.current) return;
      const items = payload.items ?? [];
      setLogs((current) =>
        input?.append
          ? [...current, ...items.filter((item) => !current.some((row) => row.id === item.id))]
          : items
      );
      setSummary(payload.summary ?? {
        total: payload.totalCount ?? items.length,
        running: 0,
        success: 0,
        failure: 0,
      });
      setNextCursor(payload.nextCursor ?? null);
      setHasMore(payload.hasMore ?? false);
      setSelectedLogId((current) =>
        input?.append || (current && items.some((item) => item.id === current))
          ? current
          : items[0]?.id ?? null
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current) setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadLogs({ query });
    }, 250);

    return () => window.clearTimeout(timerId);
  }, [loadLogs, query]);

  React.useEffect(() => () => requestRef.current?.abort(), []);

  const exportLogs = React.useCallback(async () => {
    setIsExporting(true);
    setMessage("");
    try {
      const search = new URLSearchParams({ format: "csv" });
      if (query.trim()) search.set("query", query.trim());
      const response = await fetch(`/api/admin/server-logs?${search}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("CSV export failed.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `server_job_logs_${fileDate()}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [query]);

  const columns = React.useMemo<DataGridColumn<ServerJobLogColumnKey, ServerJobLogDto>[]>(
    () => [
      {
        key: "startedAt",
        label: "시작일시",
        width: "1.2fr",
        cellClassName: "flex h-full min-w-0 items-center pl-4 pr-3",
        text: (log) => log.startedAt,
        render: (log) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(log.startedAt)}
          </span>
        ),
      },
      {
        key: "job",
        label: "작업",
        width: "1.45fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${jobTypeLabel(log.jobType)} ${log.jobType} ${log.jobName}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate font-semibold">
              {log.jobName || jobTypeLabel(log.jobType)}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {log.jobType}
            </div>
          </div>
        ),
      },
      {
        key: "status",
        label: "상태",
        width: "0.8fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${statusLabel(log.status)} ${log.status}`,
        render: (log) => (
          <Badge variant={statusVariant(log.status)}>{statusLabel(log.status)}</Badge>
        ),
      },
      {
        key: "duration",
        label: "소요시간",
        width: "0.85fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => log.durationMs ?? "",
        sortValue: (log) => log.durationMs ?? "",
        render: (log) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatDuration(log.durationMs)}
          </span>
        ),
      },
      {
        key: "triggeredBy",
        label: "실행자",
        width: "1fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${log.displayName} ${log.username}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{log.displayName || "-"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.username || "시스템"}
            </div>
          </div>
        ),
      },
      {
        key: "error",
        label: "오류",
        width: "1.3fr",
        cellClassName: "flex h-full min-w-0 items-center pl-3 pr-4",
        text: (log) => `${log.errorCode} ${log.errorMessage}`,
        render: (log) => (
          <div className="min-w-0 text-sm">
            <div className="truncate">{log.errorCode || "-"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.errorMessage || "-"}
            </div>
          </div>
        ),
      },
    ],
    []
  );

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ScrollText} label="조회 로그" value={summary.total} />
        <SummaryCard icon={Clock3} label="실행/대기" value={summary.running} />
        <SummaryCard icon={CheckCircle2} label="성공" value={summary.success} />
        <SummaryCard icon={AlertTriangle} label="실패/오류" value={summary.failure} />
      </SummaryStrip>

      <MasterDetailLayout className="grid-cols-[minmax(760px,1fr)_420px] gap-4">
        <WorkspacePanel>
          <PanelToolbar className="grid-cols-[minmax(280px,1fr)_auto_auto]">
            <SearchInput
              aria-label="서버 작업 로그 검색"
              placeholder="작업 유형, 상태, 실행자, 오류 검색"
              value={query}
              onValueChange={setQuery}
            />
            <Button
              variant="outline"
              onClick={() => void loadLogs({ query })}
              disabled={isLoading}
            >
              <RefreshCcw className="size-4" />
              새로고침
            </Button>
            <Button
              variant="outline"
              onClick={() => void exportLogs()}
              disabled={summary.total === 0 || isExporting}
            >
              <Download className="size-4" />
              CSV 내보내기
            </Button>
          </PanelToolbar>

          {message ? (
            <FeedbackBanner tone="warning" className="m-3">
              {message}
            </FeedbackBanner>
          ) : null}

          <VirtualizedDataGrid
            rows={logs}
            columns={columns}
            rowKey={(log) => log.id}
            emptyMessage={
              isLoading
                ? "서버 작업 로그를 불러오는 중입니다."
                : "조회된 서버 작업 로그가 없습니다."
            }
            selectedRowKey={selectedLogId}
            onRowClick={(log) => setSelectedLogId(log.id)}
            getRowClassName={(log) =>
              cn(isFailureStatus(log.status) && "bg-amber-50/40")
            }
            minWidth="1120px"
            rowHeight={58}
          />
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              {logs.length.toLocaleString("ko-KR")} / {summary.total.toLocaleString("ko-KR")}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void loadLogs({ append: true, cursor: nextCursor, query })
              }
              disabled={!hasMore || !nextCursor || isLoading}
            >
              더 불러오기
            </Button>
          </div>
        </WorkspacePanel>

        <WorkspacePanel as="aside">
          <div className="shrink-0 border-b p-4">
            <h2 className="text-sm font-semibold">서버 작업 상세</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              선택한 서버 작업의 상태, 요약, 오류, 원본 컨텍스트를 확인합니다.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selectedLog ? (
              <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                왼쪽 표에서 서버 작업 로그를 선택하세요.
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow
                    label="작업"
                    value={`${selectedLog.jobName || jobTypeLabel(selectedLog.jobType)} / ${selectedLog.jobType}`}
                  />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">상태</span>
                    <Badge variant={statusVariant(selectedLog.status)}>
                      {statusLabel(selectedLog.status)}
                    </Badge>
                  </div>
                  <DetailRow label="시작일시" value={formatDate(selectedLog.startedAt)} />
                  <DetailRow label="종료일시" value={formatDate(selectedLog.finishedAt)} />
                  <DetailRow label="소요시간" value={formatDuration(selectedLog.durationMs)} />
                  <DetailRow
                    label="실행자"
                    value={
                      selectedLog.displayName
                        ? `${selectedLog.displayName} (${selectedLog.username || "-"})`
                        : "시스템"
                    }
                  />
                  <DetailRow label="오류 코드" value={selectedLog.errorCode || "-"} />
                  <DetailRow label="오류 메시지" value={selectedLog.errorMessage || "-"} />
                </div>

                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow label="요약" value={selectedLog.summaryText || "-"} />
                  <DetailRow
                    label="처리"
                    value={selectedLog.summaryProcessedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="성공"
                    value={selectedLog.summarySucceededCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="실패"
                    value={selectedLog.summaryFailedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="건너뜀"
                    value={selectedLog.summarySkippedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="생성"
                    value={selectedLog.summaryCreatedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="수정"
                    value={selectedLog.summaryUpdatedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="주의"
                    value={selectedLog.summaryWarningCount?.toLocaleString("ko-KR") ?? ""}
                  />
                </div>
                <FieldListBlock label="상세" fields={selectedLog.fields} />
              </div>
            )}
          </div>
        </WorkspacePanel>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
