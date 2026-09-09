// QuickHack note: 리더급 사용자가 서버 배치, API 동기화, 실패/재시도 로그를 조회하는 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
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

const JOB_TYPE_MESSAGE_KEYS = { USER_OPERATION_TRACE: "trace", COUPANG_ORDER_SYNC: "orderSync", COUPANG_ORDER_MATCH: "orderMatch", COUPANG_PRODUCT_SYNC: "productSync", INVOICE_REGISTER: "invoice", DATABASE_BACKUP: "backup", DATABASE_RESTORE: "restore" } as const;
const STATUS_MESSAGE_KEYS = { PENDING: "pending", RUNNING: "running", SUCCESS: "success", FAILED: "failed", FAIL: "failed", ERROR: "error", SKIPPED: "skipped", CANCELED: "canceled" } as const;
const TRACE_FIELD_MESSAGE_KEYS = { trace_id: "traceId", source: "source", route: "route", method: "method", target_count: "targetCount", "query.count": "queryCount", "query.read_count": "queryReadCount", "query.write_count": "queryWriteCount", "query.total_ms": "queryTotalMs", "query.max_ms": "queryMaxMs", "transaction.count": "transactionCount", "transaction.wait_ms": "transactionWaitMs", "transaction.run_ms": "transactionRunMs", "transaction.total_ms": "transactionTotalMs", "transaction.max_ms": "transactionMaxMs" } as const;

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

