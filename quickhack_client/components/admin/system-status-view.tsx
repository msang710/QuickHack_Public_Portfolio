// QuickHack note: 시스템 상태 메뉴에서 서버 내부 worker 상태와 실행 제어를 확인하는 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Play,
  RefreshCcw,
  ServerCog,
  TimerReset,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  MasterDetailLayout,
  WorkspacePageFrame,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/quickhack_client/components/ui/tabs";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { DetailRow, formatDate } from "@/quickhack_client/components/shared/device-detail-sheet";
import { cn } from "@/quickhack_shared/core/utils";

type WorkerJobDto = {
  workerJobId: number;
  workerKey: string;
  workerName: string;
  workerType: string;
  status: string;
  scheduleEnabled: boolean;
  scheduleRequired: boolean;
  schedulable: boolean;
  scheduleKind: "DAILY_KST" | "INTERVAL" | "MANUAL";
  scheduleLabel: string;
  managementSurface: "QUICKHACK_CLIENT" | "SERVER_CONSOLE";
  intervalSeconds: number | null;
  nextRunAt: string;
  lastRunAt: string;
  startedAt: string;
  finishedAt: string;
  lockedBy: string;
  lockedUntil: string;
  progressCurrent: number;
  progressTotal: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCode: string;
  lastErrorMessage: string;
  resultSummaryText: string;
  resultProcessedCount: number | null;
  resultSucceededCount: number | null;
  resultFailedCount: number | null;
  resultSkippedCount: number | null;
  resultCreatedCount: number | null;
  resultUpdatedCount: number | null;
  resultWarningCount: number | null;
  triggeredByUserId: number | null;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

type WorkerJobsApiResponse = {
  ok: boolean;
  message?: string;
  manager?: WorkerManagerDto;
  readSyncHealth?: ReadSyncHealthDto;
  items?: WorkerJobDto[];
  item?: WorkerJobDto;
  data?: unknown;
};

type WorkerManagerDto = {
  started: boolean;
  starting: boolean;
  tickRunning: boolean;
  disabledReason: string;
  pollSeconds: number;
  lastTickAt: string;
  lastErrorMessage: string;
  lastReadSyncRecoveryAt: string;
  lastReadSyncRecoveryError: string;
};

type ReadSyncHealthDto = {
  lookbackHours: number;
  activeCallCount: number;
  interruptedCount: number;
  latestInterrupted: {
    apiCallLogId: number;
    apiName: string;
    endpointPath: string;
    statusFilter: string;
    requestStartedAt: string;
    processedAt: string;
    interruptedStage: "PENDING" | "RECEIVED" | "PROCESSING";
    workerKey: string;
    workerName: string;
  } | null;
};

type WorkerColumnKey =
  | "worker"
  | "status"
  | "schedule"
  | "progress"
  | "lastRun"
  | "actions";
type PendingWorkerAction = {
  workerKey: string;
  kind: "run" | "schedule" | "due";
} | null;
type WorkerGroupKey =
  | "all"
  | "quickhack-internal"
  | "coupang-api"
  | "naver-api"
  | "elevenstreet-api"
  | "esm-api"
  | "cafe24-api";

const workerTableCellClassName = "flex h-full min-w-0 items-center px-3";

function statusVariant(value: string) {
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

function progressText(worker: WorkerJobDto, locale: string) {
  if (worker.progressTotal && worker.progressTotal > 0) {
    return `${worker.progressCurrent.toLocaleString(locale)} / ${worker.progressTotal.toLocaleString(locale)}`;
  }

  if (worker.progressCurrent > 0) {
    return worker.progressCurrent.toLocaleString(locale);
  }

  return "-";
}

function workerSearchText(worker: WorkerJobDto, typeLabel: (value: string) => string, stateLabel: (value: string) => string) {
  return [
    worker.workerKey,
    worker.workerName,
    typeLabel(worker.workerType),
    worker.workerType,
    stateLabel(worker.status),
    worker.status,
    worker.lastErrorCode,
    worker.lastErrorMessage,
    worker.displayName,
    worker.username,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function workerGroupKey(worker: WorkerJobDto): WorkerGroupKey {
  const key = worker.workerKey.toLowerCase();
  const name = worker.workerName.toLowerCase();
  const type = worker.workerType.toUpperCase();
  const sourceText = `${key} ${name}`;
  const looksLikeApiSync =
    type.includes("SYNC") ||
    type.includes("API") ||
    sourceText.includes("sync");

  if (
    (type.startsWith("COUPANG_") && looksLikeApiSync) ||
    (looksLikeApiSync && sourceText.includes("coupang"))
  ) {
    return "coupang-api";
  }

  if (
    ((type.startsWith("NAVER_") || type.includes("SMARTSTORE")) &&
      looksLikeApiSync) ||
    (looksLikeApiSync &&
      (sourceText.includes("naver") || sourceText.includes("smartstore")))
  ) {
    return "naver-api";
  }

  if (
    ((type.startsWith("ELEVEN") || type.includes("11ST")) && looksLikeApiSync) ||
    (looksLikeApiSync &&
      (sourceText.includes("eleven") || sourceText.includes("11st")))
  ) {
    return "elevenstreet-api";
  }

  if (
    (type.startsWith("ESM_") && looksLikeApiSync) ||
    (looksLikeApiSync &&
      (sourceText.includes("esm") ||
        sourceText.includes("gmarket") ||
        sourceText.includes("auction")))
  ) {
    return "esm-api";
  }

  if (
    (type.startsWith("CAFE24_") && looksLikeApiSync) ||
    (looksLikeApiSync &&
      (sourceText.includes("cafe24") || sourceText.includes("selfmall")))
  ) {
    return "cafe24-api";
  }

  return "quickhack-internal";
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border bg-card px-4 py-3">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}

export function SystemStatusView() {
  const t = useTranslations("admin.systemStatus");
  const locale = useLocale();
  const workerGroups: Array<{ key: WorkerGroupKey; label: string }> = React.useMemo(() => [
    { key: "all", label: t("group.all") }, { key: "quickhack-internal", label: t("group.internal") }, { key: "coupang-api", label: t("group.coupang") }, { key: "naver-api", label: t("group.naver") }, { key: "elevenstreet-api", label: t("group.eleven") }, { key: "esm-api", label: t("group.esm") }, { key: "cafe24-api", label: t("group.cafe24") },
  ], [t]);
  const workerTypeLabels: Record<string, string> = React.useMemo(() => ({ COUPANG_SYNC: t("type.coupangSync"), ORDER_MATCHING: t("type.orderMatching"), INVOICE: t("type.invoice"), RETURN_SYNC: t("type.returnSync"), DATABASE_BACKUP: t("type.databaseBackup"), BACKUP_MAINTENANCE: t("type.backupMaintenance"), SECURITY_MAINTENANCE: t("type.securityMaintenance"), OBSERVABILITY_MAINTENANCE: t("type.observabilityMaintenance"), INVENTORY_AUDIT: t("type.inventoryAudit") }), [t]);
  const statusLabels: Record<string, string> = React.useMemo(() => ({ IDLE: t("status.idle"), RUNNING: t("status.running"), SUCCESS: t("status.success"), FAILED: t("status.failed"), RETRY_WAITING: t("status.retry"), DISABLED: t("status.disabled") }), [t]);
  const workerTypeLabel = React.useCallback((value: string) => workerTypeLabels[value] ?? value, [workerTypeLabels]);
  const statusLabel = React.useCallback((value: string) => statusLabels[value] ?? (value || "-"), [statusLabels]);
  const intervalText = React.useCallback((seconds: number | null) => !seconds ? "-" : seconds < 60 ? t("interval.seconds", { seconds }) : seconds % 60 === 0 ? t("interval.minutes", { minutes: Math.floor(seconds / 60) }) : t("interval.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }), [t]);
  const [workers, setWorkers] = React.useState<WorkerJobDto[]>([]);
  const [manager, setManager] = React.useState<WorkerManagerDto | null>(null);
  const [readSyncHealth, setReadSyncHealth] =
    React.useState<ReadSyncHealthDto | null>(null);
  const [selectedWorkerKey, setSelectedWorkerKey] = React.useState("");
  const [activeWorkerGroup, setActiveWorkerGroup] =
    React.useState<WorkerGroupKey>("all");
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [pendingAction, setPendingAction] =
    React.useState<PendingWorkerAction>(null);
  const [message, setMessage] = React.useState(() => t("message.initial"));
  const [messageTone, setMessageTone] = React.useState<"neutral" | "warning">("neutral");
  const runningKey = pendingAction?.workerKey ?? "";

  const workerGroupCounts = React.useMemo(() => {
    const counts = new Map<WorkerGroupKey, number>();

    counts.set("all", workers.length);

    for (const worker of workers) {
      const groupKey = workerGroupKey(worker);

      counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
    }

    return counts;
  }, [workers]);

  const visibleWorkerGroups = React.useMemo(() => {
    return workerGroups.filter((group) => {
      if (group.key === "all" || group.key === "quickhack-internal") {
        return true;
      }

      return (
        group.key === activeWorkerGroup ||
        (workerGroupCounts.get(group.key) ?? 0) > 0
      );
    });
  }, [activeWorkerGroup, workerGroupCounts, workerGroups]);

  const filteredWorkers = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const groupedWorkers =
      activeWorkerGroup === "all"
        ? workers
        : workers.filter((worker) => workerGroupKey(worker) === activeWorkerGroup);

    if (!normalizedQuery) {
      return groupedWorkers;
    }

    return groupedWorkers.filter((worker) =>
      workerSearchText(worker, workerTypeLabel, statusLabel).includes(normalizedQuery)
    );
  }, [activeWorkerGroup, query, statusLabel, workerTypeLabel, workers]);

  const selectedWorker =
    filteredWorkers.find((worker) => worker.workerKey === selectedWorkerKey) ??
    filteredWorkers[0] ??
    null;

  const summary = React.useMemo(() => {
    return {
      total: workers.length,
      running: workers.filter((worker) => worker.status === "RUNNING").length,
      failed: workers.filter((worker) => worker.status === "FAILED").length,
      scheduled: workers.filter((worker) => worker.scheduleEnabled).length,
    };
  }, [workers]);

  const loadWorkers = React.useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch("/api/admin/worker-jobs", {
        cache: "no-store",
      });
      const payload = (await response.json()) as WorkerJobsApiResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(legacyApiMessage(payload, t("fallback.loadFailed")));
      }

      const items = payload.items ?? [];
      setWorkers(items);
      setManager(payload.manager ?? null);
      setReadSyncHealth(payload.readSyncHealth ?? null);
      setSelectedWorkerKey((current) =>
        current && items.some((worker) => worker.workerKey === current)
          ? current
          : items[0]?.workerKey ?? ""
      );
      setMessage(t("message.refreshed", { count: items.length }));
      setMessageTone("neutral");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setLoading(false);
    }
  }, [t]);

  async function postWorkerAction(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/worker-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as WorkerJobsApiResponse;

    if (!response.ok || !payload.ok) {
      throw new Error(legacyApiMessage(payload, t("fallback.actionFailed")));
    }

    return payload;
  }

  async function runWorker(workerKey: string) {
    setPendingAction({ workerKey, kind: "run" });
    setMessage(t("message.running", { key: workerKey }));
    setMessageTone("neutral");

    try {
      await postWorkerAction({ action: "runWorker", workerKey });
      setMessage(t("message.runComplete", { key: workerKey }));
      await loadWorkers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setPendingAction(null);
    }
  }

  async function runDueWorkers() {
    setPendingAction({ workerKey: "__due__", kind: "due" });
    setMessage(t("message.dueRunning"));
    setMessageTone("neutral");

    try {
      await postWorkerAction({ action: "runDue" });
      setMessage(
        t("message.dueComplete")
      );
      await loadWorkers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setPendingAction(null);
    }
  }

  async function updateSchedule(worker: WorkerJobDto, enabled: boolean) {
    setPendingAction({ workerKey: worker.workerKey, kind: "schedule" });
    setMessage(t("message.scheduleChanging", { key: worker.workerKey }));
    setMessageTone("neutral");

    try {
      await postWorkerAction({
        action: "updateSchedule",
        workerKey: worker.workerKey,
        scheduleEnabled: enabled,
        intervalSeconds: worker.intervalSeconds,
      });
      setMessage(
        t("message.scheduleChanged", { key: worker.workerKey, state: enabled ? t("columns.active") : t("columns.inactive") })
      );
      await loadWorkers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setPendingAction(null);
    }
  }

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadWorkers();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadWorkers]);

  const columns: DataGridColumn<WorkerColumnKey, WorkerJobDto>[] = [
      {
        key: "worker",
        label: "worker",
        width: "minmax(260px, 1.4fr)",
        cellClassName: workerTableCellClassName,
        placeholder: t("columns.search"),
        text: (worker) =>
          `${worker.workerName} ${worker.workerKey} ${workerTypeLabel(worker.workerType)}`,
        render: (worker) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{worker.workerName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {worker.workerKey} / {workerTypeLabel(worker.workerType)}
            </p>
          </div>
        ),
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "150px",
        cellClassName: workerTableCellClassName,
        text: (worker) => `${statusLabel(worker.status)} ${worker.status}`,
        render: (worker) => (
          <Badge variant={statusVariant(worker.status)}>
            {statusLabel(worker.status)}
          </Badge>
        ),
      },
      {
        key: "schedule",
        label: t("columns.schedule"),
        width: "180px",
        cellClassName: workerTableCellClassName,
        text: (worker) =>
          `${worker.schedulable ? (worker.scheduleEnabled ? t("columns.active") : t("columns.inactive")) : t("columns.manual")} ${worker.scheduleLabel || intervalText(worker.intervalSeconds)} ${worker.nextRunAt}`,
        render: (worker) => (
          <div className="min-w-0 text-xs">
            <p className="font-medium">
              {worker.schedulable
                ? worker.scheduleEnabled ? t("columns.active") : t("columns.inactive")
                : t("columns.manual")}
            </p>
            <p className="truncate text-muted-foreground">
              {worker.scheduleLabel ||
                t("columns.interval", { value: intervalText(worker.intervalSeconds) })}
            </p>
          </div>
        ),
      },
      {
        key: "progress",
        label: t("columns.progress"),
        width: "120px",
        cellClassName: workerTableCellClassName,
        text: (worker) => progressText(worker, locale),
        render: (worker) => (
          <span className="text-sm">{progressText(worker, locale)}</span>
        ),
      },
      {
        key: "lastRun",
        label: t("columns.lastRun"),
        width: "180px",
        cellClassName: workerTableCellClassName,
        text: (worker) => worker.lastRunAt || worker.finishedAt || worker.startedAt,
        render: (worker) => (
          <span className="truncate text-xs">
            {formatDate(worker.lastRunAt || worker.finishedAt || worker.startedAt)}
          </span>
        ),
      },
      {
        key: "actions",
        label: "",
        width: "260px",
        cellClassName:
          "flex h-full min-w-[250px] items-center justify-end gap-2 px-4",
        sortable: false,
        filterable: false,
        render: (worker) => {
          if (worker.managementSurface === "SERVER_CONSOLE") {
            return <Badge variant="neutral">{t("columns.serverConsole")}</Badge>;
          }

          const isRunning =
            pendingAction?.workerKey === worker.workerKey &&
            pendingAction.kind === "run";
          const isScheduleUpdating =
            pendingAction?.workerKey === worker.workerKey &&
            pendingAction.kind === "schedule";
          const disabled = Boolean(runningKey) || worker.status === "RUNNING";
          const scheduleDisabled =
            disabled || !worker.schedulable || worker.scheduleRequired;

          return (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={scheduleDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  void updateSchedule(worker, !worker.scheduleEnabled);
                }}
              >
                {!worker.schedulable
                  ? t("columns.manual")
                  : worker.scheduleRequired
                    ? t("columns.required")
                  : isScheduleUpdating
                  ? t("columns.changing")
                  : worker.scheduleEnabled
                    ? t("columns.disableSchedule")
                    : t("columns.enableSchedule")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  void runWorker(worker.workerKey);
                }}
              >
                <Play className="size-3.5" />
                {isRunning ? t("status.running") : t("columns.run")}
              </Button>
            </>
          );
        },
      },
  ];

  const managerStatus = manager?.started
    ? t("status.running")
    : manager?.starting
      ? t("status.starting")
      : manager?.disabledReason
        ? t("status.stopped")
        : "-";

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <section className="grid gap-3 md:grid-cols-5">
        <SummaryCard icon={ServerCog} label="worker manager" value={managerStatus} />
        <SummaryCard icon={ServerCog} label={t("summary.registered")} value={summary.total} />
        <SummaryCard icon={Clock3} label={t("summary.running")} value={summary.running} />
        <SummaryCard icon={TimerReset} label={t("summary.scheduled")} value={summary.scheduled} />
        <SummaryCard icon={AlertTriangle} label={t("summary.failed")} value={summary.failed} />
      </section>

      {readSyncHealth && readSyncHealth.interruptedCount > 0 ? (
        <div
          className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              {t("health.interrupted", { hours: readSyncHealth.lookbackHours, count: readSyncHealth.interruptedCount })}
            </p>
            {readSyncHealth.latestInterrupted ? (
              <p className="mt-1 truncate text-xs text-amber-800">
                {t("health.latest")} {readSyncHealth.latestInterrupted.apiName}
                {readSyncHealth.latestInterrupted.statusFilter
                  ? ` / ${readSyncHealth.latestInterrupted.statusFilter}`
                  : ""}
                {t("health.latestDetail", { stage: readSyncHealth.latestInterrupted.interruptedStage, date: formatDate(readSyncHealth.latestInterrupted.processedAt) })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <MasterDetailLayout
        as="section"
        className="grid-cols-[minmax(760px,1fr)_420px] gap-4"
      >
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t("toolbar.title")}</h2>
              <p
                className={cn(
                  "mt-1 truncate text-xs",
                  messageTone === "warning"
                    ? "text-amber-700"
                    : "text-muted-foreground"
                )}
              >
                {message}
              </p>
            </div>
            <div className="flex min-w-[360px] max-w-xl flex-1 items-center justify-end gap-2">
              <SearchInput
                value={query}
                onValueChange={setQuery}
                placeholder={t("toolbar.search")}
                aria-label={t("columns.search")}
              />
              <Button
                type="button"
                variant="outline"
                disabled={loading || Boolean(runningKey)}
                onClick={() => void loadWorkers()}
              >
                <RefreshCcw className="size-4" />
                {t("toolbar.refresh")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={loading || Boolean(runningKey)}
                title={t("toolbar.dueTitle")}
                onClick={() => void runDueWorkers()}
              >
                <CheckCircle2 className="size-4" />
                {t("toolbar.runDue")}
              </Button>
            </div>
          </div>

          <div className="border-b px-4 py-2">
            <Tabs
              value={activeWorkerGroup}
              onValueChange={(value) =>
                setActiveWorkerGroup(value as WorkerGroupKey)
              }
            >
              <TabsList className="max-w-full overflow-x-auto">
                {visibleWorkerGroups.map((group) => (
                  <TabsTrigger key={group.key} value={group.key}>
                    <span>{group.label}</span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {(workerGroupCounts.get(group.key) ?? 0).toLocaleString(locale)}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <VirtualizedDataGrid
            rows={filteredWorkers}
            columns={columns}
            rowKey={(worker) => worker.workerKey}
            selectedRowKey={selectedWorker?.workerKey ?? null}
            onRowClick={(worker) => setSelectedWorkerKey(worker.workerKey)}
            emptyMessage={
              loading ? t("toolbar.loading") : t("toolbar.empty")
            }
            minWidth="1180px"
            rowHeight={58}
          />
        </div>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">{t("detail.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("detail.subtitle")}
            </p>
          </div>

          {selectedWorker ? (
            <div className="min-h-0 flex-1 overflow-auto p-4 pb-6">
              <div className="grid gap-2">
                <DetailRow label="worker" value={selectedWorker.workerName} />
                <DetailRow label={t("detail.key")} value={selectedWorker.workerKey} />
                <DetailRow
                  label={t("detail.type")}
                  value={`${workerTypeLabel(selectedWorker.workerType)} / ${selectedWorker.workerType}`}
                />
                <DetailRow
                  label={t("detail.management")}
                  value={
                    selectedWorker.managementSurface === "SERVER_CONSOLE"
                      ? t("detail.serverManagement")
                      : t("detail.clientManagement")
                  }
                />
                <DetailRow
                  label={t("detail.status")}
                  value={statusLabel(selectedWorker.status)}
                />
                <DetailRow
                  label={t("detail.schedule")}
                  value={
                    selectedWorker.schedulable
                      ? `${
                          selectedWorker.scheduleEnabled
                            ? t("columns.active")
                            : t("columns.inactive")
                        } / ${
                          selectedWorker.scheduleLabel ||
                          intervalText(selectedWorker.intervalSeconds)
                        }`
                      : t("columns.manual")
                  }
                />
                <DetailRow
                  label={t("detail.nextRun")}
                  value={formatDate(selectedWorker.nextRunAt)}
                />
                <DetailRow
                  label={t("detail.lastRun")}
                  value={formatDate(selectedWorker.lastRunAt)}
                />
                <DetailRow
                  label={t("detail.started")}
                  value={formatDate(selectedWorker.startedAt)}
                />
                <DetailRow
                  label={t("detail.finished")}
                  value={formatDate(selectedWorker.finishedAt)}
                />
                <DetailRow
                  label={t("detail.progress")}
                  value={progressText(selectedWorker, locale)}
                />
                <DetailRow
                  label={t("detail.managerInterval")}
                  value={
                    manager ? t("interval.seconds", { seconds: manager.pollSeconds }) : ""
                  }
                />
                <DetailRow
                  label={t("detail.managerLastCheck")}
                  value={formatDate(manager?.lastTickAt ?? "")}
                />
                <DetailRow
                  label={t("detail.managerStatus")}
                  value={
                    manager?.disabledReason ||
                    manager?.lastErrorMessage ||
                    managerStatus
                  }
                />
                <DetailRow
                  label={t("detail.recovery")}
                  value={formatDate(manager?.lastReadSyncRecoveryAt ?? "")}
                />
                <DetailRow
                  label={t("detail.recoveryError")}
                  value={manager?.lastReadSyncRecoveryError ?? ""}
                />
                <DetailRow
                  label={t("detail.attempts")}
                  value={`${selectedWorker.attemptCount} / ${selectedWorker.maxAttempts}`}
                />
                <DetailRow label={t("detail.lockOwner")} value={selectedWorker.lockedBy} />
                <DetailRow
                  label={t("detail.lockExpiry")}
                  value={formatDate(selectedWorker.lockedUntil)}
                />
                <DetailRow
                  label={t("detail.lastActor")}
                  value={selectedWorker.displayName || selectedWorker.username}
                />
                <DetailRow
                  label={t("detail.lastError")}
                  value={
                    selectedWorker.lastErrorMessage
                      ? `${selectedWorker.lastErrorCode} ${selectedWorker.lastErrorMessage}`
                      : ""
                  }
                />
              </div>

              <div className="mt-4 grid gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  {t("detail.lastResult")}
                </h3>
                <div className="grid gap-2 rounded-md border bg-muted/20 p-3">
                  <DetailRow
                    label={t("detail.resultSummary")}
                    value={selectedWorker.resultSummaryText}
                  />
                  <DetailRow
                    label={t("detail.processed")}
                    value={selectedWorker.resultProcessedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("detail.success")}
                    value={selectedWorker.resultSucceededCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("detail.failed")}
                    value={selectedWorker.resultFailedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("detail.skipped")}
                    value={selectedWorker.resultSkippedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("detail.created")}
                    value={selectedWorker.resultCreatedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("detail.updated")}
                    value={selectedWorker.resultUpdatedCount?.toLocaleString(locale) ?? ""}
                  />
                  <DetailRow
                    label={t("detail.warning")}
                    value={selectedWorker.resultWarningCount?.toLocaleString(locale) ?? ""}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {t("detail.select")}
            </div>
          )}
        </aside>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
