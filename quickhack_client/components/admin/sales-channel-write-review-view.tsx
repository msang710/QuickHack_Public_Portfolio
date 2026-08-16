"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  PauseCircle,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import {
  createInvoiceActionNoteSnapshot,
  invoiceActionNoteSnapshotsEqual,
  salesChannelWriteReviewFormId,
} from "@/quickhack_client/components/invoice/invoice-operation-draft-state";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import {
  DescriptionList,
  DescriptionRow,
} from "@/quickhack_client/components/ui/description-list";
import { MasterDetailLayout } from "@/quickhack_client/components/ui/workspace-layout";
import {
  formatSalesChannelSyncCheckDate,
  salesChannelWriteStatusVariant,
} from "@/quickhack_client/components/admin/sales-channel-sync-check-presentation";
import { cn } from "@/quickhack_shared/core/utils";
import {
  mutationWakeDeferred,
  type MutationReceipt,
} from "@/quickhack_shared/core/mutation-receipt";
import {
  SALES_CHANNEL_WRITE_REQUEST_LABELS,
  SALES_CHANNEL_WRITE_STATUS_LABELS,
} from "@/quickhack_shared/sales-channel/write-requests";
import type {
  SalesChannelWriteControlDto,
  SalesChannelWriteReviewItemDto,
} from "@/quickhack_shared/sales-channel/sync-checks";

type ApiResponse = {
  ok: boolean;
  message?: string;
  unresolvedCount?: number;
  items?: SalesChannelWriteReviewItemDto[];
  controls?: SalesChannelWriteControlDto[];
  receipt?: MutationReceipt<unknown>;
};

const STATUS_OPTIONS = [
  ["UNRESOLVED", "확인 필요"],
  ["ALL", "전체"],
  ["LOCAL_PENDING", "내부 확정 필요"],
  ["COMPLETED", "처리 완료"],
  ["PARTIALLY_COMPLETED", "일부 처리 완료"],
  ["NOT_APPLIED", "채널 미반영"],
  ["REJECTED", "요청 차단"],
] as const;

const TARGET_EXTERNAL_STATUS_LABELS: Record<string, string> = {
  PENDING: "대기",
  SUCCEEDED: "성공",
  NOT_APPLIED: "미반영",
  UNKNOWN: "확인 필요",
};

const TARGET_LOCAL_STATUS_LABELS: Record<string, string> = {
  PENDING: "대기",
  SUCCEEDED: "완료",
  NOT_REQUIRED: "불필요",
  FAILED: "실패",
};

function DetailLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <DescriptionRow label={label} value={value} labelWidth="112px" />
  );
}

export function SalesChannelWriteControlAlerts({
  controls,
  working,
  onResume,
}: {
  controls: SalesChannelWriteControlDto[];
  working: boolean;
  onResume: (control: SalesChannelWriteControlDto) => unknown | Promise<unknown>;
}) {
  const pausedControls = controls.filter((control) => control.isPaused);

  if (pausedControls.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
      <PauseCircle className="size-4 shrink-0" />
      <strong>외부 쓰기 일시 정지</strong>
      {pausedControls.map((control) => (
        <div key={control.id} className="flex items-center gap-2">
          <span>
            {control.channel} {control.requestType} · 연속{" "}
            {control.consecutiveFailureCount}회
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => void onResume(control)}
          >
            다시 열기
          </Button>
        </div>
      ))}
    </div>
  );
}

