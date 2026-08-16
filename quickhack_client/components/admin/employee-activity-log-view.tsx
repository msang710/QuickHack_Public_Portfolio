// QuickHack note: 리더급 사용자가 직원별 주요 작업 이력을 표와 상세 패널로 조회하는 화면입니다.
"use client";

import * as React from "react";
import {
  CheckCircle2,
  ClipboardList,
  Download,
  RefreshCcw,
  UserRound,
  XCircle,
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

type ActivityLogDto = {
  id: number;
  userId: number | null;
  username: string;
  displayName: string;
  actionType: string;
  targetType: string;
  targetId: string;
  beforeSummaryText: string;
  afterSummaryText: string;
  changes: Array<{
    fieldName: string;
    beforeValue: string;
    afterValue: string;
  }>;
  result: string;
  createdAt: string;
};

type ActivityLogsApiResponse = {
  ok: boolean;
  message?: string;
  items?: ActivityLogDto[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
  summary?: {
    total: number;
    success: number;
    failure: number;
    workers: number;
  };
};

type ActivityLogColumnKey =
  | "createdAt"
  | "actor"
  | "actionType"
  | "target"
  | "result";

const ACTION_LABELS: Record<string, string> = {
  INBOUND_BATCH_PLAN_CREATE: "차수 지정 생성",
  INBOUND_BATCH_PLAN_UPDATE: "차수 지정 수정",
  INBOUND_BATCH_PLAN_DELETE: "차수 지정 삭제",
  PURCHASE_PRICE_RATE_UPSERT: "매입가 지정 저장",
  PURCHASE_CONFIRM: "매입 확정",
  INVENTORY_CORRECTION: "기존 재고 수정",
  PRODUCT_CRITERIA_UPSERT: "상품 기준값 저장",
  PRODUCT_CRITERIA_RELATIONS_UPDATE: "연결 기준값 저장",
  CHANNEL_ORDER_MAPPING_SET: "채널 주문 매칭 저장",
  CHANNEL_ORDER_MAPPING_REAPPLY: "기존 주문 매핑 재적용",
  COUPANG_ORDER_AUTO_MATCH: "쿠팡 주문 자동 매칭",
  USER_ACCOUNT_CREATE: "사용자 계정 생성",
  USER_ACCOUNT_UPDATE: "사용자 계정 수정",
  USER_ACCOUNT_DEACTIVATE: "사용자 계정 비활성화",
  USER_TOTP_RESET: "사용자 OTP 초기화",
  USER_TOTP_RECOVERY_CODES_GENERATE: "OTP 복구코드 발급",
  SYSTEM_TOTP_SECURITY_RESET: "OTP 보안 전체 초기화",
  SALES_OFFER_CREATE: "판매 구성 생성",
  SALES_OFFER_ACTIVATE: "판매 구성 활성화",
  SALES_OFFER_DEACTIVATE: "판매 구성 비활성화",
  SALES_OFFER_BOOTSTRAP: "기본 판매 구성 확인",
};

const TARGET_LABELS: Record<string, string> = {
  INBOUND_BATCH: "차수",
  INBOUND: "입고",
  PURCHASE_PRICE_RATE: "매입가",
  PURCHASE_CONFIRM: "매입 확정",
  DEVICE: "기기",
  USER: "사용자 계정",
  PRODUCT_CRITERIA_OPTION: "상품 기준값",
  SALES_CHANNEL_ORDER_ITEM: "판매 채널 주문",
  CHANNEL_PRODUCT_MAPPING: "채널 상품 매핑",
  CHANNEL_ORDER_MAPPING: "채널 주문 매칭",
  SALES_OFFER: "판매 구성",
};

function actionLabel(value: string) {
  return ACTION_LABELS[value] ?? value;
}

function targetLabel(value: string) {
  return TARGET_LABELS[value] ?? value;
}

function resultLabel(value: string) {
  if (value === "SUCCESS") {
    return "성공";
  }

  if (["FAIL", "FAILED", "ERROR"].includes(value)) {
    return "실패";
  }

  return value || "-";
}

function resultVariant(value: string) {
  if (value === "SUCCESS") {
    return "success" as const;
  }

  if (["FAIL", "FAILED", "ERROR"].includes(value)) {
    return "danger" as const;
  }

  return "neutral" as const;
}

export function logSearchText(log: ActivityLogDto) {
  return [
    log.displayName,
    log.username,
    actionLabel(log.actionType),
    log.actionType,
    targetLabel(log.targetType),
    log.targetType,
    log.targetId,
    resultLabel(log.result),
    log.result,
    log.createdAt,
    ...log.changes.map((change) => change.fieldName),
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

export function downloadCsv(rows: ActivityLogDto[]) {
  const header = [
    "일시",
    "작업자",
    "아이디",
    "작업 유형",
    "대상 유형",
    "대상 ID",
    "결과",
    "변경 전",
    "변경 후",
  ];
  const body = rows.map((row) => [
    row.createdAt,
    row.displayName,
    row.username,
    actionLabel(row.actionType),
    targetLabel(row.targetType),
    row.targetId,
    resultLabel(row.result),
    row.beforeSummaryText,
    row.afterSummaryText,
    row.changes
      .map(
        (change) =>
          `${change.fieldName}: ${change.beforeValue || "-"} -> ${change.afterValue || "-"}`
      )
      .join(" / "),
  ]);
  downloadCsvFile(`직원작업이력_${fileDate()}.csv`, [header, ...body]);
}

function ChangeListBlock({
  changes,
}: {
  changes: ActivityLogDto["changes"];
}) {
  return (
    <div className="grid gap-2">
      <div className="text-xs font-semibold text-muted-foreground">변경 상세</div>
      <div className="grid max-h-72 overflow-auto rounded-md border bg-secondary/40 p-3 text-xs leading-5">
        {changes.length > 0 ? (
          changes.map((change) => (
            <div
              key={`${change.fieldName}:${change.beforeValue}:${change.afterValue}`}
              className="grid grid-cols-[minmax(110px,0.35fr)_1fr_1fr] gap-3 border-b py-1 last:border-b-0"
            >
              <span className="truncate text-muted-foreground">
                {change.fieldName}
              </span>
              <span className="break-words">{change.beforeValue || "-"}</span>
              <span className="break-words">{change.afterValue || "-"}</span>
            </div>
          ))
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </div>
    </div>
  );
}

export function EmployeeActivityLogView() {
  const [logs, setLogs] = React.useState<ActivityLogDto[]>([]);
  const [query, setQuery] = React.useState("");
  const [selectedLogId, setSelectedLogId] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isExporting, setIsExporting] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [summary, setSummary] = React.useState({
    total: 0,
    success: 0,
    failure: 0,
    workers: 0,
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
      const response = await fetch(`/api/admin/activity-logs?${search}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as
        | ActivityLogsApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "직원 작업 이력을 불러오지 못했습니다.");
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
        success: 0,
        failure: 0,
        workers: 0,
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
      const response = await fetch(`/api/admin/activity-logs?${search}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("CSV export failed.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `employee_activity_logs_${fileDate()}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [query]);

  const columns = React.useMemo<DataGridColumn<ActivityLogColumnKey, ActivityLogDto>[]>(
    () => [
      {
        key: "createdAt",
        label: "일시",
        width: "1.2fr",
        cellClassName: "flex h-full min-w-0 items-center pl-4 pr-3",
        text: (log) => log.createdAt,
        render: (log) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(log.createdAt)}
          </span>
        ),
      },
      {
        key: "actor",
        label: "작업자",
        width: "1.1fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${log.displayName} ${log.username}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate font-semibold">{log.displayName || "-"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.username || "-"}
            </div>
          </div>
        ),
      },
      {
        key: "actionType",
        label: "작업 유형",
        width: "1.35fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${actionLabel(log.actionType)} ${log.actionType}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{actionLabel(log.actionType)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.actionType}
            </div>
          </div>
        ),
      },
      {
        key: "target",
        label: "대상",
        width: "1.35fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${targetLabel(log.targetType)} ${log.targetType} ${log.targetId}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate">{targetLabel(log.targetType)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.targetId || "-"}
            </div>
          </div>
        ),
      },
      {
        key: "result",
        label: "결과",
        width: "0.75fr",
        cellClassName: "flex h-full min-w-0 items-center pl-3 pr-4",
        text: (log) => `${resultLabel(log.result)} ${log.result}`,
        render: (log) => (
          <Badge variant={resultVariant(log.result)}>{resultLabel(log.result)}</Badge>
        ),
      },
    ],
    []
  );

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ClipboardList} label="조회 로그" value={summary.total} />
        <SummaryCard icon={UserRound} label="작업자" value={summary.workers} />
        <SummaryCard icon={CheckCircle2} label="성공" value={summary.success} />
        <SummaryCard icon={XCircle} label="실패" value={summary.failure} />
      </SummaryStrip>

      <MasterDetailLayout className="grid-cols-[minmax(720px,1fr)_420px] gap-4">
        <WorkspacePanel>
          <PanelToolbar className="grid-cols-[minmax(260px,1fr)_auto_auto]">
            <SearchInput
              aria-label="직원 작업 이력 검색"
              placeholder="작업자, 작업 유형, 대상, 결과 검색"
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
                ? "직원 작업 이력을 불러오는 중입니다."
                : "조회된 직원 작업 이력이 없습니다."
            }
            selectedRowKey={selectedLogId}
            onRowClick={(log) => setSelectedLogId(log.id)}
            getRowClassName={(log) =>
              cn(log.result !== "SUCCESS" && "bg-amber-50/40")
            }
            minWidth="980px"
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
            <h2 className="text-sm font-semibold">작업 이력 상세</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              선택한 로그의 대상과 변경 전후 데이터를 확인합니다.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selectedLog ? (
              <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                왼쪽 표에서 로그를 선택하세요.
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow label="일시" value={formatDate(selectedLog.createdAt)} />
                  <DetailRow
                    label="작업자"
                    value={`${selectedLog.displayName || "-"} (${selectedLog.username || "-"})`}
                  />
                  <DetailRow
                    label="작업 유형"
                    value={`${actionLabel(selectedLog.actionType)} / ${selectedLog.actionType}`}
                  />
                  <DetailRow
                    label="대상"
                    value={`${targetLabel(selectedLog.targetType)} / ${selectedLog.targetId || "-"}`}
                  />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">결과</span>
                    <Badge variant={resultVariant(selectedLog.result)}>
                      {resultLabel(selectedLog.result)}
                    </Badge>
                  </div>
                </div>

                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow
                    label="변경 전 요약"
                    value={selectedLog.beforeSummaryText || "-"}
                  />
                  <DetailRow
                    label="변경 후 요약"
                    value={selectedLog.afterSummaryText || "-"}
                  />
                </div>
                <ChangeListBlock changes={selectedLog.changes} />
              </div>
            )}
          </div>
        </WorkspacePanel>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
