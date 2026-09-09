// QuickHack note: 리더급 사용자가 직원별 주요 작업 이력을 표와 상세 패널로 조회하는 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
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

const ACTION_MESSAGE_KEYS = {
  INBOUND_BATCH_PLAN_CREATE: "inboundBatchPlanCreate", INBOUND_BATCH_PLAN_UPDATE: "inboundBatchPlanUpdate", INBOUND_BATCH_PLAN_DELETE: "inboundBatchPlanDelete", PURCHASE_PRICE_RATE_UPSERT: "purchasePriceRateUpsert", PURCHASE_CONFIRM: "purchaseConfirm", INVENTORY_CORRECTION: "inventoryCorrection", PRODUCT_CRITERIA_UPSERT: "productCriteriaUpsert", PRODUCT_CRITERIA_RELATIONS_UPDATE: "productCriteriaRelationsUpdate", CHANNEL_ORDER_MAPPING_SET: "channelOrderMappingSet", CHANNEL_ORDER_MANUAL_ASSIGN: "channelOrderManualAssign", CHANNEL_ORDER_MANUAL_REPLACE: "channelOrderManualReplace", CHANNEL_ORDER_MANUAL_RELEASE: "channelOrderManualRelease", CHANNEL_ORDER_MAPPING_REAPPLY: "channelOrderMappingReapply", COUPANG_ORDER_AUTO_MATCH: "coupangOrderAutoMatch", USER_ACCOUNT_CREATE: "userAccountCreate", USER_ACCOUNT_UPDATE: "userAccountUpdate", USER_ACCOUNT_DEACTIVATE: "userAccountDeactivate", USER_TOTP_RESET: "userTotpReset", USER_TOTP_RECOVERY_CODES_GENERATE: "userTotpRecoveryCodesGenerate", SYSTEM_TOTP_SECURITY_RESET: "systemTotpSecurityReset", SALES_OFFER_CREATE: "salesOfferCreate", SALES_OFFER_ACTIVATE: "salesOfferActivate", SALES_OFFER_DEACTIVATE: "salesOfferDeactivate", SALES_OFFER_BOOTSTRAP: "salesOfferBootstrap",
} as const;
const TARGET_MESSAGE_KEYS = { INBOUND_BATCH: "inboundBatch", INBOUND: "inbound", PURCHASE_PRICE_RATE: "purchasePriceRate", PURCHASE_CONFIRM: "purchaseConfirm", DEVICE: "device", USER: "user", PRODUCT_CRITERIA_OPTION: "productCriteriaOption", SALES_CHANNEL_ORDER_ITEM: "salesChannelOrderItem", CHANNEL_PRODUCT_MAPPING: "channelProductMapping", CHANNEL_ORDER_MAPPING: "channelOrderMapping", SALES_OFFER: "salesOffer" } as const;

type ActivityLabelResolver = {
  action: (value: string) => string;
  target: (value: string) => string;
  result: (value: string) => string;
};

function resultLabel(value: string, labels: { success: string; failure: string }) {
  if (value === "SUCCESS") {
    return labels.success;
  }

  if (["FAIL", "FAILED", "ERROR"].includes(value)) {
    return labels.failure;
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

function fileDate() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}

function ChangeListBlock({
  changes,
}: {
  changes: ActivityLogDto["changes"];
}) {
  const t = useTranslations("admin.activityLog");
  return (
    <div className="grid gap-2">
      <div className="text-xs font-semibold text-muted-foreground">{t("detail.changes")}</div>
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
  const t = useTranslations("admin.activityLog");
  const locale = useLocale();
  const activityLabels = React.useMemo<ActivityLabelResolver>(() => ({
    action: (value) => {
      const key = ACTION_MESSAGE_KEYS[value as keyof typeof ACTION_MESSAGE_KEYS];
      return key ? t(`action.${key}`) : value;
    },
    target: (value) => {
      const key = TARGET_MESSAGE_KEYS[value as keyof typeof TARGET_MESSAGE_KEYS];
      return key ? t(`target.${key}`) : value;
    },
    result: (value) => resultLabel(value, { success: t("result.success"), failure: t("result.failure") }),
  }), [t]);
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
      const response = await fetch(`/api/admin/activity-logs?${search}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(t("state.exportFailed"));
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
  }, [query, t]);

  const columns = React.useMemo<DataGridColumn<ActivityLogColumnKey, ActivityLogDto>[]>(
    () => [
      {
        key: "createdAt",
        label: t("columns.at"),
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
        label: t("columns.actor"),
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
        label: t("columns.action"),
        width: "1.35fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${activityLabels.action(log.actionType)} ${log.actionType}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{activityLabels.action(log.actionType)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.actionType}
            </div>
          </div>
        ),
      },
      {
        key: "target",
        label: t("columns.target"),
        width: "1.35fr",
        cellClassName: "flex h-full min-w-0 items-center px-3",
        text: (log) => `${activityLabels.target(log.targetType)} ${log.targetType} ${log.targetId}`,
        render: (log) => (
          <div className="min-w-0">
            <div className="truncate">{activityLabels.target(log.targetType)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {log.targetId || "-"}
            </div>
          </div>
        ),
      },
      {
        key: "result",
        label: t("columns.result"),
        width: "0.75fr",
        cellClassName: "flex h-full min-w-0 items-center pl-3 pr-4",
        text: (log) => `${activityLabels.result(log.result)} ${log.result}`,
        render: (log) => (
          <Badge variant={resultVariant(log.result)}>{activityLabels.result(log.result)}</Badge>
        ),
      },
    ],
    [activityLabels, t]
  );

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ClipboardList} label={t("summary.logs")} value={summary.total} />
        <SummaryCard icon={UserRound} label={t("summary.actors")} value={summary.workers} />
        <SummaryCard icon={CheckCircle2} label={t("summary.success")} value={summary.success} />
        <SummaryCard icon={XCircle} label={t("summary.failure")} value={summary.failure} />
      </SummaryStrip>

      <MasterDetailLayout className="grid-cols-[minmax(720px,1fr)_420px] gap-4">
        <WorkspacePanel>
          <PanelToolbar className="grid-cols-[minmax(260px,1fr)_auto_auto]">
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
              cn(log.result !== "SUCCESS" && "bg-amber-50/40")
            }
            minWidth="980px"
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
                  <DetailRow label={t("columns.at")} value={formatDate(selectedLog.createdAt)} />
                  <DetailRow
                    label={t("columns.actor")}
                    value={`${selectedLog.displayName || "-"} (${selectedLog.username || "-"})`}
                  />
                  <DetailRow
                    label={t("columns.action")}
                    value={`${activityLabels.action(selectedLog.actionType)} / ${selectedLog.actionType}`}
                  />
                  <DetailRow
                    label={t("columns.target")}
                    value={`${activityLabels.target(selectedLog.targetType)} / ${selectedLog.targetId || "-"}`}
                  />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("columns.result")}</span>
                    <Badge variant={resultVariant(selectedLog.result)}>
                      {activityLabels.result(selectedLog.result)}
                    </Badge>
                  </div>
                </div>

                <div className="grid gap-2 rounded-md border p-3">
                  <DetailRow
                    label={t("detail.before")}
                    value={selectedLog.beforeSummaryText || "-"}
                  />
                  <DetailRow
                    label={t("detail.after")}
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
