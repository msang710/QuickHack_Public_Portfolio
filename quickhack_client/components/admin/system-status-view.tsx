// QuickHack note: 시스템 상태 메뉴에서 서버 내부 worker 상태와 실행 제어를 확인하는 화면입니다.
"use client";

import * as React from "react";
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
const WORKER_GROUPS: Array<{
  key: WorkerGroupKey;
  label: string;
}> = [
  { key: "all", label: "전체" },
  { key: "quickhack-internal", label: "QuickHack 내부 시스템" },
  { key: "coupang-api", label: "쿠팡 API" },
  { key: "naver-api", label: "네이버 API" },
  { key: "elevenstreet-api", label: "11번가 API" },
  { key: "esm-api", label: "ESM API" },
  { key: "cafe24-api", label: "자사몰 API" },
];

const WORKER_TYPE_LABELS: Record<string, string> = {
  COUPANG_SYNC: "쿠팡 동기화",
  ORDER_MATCHING: "주문 매칭",
  INVOICE: "송장",
  RETURN_SYNC: "반품 동기화",
  DATABASE_BACKUP: "DB 백업",
  BACKUP_MAINTENANCE: "백업 점검",
  SECURITY_MAINTENANCE: "보안 점검",
  OBSERVABILITY_MAINTENANCE: "관측 데이터 정리",
  INVENTORY_AUDIT: "재고 점검",
};

const STATUS_LABELS: Record<string, string> = {
  IDLE: "대기",
  RUNNING: "실행 중",
  SUCCESS: "성공",
  FAILED: "실패",
  RETRY_WAITING: "재시도 대기",
  DISABLED: "비활성",
};

function workerTypeLabel(value: string) {
  return WORKER_TYPE_LABELS[value] ?? value;
}

function statusLabel(value: string) {
  return STATUS_LABELS[value] ?? (value || "-");
}

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

function progressText(worker: WorkerJobDto) {
  if (worker.progressTotal && worker.progressTotal > 0) {
    return `${worker.progressCurrent.toLocaleString()} / ${worker.progressTotal.toLocaleString()}`;
  }

  if (worker.progressCurrent > 0) {
    return worker.progressCurrent.toLocaleString();
  }

  return "-";
}