export function SalesChannelWriteReviewDetail({
  item,
  working,
  note,
  onNoteChange,
  onRecheck,
  onRetryLocal,
  onDecision,
  onOpenSourceMenu,
}: {
  item: SalesChannelWriteReviewItemDto;
  working: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onRecheck: () => unknown | Promise<unknown>;
  onRetryLocal: () => unknown | Promise<unknown>;
  onDecision: (
    decision: string,
    representativeTargetId: number
  ) => unknown | Promise<unknown>;
  onOpenSourceMenu?: (menuId: string) => void;
}) {
  const requiresReview =
    item.requestStatus === "REVIEW_REQUIRED" ||
    item.requestStatus === "LOCAL_PENDING";
  const reviewOperationInProgress = item.reviewOperationInProgress;
  const actionDisabled = working || reviewOperationInProgress;
  const noteId = `sales-channel-write-review-note-${item.id}`;
  const targetGroups = Array.from(
    item.targets.reduce((groups, target) => {
      const group = groups.get(target.resolutionGroupKey);
      if (group) {
        group.targets.push(target);
      } else {
        groups.set(target.resolutionGroupKey, {
          groupKey: target.resolutionGroupKey,
          representativeTargetId:
            target.resolutionGroupRepresentativeTargetId,
          targets: [target],
        });
      }
      return groups;
    }, new Map<string, {
      groupKey: string;
      representativeTargetId: number;
      targets: SalesChannelWriteReviewItemDto["targets"];
    }>()).values()
  );

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-4 py-3">
        <ShieldAlert className="size-4 text-red-700" />
        <h3 className="text-sm font-semibold">요청 #{item.id} 확인</h3>
        {item.sourceMenuKey && onOpenSourceMenu ? (
          <Button
            className="ml-auto"
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => onOpenSourceMenu(item.sourceMenuKey)}
          >
            <ExternalLink className="size-4" />
            원래 업무 화면
          </Button>
        ) : null}
      </div>
      <DescriptionList className="px-4 py-2">
        <DetailLine
          label="채널 / 처리"
          value={`${item.channel} · ${SALES_CHANNEL_WRITE_REQUEST_LABELS[item.requestType] ?? item.requestType}`}
        />
        <DetailLine label="주문번호" value={item.externalOrderId || "-"} />
        <DetailLine label="대상" value={item.targetExternalId || "-"} />
        <DetailLine
          label="상태 전이"
          value={`${item.expectedBeforeStatus || "-"} → ${item.requestedAfterStatus || "-"}`}
        />
        <DetailLine label="실패 단계" value={item.failureStage || "-"} />
        <DetailLine
          label="오류"
          value={
            <span className="break-words">
              {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") ||
                "-"}
            </span>
          }
        />
        <DetailLine label="요청자" value={item.requestedBy || "-"} />
        <DetailLine
          label="확인 일시"
          value={formatSalesChannelSyncCheckDate(item.reviewRequiredAt)}
        />
      </DescriptionList>

      <div className="border-y border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            이 요청과 관련된 정보와 처리 결과를 반드시 각 채널의 웹사이트에서
            재확인하세요. 쓰기 API는 자동으로 다시 호출되지 않습니다.
          </p>
        </div>
      </div>

      {reviewOperationInProgress ? (
        <div
          className="flex items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950"
          role="status"
          aria-live="polite"
        >
          <RefreshCcw className="size-4 animate-spin" />
          {item.activeReviewOperation === "LOCAL_FINALIZE"
            ? "QuickHack 내부 확정을 처리하고 있습니다. 완료 후 다시 시도하세요."
            : "판매 채널 상태를 재점검하고 있습니다. 완료 후 다시 시도하세요."}
        </div>
      ) : null}

      {requiresReview ? (
        <div className="space-y-3 p-4">
          <div>
            <label
              className="mb-1 block text-xs font-medium text-muted-foreground"
              htmlFor={noteId}
            >
              확인 결과와 판단 근거
            </label>
            <textarea
              id={noteId}
              className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="채널 웹사이트에서 확인한 상태, 확인 시각, 판단 근거를 입력하세요."
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {item.requestStatus === "REVIEW_REQUIRED" ? (
              <Button
                variant="outline"
                disabled={actionDisabled}
                onClick={() => void onRecheck()}
              >
                <RefreshCcw className="size-4" />
                상태 한 번 재조회
              </Button>
            ) : null}
            {item.requestStatus === "LOCAL_PENDING" ? (
              <Button
                variant="outline"
                disabled={actionDisabled}
                onClick={() => void onRetryLocal()}
              >
                <RotateCcw className="size-4" />
                내부 확정 재실행
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          이 요청은 이미 확정된 상태이므로 추가 판정 작업을 할 수 없습니다.
        </div>
      )}

      <div className="border-t border-border p-4">
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
          대상 스냅샷
        </h4>
        <div className="space-y-3 text-xs">
          {targetGroups.map((group) => {
            const groupUnknown = group.targets.every(
              (target) => target.externalResultStatus === "UNKNOWN"
            );
            return (
              <section
                key={group.groupKey}
                className="rounded-md border border-border p-3"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <strong className="break-all font-mono">
                    {group.groupKey}
                  </strong>
                  <span className="text-muted-foreground">
                    {group.targets.length}개 대상
                  </span>
                </div>
                <div className="space-y-1">
                  {group.targets.map((target) => (
                    <div
                      key={target.id}
                      className="grid grid-cols-[110px_1fr] gap-2 border-b border-border/60 py-1.5 last:border-0"
                    >
                      <span>{target.targetType}</span>
                      <div className="min-w-0">
                        <span className="break-all font-mono">
                          {target.pgNo ||
                            target.externalShipmentId ||
                            target.targetExternalId ||
                            "-"}
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge variant={
                            target.externalResultStatus === "SUCCEEDED"
                              ? "success"
                              : target.externalResultStatus === "NOT_APPLIED"
                                ? "neutral"
                                : target.externalResultStatus === "UNKNOWN"
                                  ? "danger"
                                  : "secondary"
                          }>
                            채널 {TARGET_EXTERNAL_STATUS_LABELS[target.externalResultStatus] ?? target.externalResultStatus}
                          </Badge>
                          <Badge variant={
                            target.localFinalizationStatus === "SUCCEEDED"
                              ? "success"
                              : target.localFinalizationStatus === "FAILED"
                                ? "danger"
                                : "secondary"
                          }>
                            내부 {TARGET_LOCAL_STATUS_LABELS[target.localFinalizationStatus] ?? target.localFinalizationStatus}
                          </Badge>
                          {target.retryRequired !== null ? (
                            <Badge variant="secondary">
                              채널 재시도 {target.retryRequired ? "권장" : "불필요"}
                            </Badge>
                          ) : null}
                        </div>
                        {target.externalResultCode || target.externalResultMessage ? (
                          <p className="mt-1 break-words text-muted-foreground">
                            {[target.externalResultCode, target.externalResultMessage]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        ) : null}
                        {target.inventoryVerificationStateId !== null ? (
                          <div className="mt-1 space-y-0.5 text-muted-foreground">
                            <p>
                              점검 #{target.inventoryVerificationStateId} · 기준 버전 {" "}
                              {target.inventoryDesiredVersionSnapshot ?? "-"}
                            </p>
                            <p>
                              원장 {target.inventoryLedgerQuantitySnapshot ?? "-"} ·
                              미반영 {" "}
                              {target.inventoryPendingOrderQuantitySnapshot ?? "-"} ·
                              기대 {" "}
                              {target.inventoryExpectedChannelQuantitySnapshot ?? "-"} ·
                              당시 실제 {" "}
                              {target.inventoryObservedChannelQuantitySnapshot ?? "-"}
                            </p>
                            <p>
                              불일치 시작 {" "}
                              {formatSalesChannelSyncCheckDate(
                                target.inventoryMismatchSinceSnapshot
                              )}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                {item.requestStatus === "REVIEW_REQUIRED" && groupUnknown ? (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Button
                      size="sm"
                      disabled={actionDisabled}
                      onClick={() =>
                        void onDecision(
                          "CHANNEL_APPLIED",
                          group.representativeTargetId
                        )
                      }
                    >
                      <CheckCircle2 className="size-4" />
                      이 그룹 반영
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionDisabled}
                      onClick={() =>
                        void onDecision(
                          "CHANNEL_NOT_APPLIED",
                          group.representativeTargetId
                        )
                      }
                    >
                      <XCircle className="size-4" />
                      이 그룹 미반영
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={actionDisabled}
                      onClick={() =>
                        void onDecision(
                          "UNDECIDABLE",
                          group.representativeTargetId
                        )
                      }
                    >
                      판단 보류
                    </Button>
                  </div>
                ) : null}
              </section>
            );
          })}
          {item.targets.length === 0 ? (
            <p className="text-muted-foreground">저장된 대상이 없습니다.</p>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border p-4">
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
          실행 시도
        </h4>
        <div className="space-y-2">
          {item.attempts.map((attempt) => (
            <div
              key={attempt.id}
              className="border-l-2 border-border pl-3 text-xs"
            >
              <div className="flex items-center gap-2">
                <strong>
                  #{attempt.attemptNo} {attempt.attemptType}
                </strong>
                <Badge
                  variant={
                    attempt.attemptStatus === "SUCCEEDED"
                      ? "success"
                      : attempt.attemptStatus === "SENDING"
                        ? "secondary"
                        : "danger"
                  }
                >
                  {attempt.attemptStatus}
                </Badge>
              </div>
              <p className="mt-1 text-muted-foreground">
                {formatSalesChannelSyncCheckDate(attempt.startedAt)} ·{" "}
                {attempt.triggerType}
              </p>
              {attempt.errorMessage ? (
                <p className="mt-1 break-words">
                  {attempt.errorMessage}
                </p>
              ) : null}
            </div>
          ))}
          {item.attempts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              저장된 실행 시도가 없습니다.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SalesChannelWriteReviewView({
  initialRequestId,
  initialSearch = "",
  onOpenSourceMenu,
  onUnresolvedCountChange,
  requestTypes,
  title = "판매 채널 쓰기 결과 확인",
  description = "쓰기 응답과 실제 판매 채널 상태가 불확실한 건을 업무 원본과 대조합니다.",
  searchPlaceholder = "주문번호, 접수번호, PG, 오류 검색",
}: {
  initialRequestId?: number | null;
  initialSearch?: string;
  onOpenSourceMenu?: (menuId: string) => void;
  onUnresolvedCountChange?: (count: number) => void;
  requestTypes?: string[];
  title?: string;
  description?: string;
  searchPlaceholder?: string;
}) {
  const [items, setItems] = React.useState<SalesChannelWriteReviewItemDto[]>([]);
  const [controls, setControls] = React.useState<SalesChannelWriteControlDto[]>([]);
  const [unresolvedCount, setUnresolvedCount] = React.useState(0);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState("UNRESOLVED");
  const [search, setSearch] = React.useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = React.useState(
    initialSearch.trim()
  );
  const [loading, setLoading] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [noteDraft, setNoteDraft] = React.useState<{
    requestId: number | null;
    baseline: string;
    value: string;
  }>({
    requestId: null,
    baseline: "",
    value: "",
  });
  const { runGuardedAction } = useUnsavedChanges();
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedRequiresReview =
    selected?.requestStatus === "REVIEW_REQUIRED" ||
    selected?.requestStatus === "LOCAL_PENDING";
  const note =
    selected && noteDraft.requestId === selected.id
      ? noteDraft.value
      : selected?.manualVerificationNote ?? "";
  const noteBaseline =
    selected && noteDraft.requestId === selected.id
      ? noteDraft.baseline
      : selected?.manualVerificationNote ?? "";
  const selectedReviewFormId = salesChannelWriteReviewFormId(selected?.id);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({ status, limit: "300" });
      if (requestTypes?.length) {
        params.set("requestType", requestTypes.join(","));
      }
      if (appliedSearch) {
        params.set("search", appliedSearch);
      }
      const response = await fetch(
        `/api/admin/sales-channel-write-requests?${params.toString()}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as ApiResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "판매 채널 쓰기 이력을 불러오지 못했습니다.");
      }

      const nextItems = payload.items ?? [];
      setItems(nextItems);
      setControls(payload.controls ?? []);
      const nextUnresolvedCount = payload.unresolvedCount ?? 0;
      setUnresolvedCount(nextUnresolvedCount);
      onUnresolvedCountChange?.(nextUnresolvedCount);
      setSelectedId((current) =>
        initialRequestId && nextItems.some((item) => item.id === initialRequestId)
          ? initialRequestId
          : current && nextItems.some((item) => item.id === current)
          ? current
          : nextItems[0]?.id ?? null
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [
    initialRequestId,
    onUnresolvedCountChange,
    requestTypes,
    appliedSearch,
    status,
  ]);

  useUnsavedForm({
    id: selectedReviewFormId,
    label: selected
      ? `판매 채널 쓰기 요청 #${selected.id} 판단 근거`
      : "판매 채널 쓰기 판단 근거",
    enabled: Boolean(selected && selectedRequiresReview),
    isDirty: !invoiceActionNoteSnapshotsEqual(
      createInvoiceActionNoteSnapshot(noteBaseline),
      createInvoiceActionNoteSnapshot(note)
    ),
    isBusy: working,
    discard: () => {
      if (!selected) return;
      setNoteDraft({
        requestId: selected.id,
        baseline: noteBaseline,
        value: noteBaseline,
      });
      setError("");
    },
  });

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);

    return () => window.clearTimeout(timer);
  }, [load]);

  async function runAction(
    body: Record<string, unknown>,
    onAccepted?: () => void
  ) {
    setWorking(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/sales-channel-write-requests", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ApiResponse & {
        confirmed?: boolean;
      };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "처리에 실패했습니다.");
      }

      const resultMessage = payload.message || "처리 결과를 저장했습니다.";
      setMessage(
        mutationWakeDeferred(payload.receipt)
          ? `${resultMessage} 백그라운드 작업은 다음 실행 주기에 계속됩니다.`
          : resultMessage
      );
      onAccepted?.();
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function decide(decision: string, representativeTargetId: number) {
    if (!selected) {
      return;
    }

    if (!note.trim()) {
      setError("채널에서 확인한 결과와 판단 근거를 입력하세요.");
      return;
    }

    const submittedNote = note.trim();
    await runAction(
      {
        action: "decision",
        requestId: selected.id,
        targetId: representativeTargetId,
        decision,
        note: submittedNote,
      },
      () =>
        setNoteDraft({
          requestId: selected.id,
          baseline: submittedNote,
          value: submittedNote,
        })
    );
  }

  function requestSelectItem(item: SalesChannelWriteReviewItemDto) {
    if (item.id === selectedId) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: selected ? [selectedReviewFormId] : [],
      targetLabel: "다른 판매 채널 쓰기 요청",
      action: () => setSelectedId(item.id),
    });
  }

  function requestStatusChange(nextStatus: string) {
    if (nextStatus === status) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: selected ? [selectedReviewFormId] : [],
      targetLabel: "판매 채널 쓰기 상태 필터 변경",
      action: () => setStatus(nextStatus),
    });
  }

  function requestLoad() {
    runGuardedAction({
      intent: "internal-change",
      formIds: selected ? [selectedReviewFormId] : [],
      targetLabel: "판매 채널 쓰기 목록 조회",
      action: () => {
        const nextSearch = search.trim();
        if (nextSearch === appliedSearch) {
          void load();
        } else {
          setAppliedSearch(nextSearch);
        }
      },
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <div className="mr-auto min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            <Badge variant={unresolvedCount > 0 ? "danger" : "secondary"}>
              확인 필요 {unresolvedCount.toLocaleString("ko-KR")}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="외부 API 처리 이력 검색"
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                requestLoad();
              }
            }}
          />
        </div>
        <select
          aria-label="처리 상태 필터"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={status}
          onChange={(event) => requestStatusChange(event.target.value)}
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          onClick={requestLoad}
          disabled={loading}
        >
          <RefreshCcw className={cn("size-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <SalesChannelWriteControlAlerts
        controls={controls}
        working={working}
        onResume={(control) =>
          runAction({
            action: "resumeControl",
            controlId: control.id,
            expectedControlRevision: control.revision,
          })
        }
      />

      {error || message ? (
        <div
          className={cn(
            "border px-3 py-2 text-sm",
            error
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-emerald-300 bg-emerald-50 text-emerald-900"
          )}
        >
          {error || message}
        </div>
      ) : null}

      <MasterDetailLayout className="gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-h-[280px] overflow-auto border border-border bg-background">
          <table className="w-full min-w-[980px] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-36 px-3 py-2 font-medium">상태</th>
                <th className="w-40 px-3 py-2 font-medium">처리 종류</th>
                <th className="w-40 px-3 py-2 font-medium">주문번호</th>
                <th className="w-40 px-3 py-2 font-medium">채널 대상</th>
                <th className="w-28 px-3 py-2 font-medium">요청 상태</th>
                <th className="px-3 py-2 font-medium">오류</th>
                <th className="w-36 px-3 py-2 font-medium">요청 일시</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={cn(
                    "cursor-pointer border-t border-border hover:bg-muted/50",
                    selectedId === item.id && "bg-primary/5"
                  )}
                  onClick={() => requestSelectItem(item)}
                >
                  <td className="px-3 py-2">
                    <Badge variant={salesChannelWriteStatusVariant(item.requestStatus)}>
                      {SALES_CHANNEL_WRITE_STATUS_LABELS[item.requestStatus] ?? item.requestStatus}
                    </Badge>
                  </td>
                  <td className="truncate px-3 py-2" title={item.requestType}>
                    {SALES_CHANNEL_WRITE_REQUEST_LABELS[item.requestType] ?? item.requestType}
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-xs">{item.externalOrderId || "-"}</td>
                  <td className="truncate px-3 py-2 font-mono text-xs">{item.targetExternalId || "-"}</td>
                  <td className="px-3 py-2">{item.expectedBeforeStatus || "-"} → {item.requestedAfterStatus || "-"}</td>
                  <td className="truncate px-3 py-2 text-red-700" title={item.errorMessage}>{item.errorMessage || "-"}</td>
                  <td className="px-3 py-2 text-xs">
                    {formatSalesChannelSyncCheckDate(item.requestedAt)}
                  </td>
                </tr>
              ))}
              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="h-40 px-3 text-center text-muted-foreground">
                    조회된 판매 채널 쓰기 이력이 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <aside className="min-h-0 overflow-auto border border-border bg-background">
          {selected ? (
            <SalesChannelWriteReviewDetail
              item={selected}
              working={working}
              note={note}
              onNoteChange={(value) =>
                setNoteDraft((current) => ({
                  requestId: selected.id,
                  baseline:
                    current.requestId === selected.id
                      ? current.baseline
                      : selected.manualVerificationNote ?? "",
                  value,
                }))
              }
              onRecheck={() =>
                runAction({ action: "recheck", requestId: selected.id })
              }
              onRetryLocal={() =>
                runAction({ action: "retryLocal", requestId: selected.id })
              }
              onDecision={decide}
              onOpenSourceMenu={onOpenSourceMenu}
            />
          ) : (
            <div className="flex h-full min-h-60 items-center justify-center p-6 text-sm text-muted-foreground">
              왼쪽 표에서 확인할 요청을 선택하세요.
            </div>
          )}
        </aside>
      </MasterDetailLayout>
    </div>
  );
}
