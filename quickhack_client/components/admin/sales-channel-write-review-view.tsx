"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("admin.writeReview");
  const pausedControls = controls.filter((control) => control.isPaused);

  if (pausedControls.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
      <PauseCircle className="size-4 shrink-0" />
      <strong>{t("control.paused")}</strong>
      {pausedControls.map((control) => (
        <div key={control.id} className="flex items-center gap-2">
          <span>{t("control.failures", {
            channel: control.channel,
            type: control.requestType,
            count: control.consecutiveFailureCount,
          })}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => void onResume(control)}
          >
            {t("control.resume")}
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
  const t = useTranslations("admin.writeReview");
  const requestTypeLabels: Record<string, string> = {
    ORDER_STATUS_INSTRUCT: t("requestType.orderStatusInstruct"),
    COUPANG_INVOICE_UPLOAD: t("requestType.invoiceUpload"),
    COUPANG_INVOICE_UPDATE: t("requestType.invoiceUpdate"),
    RETURN_STOPPED_SHIPMENT: t("requestType.stoppedShipment"),
    RETURN_RECEIVE_CONFIRMATION: t("requestType.returnReceive"),
    RETURN_APPROVAL: t("requestType.returnApproval"),
    COUPANG_INVENTORY_QUANTITY_UPDATE: t("requestType.inventoryUpdate"),
  };
  const targetExternalStatusLabels: Record<string, string> = {
    PENDING: t("targetStatus.pending"),
    SUCCEEDED: t("targetStatus.externalSucceeded"),
    NOT_APPLIED: t("targetStatus.notApplied"),
    UNKNOWN: t("targetStatus.unknown"),
  };
  const targetLocalStatusLabels: Record<string, string> = {
    PENDING: t("targetStatus.pending"),
    SUCCEEDED: t("targetStatus.localSucceeded"),
    NOT_REQUIRED: t("targetStatus.notRequired"),
    FAILED: t("targetStatus.failed"),
  };
  const attemptTypeLabels: Record<string, string> = {
    WRITE: t("attempt.type.write"),
    VERIFY_READ: t("attempt.type.verifyRead"),
    LOCAL_FINALIZE: t("attempt.type.localFinalize"),
  };
  const attemptStatusLabels: Record<string, string> = {
    SENDING: t("attempt.status.sending"),
    SUCCEEDED: t("attempt.status.succeeded"),
    FAILED: t("attempt.status.failed"),
    AMBIGUOUS: t("attempt.status.ambiguous"),
  };
  const attemptTriggerLabels: Record<string, string> = {
    USER: t("attempt.trigger.user"),
    WORKER: t("attempt.trigger.worker"),
    RECOVERY: t("attempt.trigger.recovery"),
    SYSTEM: t("attempt.trigger.system"),
  };
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
        <h3 className="text-sm font-semibold">{t("detail.title", { id: item.id })}</h3>
        {item.sourceMenuKey && onOpenSourceMenu ? (
          <Button
            className="ml-auto"
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => onOpenSourceMenu(item.sourceMenuKey)}
          >
            <ExternalLink className="size-4" />
            {t("detail.source")}
          </Button>
        ) : null}
      </div>
      <DescriptionList className="px-4 py-2">
        <DetailLine
          label={t("detail.channelAction")}
          value={`${item.channel} · ${requestTypeLabels[item.requestType] ?? item.requestType}`}
        />
        <DetailLine label={t("detail.orderNumber")} value={item.externalOrderId || "-"} />
        <DetailLine label={t("detail.target")} value={item.targetExternalId || "-"} />
        <DetailLine
          label={t("detail.transition")}
          value={`${item.expectedBeforeStatus || "-"} → ${item.requestedAfterStatus || "-"}`}
        />
        <DetailLine label={t("detail.failureStage")} value={item.failureStage || "-"} />
        <DetailLine
          label={t("detail.error")}
          value={
            <span className="break-words">
              {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") ||
                "-"}
            </span>
          }
        />
        <DetailLine
          label={t("detail.requester")}
          value={item.requestedBy || t("detail.system")}
        />
        <DetailLine
          label={t("detail.reviewTime")}
          value={formatSalesChannelSyncCheckDate(item.reviewRequiredAt)}
        />
      </DescriptionList>

      <div className="border-y border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>{t("detail.warning")}</p>
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
            ? t("detail.localProgress")
            : t("detail.channelProgress")}
        </div>
      ) : null}

      {requiresReview ? (
        <div className="space-y-3 p-4">
          <div>
            <label
              className="mb-1 block text-xs font-medium text-muted-foreground"
              htmlFor={noteId}
            >
              {t("detail.note")}
            </label>
            <textarea
              id={noteId}
              className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder={t("detail.notePlaceholder")}
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
                {t("detail.recheck")}
              </Button>
            ) : null}
            {item.requestStatus === "LOCAL_PENDING" ? (
              <Button
                variant="outline"
                disabled={actionDisabled}
                onClick={() => void onRetryLocal()}
              >
                <RotateCcw className="size-4" />
                {t("detail.retryLocal")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          {t("detail.resolved")}
        </div>
      )}

      <div className="border-t border-border p-4">
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
          {t("target.snapshot")}
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
                    {t("target.count", { count: group.targets.length })}
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
                            {t("target.channel", { status: targetExternalStatusLabels[target.externalResultStatus] ?? target.externalResultStatus })}
                          </Badge>
                          <Badge variant={
                            target.localFinalizationStatus === "SUCCEEDED"
                              ? "success"
                              : target.localFinalizationStatus === "FAILED"
                                ? "danger"
                                : "secondary"
                          }>
                            {t("target.local", { status: targetLocalStatusLabels[target.localFinalizationStatus] ?? target.localFinalizationStatus })}
                          </Badge>
                          {target.retryRequired !== null ? (
                            <Badge variant="secondary">
                              {t("target.retry", { recommendation: target.retryRequired ? t("target.recommended") : t("target.notRequired") })}
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
                              {t("target.verification", {
                                id: target.inventoryVerificationStateId,
                                version: String(
                                  target.inventoryDesiredVersionSnapshot ?? "-"
                                ),
                              })}
                            </p>
                            <p>
                              {t("target.quantities", {
                                ledger: String(target.inventoryLedgerQuantitySnapshot ?? "-"),
                                pending: String(target.inventoryPendingOrderQuantitySnapshot ?? "-"),
                                expected: String(target.inventoryExpectedChannelQuantitySnapshot ?? "-"),
                                observed: String(target.inventoryObservedChannelQuantitySnapshot ?? "-"),
                              })}
                            </p>
                            <p>
                              {t("target.mismatchSince", { date: formatSalesChannelSyncCheckDate(target.inventoryMismatchSinceSnapshot) })}
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
                      {t("target.applied")}
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
                      {t("target.notApplied")}
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
                      {t("target.undecidable")}
                    </Button>
                  </div>
                ) : null}
              </section>
            );
          })}
          {item.targets.length === 0 ? (
            <p className="text-muted-foreground">{t("target.empty")}</p>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border p-4">
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
          {t("attempt.title")}
        </h4>
        <div className="space-y-2">
          {item.attempts.map((attempt) => (
            <div
              key={attempt.id}
              className="border-l-2 border-border pl-3 text-xs"
            >
              <div className="flex items-center gap-2">
                <strong>
                  #{attempt.attemptNo}{" "}
                  {attemptTypeLabels[attempt.attemptType] ??
                    t("attempt.unknown", { code: attempt.attemptType })}
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
                  {attemptStatusLabels[attempt.attemptStatus] ??
                    t("attempt.unknown", { code: attempt.attemptStatus })}
                </Badge>
              </div>
              <p className="mt-1 text-muted-foreground">
                {formatSalesChannelSyncCheckDate(attempt.startedAt)} ·{" "}
                {attemptTriggerLabels[attempt.triggerType] ??
                  t("attempt.unknown", { code: attempt.triggerType })}
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
              {t("attempt.empty")}
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
  title,
  description,
  searchPlaceholder,
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
  const t = useTranslations("admin.writeReview");
  const resolvedTitle = title ?? t("default.title");
  const resolvedDescription = description ?? t("default.description");
  const resolvedSearchPlaceholder =
    searchPlaceholder ?? t("default.searchPlaceholder");
  const statusOptions = [
    ["UNRESOLVED", t("statusFilter.unresolved")],
    ["ALL", t("statusFilter.all")],
    ["LOCAL_PENDING", t("statusFilter.localPending")],
    ["COMPLETED", t("statusFilter.completed")],
    ["PARTIALLY_COMPLETED", t("statusFilter.partiallyCompleted")],
    ["NOT_APPLIED", t("statusFilter.notApplied")],
    ["REJECTED", t("statusFilter.rejected")],
  ] as const;
  const requestTypeLabels: Record<string, string> = {
    ORDER_STATUS_INSTRUCT: t("requestType.orderStatusInstruct"),
    COUPANG_INVOICE_UPLOAD: t("requestType.invoiceUpload"),
    COUPANG_INVOICE_UPDATE: t("requestType.invoiceUpdate"),
    RETURN_STOPPED_SHIPMENT: t("requestType.stoppedShipment"),
    RETURN_RECEIVE_CONFIRMATION: t("requestType.returnReceive"),
    RETURN_APPROVAL: t("requestType.returnApproval"),
    COUPANG_INVENTORY_QUANTITY_UPDATE: t("requestType.inventoryUpdate"),
  };
  const requestStatusLabels: Record<string, string> = {
    PENDING: t("requestStatus.pending"),
    SENDING: t("requestStatus.sending"),
    VERIFYING: t("requestStatus.verifying"),
    LOCAL_PENDING: t("requestStatus.localPending"),
    COMPLETED: t("requestStatus.completed"),
    PARTIALLY_COMPLETED: t("requestStatus.partiallyCompleted"),
    REVIEW_REQUIRED: t("requestStatus.reviewRequired"),
    NOT_APPLIED: t("requestStatus.notApplied"),
    REJECTED: t("requestStatus.rejected"),
  };
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
        throw new Error(legacyApiMessage(payload, t("message.loadFailed")));
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
    t,
  ]);

  useUnsavedForm({
    id: selectedReviewFormId,
    label: selected
      ? t("unsaved.formRequest", { id: selected.id })
      : t("unsaved.form"),
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
        throw new Error(legacyApiMessage(payload, t("message.actionFailed")));
      }

      const resultMessage = t("message.saved");
      setMessage(
        mutationWakeDeferred(payload.receipt)
          ? t("message.deferred", { result: resultMessage })
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
      setError(t("message.noteRequired"));
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
      targetLabel: t("unsaved.select"),
      action: () => setSelectedId(item.id),
    });
  }

  function requestStatusChange(nextStatus: string) {
    if (nextStatus === status) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: selected ? [selectedReviewFormId] : [],
      targetLabel: t("unsaved.status"),
      action: () => setStatus(nextStatus),
    });
  }

  function requestLoad() {
    runGuardedAction({
      intent: "internal-change",
      formIds: selected ? [selectedReviewFormId] : [],
      targetLabel: t("unsaved.load"),
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
            <h2 className="text-base font-semibold">{resolvedTitle}</h2>
            <Badge variant={unresolvedCount > 0 ? "danger" : "secondary"}>
              {t("toolbar.unresolved", { count: unresolvedCount })}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {resolvedDescription}
          </p>
        </div>
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label={t("toolbar.searchLabel")}
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={resolvedSearchPlaceholder}
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
          aria-label={t("toolbar.statusLabel")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={status}
          onChange={(event) => requestStatusChange(event.target.value)}
        >
          {statusOptions.map(([value, label]) => (
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
          {t("toolbar.refresh")}
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
                <th className="w-36 px-3 py-2 font-medium">{t("columns.status")}</th>
                <th className="w-40 px-3 py-2 font-medium">{t("columns.type")}</th>
                <th className="w-40 px-3 py-2 font-medium">{t("columns.orderNumber")}</th>
                <th className="w-40 px-3 py-2 font-medium">{t("columns.channelTarget")}</th>
                <th className="w-28 px-3 py-2 font-medium">{t("columns.requestStatus")}</th>
                <th className="px-3 py-2 font-medium">{t("columns.error")}</th>
                <th className="w-36 px-3 py-2 font-medium">{t("columns.requestedAt")}</th>
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
                      {requestStatusLabels[item.requestStatus] ?? item.requestStatus}
                    </Badge>
                  </td>
                  <td className="truncate px-3 py-2" title={item.requestType}>
                    {requestTypeLabels[item.requestType] ?? item.requestType}
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
                    {t("empty.list")}
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
              {t("empty.select")}
            </div>
          )}
        </aside>
      </MasterDetailLayout>
    </div>
  );
}