function intervalText(seconds: number | null) {
  if (!seconds) {
    return "-";
  }

  if (seconds < 60) {
    return `${seconds}초`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (remainingSeconds === 0) {
    return `${minutes}분`;
  }

  return `${minutes}분 ${remainingSeconds}초`;
}

function workerSearchText(worker: WorkerJobDto) {
  return [
    worker.workerKey,
    worker.workerName,
    workerTypeLabel(worker.workerType),
    worker.workerType,
    statusLabel(worker.status),
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
  const [message, setMessage] = React.useState("worker 상태를 불러오는 중입니다.");
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
    return WORKER_GROUPS.filter((group) => {
      if (group.key === "all" || group.key === "quickhack-internal") {
        return true;
      }

      return (
        group.key === activeWorkerGroup ||
        (workerGroupCounts.get(group.key) ?? 0) > 0
      );
    });
  }, [activeWorkerGroup, workerGroupCounts]);

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
      workerSearchText(worker).includes(normalizedQuery)
    );
  }, [activeWorkerGroup, query, workers]);

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

  async function loadWorkers() {
    setLoading(true);

    try {
      const response = await fetch("/api/admin/worker-jobs", {
        cache: "no-store",
      });
      const payload = (await response.json()) as WorkerJobsApiResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "worker 상태를 불러오지 못했습니다.");
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
      setMessage(`worker ${items.length}개 상태를 갱신했습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function postWorkerAction(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/worker-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as WorkerJobsApiResponse;

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "worker 작업에 실패했습니다.");
    }

    return payload;
  }

  async function runWorker(workerKey: string) {
    setPendingAction({ workerKey, kind: "run" });
    setMessage(`${workerKey} worker 실행 중입니다.`);

    try {
      await postWorkerAction({ action: "runWorker", workerKey });
      setMessage(`${workerKey} worker 실행 요청이 완료되었습니다.`);
      await loadWorkers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function runDueWorkers() {
    setPendingAction({ workerKey: "__due__", kind: "due" });
    setMessage("실행 시점이 된 일반 worker를 확인하는 중입니다.");

    try {
      await postWorkerAction({ action: "runDue" });
      setMessage(
        "실행 시점이 된 일반 worker 확인을 완료했습니다. 백업 작업은 서버 콘솔에서 관리합니다."
      );
      await loadWorkers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function updateSchedule(worker: WorkerJobDto, enabled: boolean) {
    setPendingAction({ workerKey: worker.workerKey, kind: "schedule" });
    setMessage(`${worker.workerKey} worker 스케줄을 변경하는 중입니다.`);

    try {
      await postWorkerAction({
        action: "updateSchedule",
        workerKey: worker.workerKey,
        scheduleEnabled: enabled,
        intervalSeconds: worker.intervalSeconds,
      });
      setMessage(
        `${worker.workerKey} worker 스케줄을 ${enabled ? "활성화" : "비활성화"}했습니다.`
      );
      await loadWorkers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadWorkers();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, []);

  const columns: DataGridColumn<WorkerColumnKey, WorkerJobDto>[] = [
      {
        key: "worker",
        label: "worker",
        width: "minmax(260px, 1.4fr)",
        cellClassName: workerTableCellClassName,
        placeholder: "worker 검색",
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
        label: "상태",
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
        label: "스케줄",
        width: "180px",
        cellClassName: workerTableCellClassName,
        text: (worker) =>
          `${worker.schedulable ? (worker.scheduleEnabled ? "활성" : "비활성") : "수동 전용"} ${worker.scheduleLabel || intervalText(worker.intervalSeconds)} ${worker.nextRunAt}`,
        render: (worker) => (
          <div className="min-w-0 text-xs">
            <p className="font-medium">
              {worker.schedulable
                ? worker.scheduleEnabled
                  ? "활성"
                  : "비활성"
                : "수동 전용"}
            </p>
            <p className="truncate text-muted-foreground">
              {worker.scheduleLabel ||
                `주기 ${intervalText(worker.intervalSeconds)}`}
            </p>
          </div>
        ),
      },
      {
        key: "progress",
        label: "진행",
        width: "120px",
        cellClassName: workerTableCellClassName,
        text: progressText,
        render: (worker) => (
          <span className="text-sm">{progressText(worker)}</span>
        ),
      },
      {
        key: "lastRun",
        label: "최근 실행",
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
            return <Badge variant="neutral">서버 콘솔에서 관리</Badge>;
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
                  ? "수동 전용"
                  : worker.scheduleRequired
                    ? "필수 스케줄"
                  : isScheduleUpdating
                  ? "변경 중"
                  : worker.scheduleEnabled
                    ? "스케줄 끄기"
                    : "스케줄 켜기"}
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
                {isRunning ? "실행 중" : "실행"}
              </Button>
            </>
          );
        },
      },
  ];

  const managerStatus = manager?.started
    ? "실행 중"
    : manager?.starting
      ? "시작 중"
      : manager?.disabledReason
        ? "중지"
        : "-";

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <section className="grid gap-3 md:grid-cols-5">
        <SummaryCard icon={ServerCog} label="worker manager" value={managerStatus} />
        <SummaryCard icon={ServerCog} label="등록 worker" value={summary.total} />
        <SummaryCard icon={Clock3} label="실행 중" value={summary.running} />
        <SummaryCard icon={TimerReset} label="스케줄 활성" value={summary.scheduled} />
        <SummaryCard icon={AlertTriangle} label="실패" value={summary.failed} />
      </section>

      {readSyncHealth && readSyncHealth.interruptedCount > 0 ? (
        <div
          className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              최근 {readSyncHealth.lookbackHours}시간 동안 중단된 쿠팡 조회가 {readSyncHealth.interruptedCount.toLocaleString("ko-KR")}건 있습니다.
            </p>
            {readSyncHealth.latestInterrupted ? (
              <p className="mt-1 truncate text-xs text-amber-800">
                최근: {readSyncHealth.latestInterrupted.apiName}
                {readSyncHealth.latestInterrupted.statusFilter
                  ? ` / ${readSyncHealth.latestInterrupted.statusFilter}`
                  : ""}
                {` / ${readSyncHealth.latestInterrupted.interruptedStage} 단계 / ${formatDate(readSyncHealth.latestInterrupted.processedAt)}`}
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
              <h2 className="text-sm font-semibold">worker 상태</h2>
              <p
                className={cn(
                  "mt-1 truncate text-xs",
                  message.includes("실패") || message.includes("못했습니다")
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
                placeholder="worker, 상태, 오류 검색"
                aria-label="worker 검색"
              />
              <Button
                type="button"
                variant="outline"
                disabled={loading || Boolean(runningKey)}
                onClick={() => void loadWorkers()}
              >
                <RefreshCcw className="size-4" />
                새로고침
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={loading || Boolean(runningKey)}
                title="서버 콘솔에서 관리하는 백업 작업은 제외합니다."
                onClick={() => void runDueWorkers()}
              >
                <CheckCircle2 className="size-4" />
                예정 작업 실행
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
                      {(workerGroupCounts.get(group.key) ?? 0).toLocaleString("ko-KR")}
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
              loading ? "worker 상태를 불러오는 중입니다." : "등록된 worker가 없습니다."
            }
            minWidth="1180px"
            rowHeight={58}
          />
        </div>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">worker 상세</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              선택한 worker의 lock, 스케줄, 마지막 실행 결과를 확인합니다.
            </p>
          </div>

          {selectedWorker ? (
            <div className="min-h-0 flex-1 overflow-auto p-4 pb-6">
              <div className="grid gap-2">
                <DetailRow label="worker" value={selectedWorker.workerName} />
                <DetailRow label="키" value={selectedWorker.workerKey} />
                <DetailRow
                  label="분류"
                  value={`${workerTypeLabel(selectedWorker.workerType)} / ${selectedWorker.workerType}`}
                />
                <DetailRow
                  label="관리 위치"
                  value={
                    selectedWorker.managementSurface === "SERVER_CONSOLE"
                      ? "서버 콘솔 · DB 백업 관리"
                      : "QuickHack · 시스템 상태"
                  }
                />
                <DetailRow
                  label="상태"
                  value={statusLabel(selectedWorker.status)}
                />
                <DetailRow
                  label="스케줄"
                  value={
                    selectedWorker.schedulable
                      ? `${
                          selectedWorker.scheduleEnabled
                            ? "활성"
                            : "비활성"
                        } / ${
                          selectedWorker.scheduleLabel ||
                          intervalText(selectedWorker.intervalSeconds)
                        }`
                      : "수동 전용"
                  }
                />
                <DetailRow
                  label="다음 실행"
                  value={formatDate(selectedWorker.nextRunAt)}
                />
                <DetailRow
                  label="최근 실행"
                  value={formatDate(selectedWorker.lastRunAt)}
                />
                <DetailRow
                  label="시작"
                  value={formatDate(selectedWorker.startedAt)}
                />
                <DetailRow
                  label="종료"
                  value={formatDate(selectedWorker.finishedAt)}
                />
                <DetailRow label="진행률" value={progressText(selectedWorker)} />
                <DetailRow
                  label="manager 주기"
                  value={
                    manager ? `${manager.pollSeconds}초` : ""
                  }
                />
                <DetailRow
                  label="manager 최근 확인"
                  value={formatDate(manager?.lastTickAt ?? "")}
                />
                <DetailRow
                  label="manager 상태"
                  value={
                    manager?.disabledReason ||
                    manager?.lastErrorMessage ||
                    managerStatus
                  }
                />
                <DetailRow
                  label="조회 중단 점검"
                  value={formatDate(manager?.lastReadSyncRecoveryAt ?? "")}
                />
                <DetailRow
                  label="조회 중단 점검 오류"
                  value={manager?.lastReadSyncRecoveryError ?? ""}
                />
                <DetailRow
                  label="시도 횟수"
                  value={`${selectedWorker.attemptCount} / ${selectedWorker.maxAttempts}`}
                />
                <DetailRow label="lock 소유" value={selectedWorker.lockedBy} />
                <DetailRow
                  label="lock 만료"
                  value={formatDate(selectedWorker.lockedUntil)}
                />
                <DetailRow
                  label="마지막 실행자"
                  value={selectedWorker.displayName || selectedWorker.username}
                />
                <DetailRow
                  label="마지막 오류"
                  value={
                    selectedWorker.lastErrorMessage
                      ? `${selectedWorker.lastErrorCode} ${selectedWorker.lastErrorMessage}`
                      : ""
                  }
                />
              </div>

              <div className="mt-4 grid gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  마지막 결과
                </h3>
                <div className="grid gap-2 rounded-md border bg-muted/20 p-3">
                  <DetailRow
                    label="결과 요약"
                    value={selectedWorker.resultSummaryText}
                  />
                  <DetailRow
                    label="처리"
                    value={selectedWorker.resultProcessedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="성공"
                    value={selectedWorker.resultSucceededCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="실패"
                    value={selectedWorker.resultFailedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="건너뜀"
                    value={selectedWorker.resultSkippedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="생성"
                    value={selectedWorker.resultCreatedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="수정"
                    value={selectedWorker.resultUpdatedCount?.toLocaleString("ko-KR") ?? ""}
                  />
                  <DetailRow
                    label="주의"
                    value={selectedWorker.resultWarningCount?.toLocaleString("ko-KR") ?? ""}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              왼쪽 표에서 worker를 선택하세요.
            </div>
          )}
        </aside>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