function formatDuration(value: number | null, labels: { seconds: (value: number) => string; minutes: (minutes: number, seconds: number) => string }) {
  if (value === null || value === undefined) {
    return "-";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  const seconds = value / 1000;

  if (seconds < 60) {
    return labels.seconds(Number(seconds.toFixed(1)));
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  return labels.minutes(minutes, remainingSeconds);
}

function fileDate() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}

function FieldListBlock({
  label,
  fields,
}: {
  label: string;
  fields: ServerJobLogDto["fields"];
}) {
  const t = useTranslations("admin.serverJobLog");
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
                {(() => {
                  const key = TRACE_FIELD_MESSAGE_KEYS[field.fieldName as keyof typeof TRACE_FIELD_MESSAGE_KEYS];
                  return key ? t(`field.${key}`) : field.fieldName;
                })()}
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
  const t = useTranslations("admin.serverJobLog");
  const locale = useLocale();
  const jobTypeLabel = React.useCallback((value: string) => {
    const key = JOB_TYPE_MESSAGE_KEYS[value as keyof typeof JOB_TYPE_MESSAGE_KEYS];
    return key ? t(`jobType.${key}`) : value;
  }, [t]);
  const statusLabel = React.useCallback((value: string) => {
    const key = STATUS_MESSAGE_KEYS[value as keyof typeof STATUS_MESSAGE_KEYS];
    return key ? t(`status.${key}`) : value || "-";
  }, [t]);
  const durationLabel = React.useCallback((value: number | null) => formatDuration(value, {
    seconds: (seconds) => t("duration.seconds", { seconds }),
    minutes: (minutes, seconds) => t("duration.minutes", { minutes, seconds }),
  }), [t]);
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
        throw new Error(legacyApiMessage(payload, t("state.loadFailed")));
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
  }, [t]);

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
      if (!response.ok) throw new Error(t("state.exportFailed"));
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
  }, [query, t]);

  const columns = React.useMemo<DataGridColumn<ServerJobLogColumnKey, ServerJobLogDto>[]>(
    () => [
      {
        key: "startedAt",
        label: t("columns.startedAt"),
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
        label: t("columns.job"),
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
        label: t("columns.status"),
        width: "0.8fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${statusLabel(log.status)} ${log.status}`,
        render: (log) => (
          <Badge variant={statusVariant(log.status)}>{statusLabel(log.status)}</Badge>
        ),
      },
      {
        key: "duration",
        label: t("columns.duration"),
        width: "0.85fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => log.durationMs ?? "",
        sortValue: (log) => log.durationMs ?? "",
        render: (log) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {durationLabel(log.durationMs)}
          </span>
        ),
      },
      {
        key: "triggeredBy",
        label: t("columns.actor"),
        width: "1fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${log.displayName} ${log.username}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{log.displayName || "-"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.username || t("state.system")}
            </div>
          </div>
        ),
      },
      {
        key: "error",
        label: t("columns.error"),
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
    [durationLabel, jobTypeLabel, statusLabel, t]
  );

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ScrollText} label={t("summary.logs")} value={summary.total} />
        <SummaryCard icon={Clock3} label={t("summary.running")} value={summary.running} />
        <SummaryCard icon={CheckCircle2} label={t("summary.success")} value={summary.success} />
        <SummaryCard icon={AlertTriangle} label={t("summary.failure")} value={summary.failure} />
      </SummaryStrip>

      <MasterDetailLayout className="grid-cols-[minmax(760px,1fr)_420px] gap-4">
        <WorkspacePanel>
          <PanelToolbar className="grid-cols-[minmax(280px,1fr)_auto_auto]">
            <SearchInput
              aria-label={t("toolbar.searchLabel")}
              placeholder={t("toolbar.searchPlaceholder")}
              value={query}
              onValueChange={setQuery}
            />
            <Button
              variant="outline"
              onClick={() => void loadLogs({ query })}
              disabled={isLoading}
            >
              <RefreshCcw className="size-4" />
              {t("toolbar.refresh")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void exportLogs()}
              disabled={summary.total === 0 || isExporting}
            >
              <Download className="size-4" />
              {t("toolbar.export")}
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
                ? t("state.loading")
                : t("state.empty")
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
              {logs.length.toLocaleString(locale)} / {summary.total.toLocaleString(locale)}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void loadLogs({ append: true, cursor: nextCursor, query })
              }
              disabled={!hasMore || !nextCursor || isLoading}
            >
              {t("toolbar.loadMore")}
            </Button>
          </div>
        </WorkspacePanel>

        <WorkspacePanel as="aside">
          <div className="shrink-0 border-b p-4">
            <h2 className="text-sm font-semibold">{t("detail.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("detail.description")}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selectedLog ? (
              <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                {t("detail.select")}
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow
                    label={t("columns.job")}
                    value={`${selectedLog.jobName || jobTypeLabel(selectedLog.jobType)} / ${selectedLog.jobType}`}
                  />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("columns.status")}</span>
                    <Badge variant={statusVariant(selectedLog.status)}>
                      {statusLabel(selectedLog.status)}
                    </Badge>
                  </div>
                  <DetailRow label={t("columns.startedAt")} value={formatDate(selectedLog.startedAt)} />
                  <DetailRow label={t("columns.finishedAt")} value={formatDate(selectedLog.finishedAt)} />
                  <DetailRow label={t("columns.duration")} value={durationLabel(selectedLog.durationMs)} />
                  <DetailRow
                    label={t("columns.actor")}
                    value={
                      selectedLog.displayName
                        ? `${selectedLog.displayName} (${selectedLog.username || "-"})`
                        : t("state.system")
                    }
                  />
                  <DetailRow label={t("columns.errorCode")} value={selectedLog.errorCode || "-"} />
                  <DetailRow label={t("columns.errorMessage")} value={selectedLog.errorMessage || "-"} />
                </div>

                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow label={t("summary.title")} value={selectedLog.summaryText || "-"} />
                  <DetailRow
                    label={t("summary.processed")}
                    value={selectedLog.summaryProcessedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("summary.success")}
                    value={selectedLog.summarySucceededCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("summary.failed")}
                    value={selectedLog.summaryFailedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("summary.skipped")}
                    value={selectedLog.summarySkippedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("summary.created")}
                    value={selectedLog.summaryCreatedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("summary.updated")}
                    value={selectedLog.summaryUpdatedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("summary.warning")}
                    value={selectedLog.summaryWarningCount?.toLocaleString(locale) ?? ""}
                  />
                </div>
                <FieldListBlock label={t("detail.fields")} fields={selectedLog.fields} />
              </div>
            )}
          </div>
        </WorkspacePanel>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
