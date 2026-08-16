"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  LoaderCircle,
  Printer,
  RefreshCcw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import {
  useGuardedDialogClose,
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { cn } from "@/quickhack_shared/core/utils";
import {
  createInvoiceActionNoteSnapshot,
  invoiceActionNoteSnapshotsEqual,
  invoiceReplacementCancelFormId,
  invoiceReplacementConfirmFormId,
} from "./invoice-operation-draft-state";
import type { InvoiceReplacement } from "./invoice-operation-types";

const steps = [
  { code: "PRECHECK", label: "최신 주문 확인" },
  { code: "HOLD", label: "출고 보류" },
  { code: "OLD_INVOICE_HANDLING", label: "기존 송장 처리" },
  { code: "ALLOCATION", label: "새 번호 채번" },
  { code: "CHANNEL_UPDATE", label: "쿠팡 반영" },
  { code: "CARRIER_REGISTRATION", label: "로젠 등록" },
  { code: "LABEL_PRINT", label: "새 송장 출력 확인" },
  { code: "FINALIZE", label: "출고 보류 해제" },
] as const;

function formatDate(value: string | null | undefined) {
  return value ? value.replace("T", " ").slice(0, 19) : "-";
}

function statusVariant(status: string) {
  if (status === "COMPLETED") return "success" as const;
  if (status === "FAILED" || status === "REVIEW_REQUIRED")
    return "danger" as const;
  if (status === "WAITING_MANUAL" || status === "WAITING_LABEL")
    return "warning" as const;
  return "secondary" as const;
}

export function InvoiceReplacementProgress({
  replacement,
  busy = false,
  compact = false,
  onRefresh,
  onAction,
  onOpenChannelRecovery,
  onOpenShipmentOutput,
  onRecoverCarrierRegistration,
}: {
  replacement: InvoiceReplacement;
  busy?: boolean;
  compact?: boolean;
  onRefresh?: () => void;
  onAction?: (action: string, note?: string) => Promise<boolean>;
  onOpenChannelRecovery?: () => void;
  onOpenShipmentOutput?: () => void;
  onRecoverCarrierRegistration?: () => void;
}) {
  const [note, setNote] = React.useState("");
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelNote, setCancelNote] = React.useState("");
  const { runGuardedAction } = useUnsavedChanges();
  const confirmFormId = invoiceReplacementConfirmFormId(
    replacement.replacementWorkId
  );
  const cancelFormId = invoiceReplacementCancelFormId(
    replacement.replacementWorkId
  );
  const confirmBaseline = React.useMemo(
    () => createInvoiceActionNoteSnapshot(""),
    []
  );
  const cancelBaseline = React.useMemo(
    () => createInvoiceActionNoteSnapshot(""),
    []
  );
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.code === replacement.stage)
  );
  const terminal = ["COMPLETED", "CANCELED", "FAILED"].includes(
    replacement.status
  );
  const waitingManual =
    replacement.nextAction.code === "CONFIRM_OLD_INVOICE_HANDLING";
  const reviewRequired =
    replacement.nextAction.code === "REVIEW_FAILURE";
  const executionRunning = replacement.executionState === "RUNNING";
  const executionStale = replacement.executionState === "STALE";
  const channelRecovery =
    reviewRequired && replacement.stage === "CHANNEL_UPDATE";
  const carrierRecovery =
    reviewRequired && replacement.stage === "CARRIER_REGISTRATION";
  const shipmentOutputRecovery =
    replacement.status === "WAITING_LABEL" ||
    (reviewRequired && replacement.stage === "LABEL_PRINT");
  const canCancel =
    Boolean(onAction) &&
    !replacement.channelUpdatedAt &&
    ["PRECHECK", "OLD_INVOICE_HANDLING", "ALLOCATION"].includes(
      replacement.stage
    ) &&
    replacement.executionState === "IDLE" &&
    !terminal;

  const closeCancelDraft = React.useCallback(() => {
    setCancelOpen(false);
    setCancelNote("");
  }, []);
  const cancelFormIds = React.useMemo(() => [cancelFormId], [cancelFormId]);
  const requestCancelDraftClose = useGuardedDialogClose({
    formIds: cancelFormIds,
    targetLabel: "송장 재발급 취소 입력",
    onClose: closeCancelDraft,
  });

  useUnsavedForm({
    id: confirmFormId,
    label: `송장 재발급 #${replacement.replacementWorkId} 기존 송장 처리 근거`,
    enabled: waitingManual && Boolean(onAction),
    isDirty: !invoiceActionNoteSnapshotsEqual(
      confirmBaseline,
      createInvoiceActionNoteSnapshot(note)
    ),
    isBusy: busy,
    discard: () => setNote(""),
  });

  useUnsavedForm({
    id: cancelFormId,
    label: `송장 재발급 #${replacement.replacementWorkId} 취소 사유`,
    enabled: cancelOpen && canCancel,
    isDirty: !invoiceActionNoteSnapshotsEqual(
      cancelBaseline,
      createInvoiceActionNoteSnapshot(cancelNote)
    ),
    isBusy: busy,
    discard: closeCancelDraft,
  });

  async function submitOldInvoiceHandling() {
    if (!onAction) return;
    const accepted = await onAction(
      "confirmOldInvoiceHandling",
      note.trim()
    );
    if (accepted) {
      setNote("");
    }
  }

  async function submitCancellation() {
    if (!onAction) return;
    const accepted = await onAction("cancel", cancelNote.trim());
    if (accepted) {
      closeCancelDraft();
    }
  }

  function requestOldInvoiceHandling() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [cancelFormId],
      targetLabel: "기존 송장 처리 확인",
      action: () => void submitOldInvoiceHandling(),
    });
  }

  function requestCancellation() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId],
      targetLabel: "송장 재발급 취소",
      action: () => void submitCancellation(),
    });
  }

  function requestReplacementRefresh() {
    if (!onRefresh) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId, cancelFormId],
      targetLabel: "송장 재발급 상태 다시 확인",
      action: onRefresh,
    });
  }

  function requestResume() {
    if (!onAction) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId, cancelFormId],
      targetLabel: "송장 재발급 현재 단계 다시 확인",
      action: () => void onAction("resume"),
    });
  }

  function requestCarrierRegistrationRecovery() {
    if (!onRecoverCarrierRegistration) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId, cancelFormId],
      targetLabel: "로젠 등록 복구 실행",
      action: onRecoverCarrierRegistration,
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">
                송장 재발급 #{replacement.replacementWorkId}
              </h3>
              <Badge variant={statusVariant(replacement.status)}>
                {replacement.statusLabel}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              기존 {replacement.oldTrackingNumber} → 새 송장{" "}
              {replacement.candidateTrackingNumber ?? "채번 전"} · 합포장{" "}
              {replacement.memberCount}건
            </p>
          </div>
          {onRefresh ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={requestReplacementRefresh}
            >
              <RefreshCcw
                className={cn("size-3.5", busy && "animate-spin")}
              />
              상태 확인
            </Button>
          ) : null}
        </div>

        <div
          className={cn(
            "mt-4 grid gap-2",
            compact
              ? "grid-cols-2"
              : "grid-cols-2 md:grid-cols-4 xl:grid-cols-8"
          )}
        >
          {steps.map((step, index) => {
            const done =
              replacement.status === "COMPLETED" || index < currentIndex;
            const current = index === currentIndex && !terminal;
            const failed =
              current &&
              ["REVIEW_REQUIRED", "FAILED"].includes(replacement.status);
            return (
              <div
                key={step.code}
                className={cn(
                  "relative rounded-md border px-2 py-2 text-[11px]",
                  done && "border-emerald-200 bg-emerald-50 text-emerald-800",
                  current &&
                    !failed &&
                    "border-primary/40 bg-primary/5 text-primary",
                  failed && "border-red-200 bg-red-50 text-red-800",
                  !done && !current && "text-muted-foreground"
                )}
              >
                <div className="mb-1 flex items-center gap-1">
                  {done ? (
                    <Check className="size-3.5" />
                  ) : failed ? (
                    <AlertTriangle className="size-3.5" />
                  ) : current ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Circle className="size-3" />
                  )}
                  <span className="font-semibold">{index + 1}</span>
                </div>
                <div className="leading-4">{step.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className={cn(
          "rounded-lg border px-4 py-3",
          reviewRequired
            ? "border-red-200 bg-red-50"
            : waitingManual ||
                replacement.status === "WAITING_LABEL"
              ? "border-amber-200 bg-amber-50"
              : replacement.status === "COMPLETED"
                ? "border-emerald-200 bg-emerald-50"
                : "bg-muted/30"
        )}
      >
        <div className="text-sm font-semibold">
          지금 할 일: {replacement.nextAction.label}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {replacement.nextAction.description}
        </p>
        {replacement.errorMessage ? (
          <div className="mt-2 rounded border border-red-200 bg-white/70 px-3 py-2 text-xs text-red-700">
            {replacement.errorCode ? `${replacement.errorCode}: ` : ""}
            {replacement.errorMessage}
          </div>
        ) : null}

        {waitingManual && onAction ? (
          <div className="mt-3 space-y-2">
            <textarea
              className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="기존 로젠 송장을 미사용 처리하고 기존 송장 출력물을 폐기한 근거를 입력하세요."
            />
            <Button
              disabled={busy || !note.trim()}
              onClick={requestOldInvoiceHandling}
            >
              기존 송장 처리 확인 후 계속
            </Button>
          </div>
        ) : null}

        {(reviewRequired || executionStale) && onAction ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {channelRecovery && onOpenChannelRecovery ? (
              <Button
                disabled={busy}
                onClick={onOpenChannelRecovery}
              >
                <ExternalLink className="size-4" />
                쿠팡 처리 복구 열기
              </Button>
            ) : null}
            {carrierRecovery && onRecoverCarrierRegistration ? (
              <Button
                disabled={busy}
                onClick={requestCarrierRegistrationRecovery}
              >
                <RotateCcw className="size-4" />
                로젠 등록 복구 실행
              </Button>
            ) : null}
            {shipmentOutputRecovery && onOpenShipmentOutput ? (
              <Button disabled={busy} onClick={onOpenShipmentOutput}>
                <Printer className="size-4" />
                송장 출력 화면 열기
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={busy || executionRunning}
              onClick={requestResume}
            >
              <RefreshCcw className="size-4" />
              {executionStale ? "중단된 처리 재개" : "현재 단계 다시 확인"}
            </Button>
          </div>
        ) : null}

        {replacement.status === "WAITING_LABEL" && onOpenShipmentOutput ? (
          <Button
            className="mt-3"
            disabled={busy}
            onClick={onOpenShipmentOutput}
          >
            <Printer className="size-4" />
            송장 출력 화면 열기
          </Button>
        ) : null}

        {shipmentOutputRecovery && !onOpenShipmentOutput ? (
          <div className="mt-3 rounded border border-amber-300 bg-white/70 px-3 py-2 text-xs text-amber-900">
            연결된 송장 출력 차수를 찾지 못했습니다. 상태를 다시 확인한 뒤에도
            계속되면 송장 발급 이력에서 대상 차수를 확인하세요.
          </div>
        ) : null}

        {canCancel ? (
          <div className="mt-3 border-t border-current/10 pt-3">
            {!cancelOpen ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCancelOpen(true)}
              >
                <XCircle className="size-4" />
                재발급 취소
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  쿠팡에 새 송장번호를 보내기 전 단계입니다. 취소하면 기존 송장을
                  유지하고 출고 보류를 해제합니다.
                </p>
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  value={cancelNote}
                  onChange={(event) => setCancelNote(event.target.value)}
                  placeholder="재발급을 취소하는 이유를 입력하세요."
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    disabled={busy || !cancelNote.trim()}
                    onClick={requestCancellation}
                  >
                    재발급 취소 확정
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={requestCancelDraftClose}
                  >
                    계속 진행
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {!compact ? (
        <div className="grid gap-3 text-xs md:grid-cols-2">
          <div className="rounded-md border p-3">
            <div className="mb-2 font-semibold">배송지 변경</div>
            <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1">
              <span className="text-muted-foreground">변경 전</span>
              <span className="break-words">
                {[
                  replacement.beforeReceiver.postCode,
                  replacement.beforeReceiver.address1,
                  replacement.beforeReceiver.address2,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </span>
              <span className="text-muted-foreground">변경 후</span>
              <span className="break-words">
                {[
                  replacement.afterReceiver.postCode,
                  replacement.afterReceiver.address1,
                  replacement.afterReceiver.address2,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </span>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-2 font-semibold">처리 시각</div>
            <div className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1">
              <span className="text-muted-foreground">요청</span>
              <span>{formatDate(replacement.requestedAt)}</span>
              <span className="text-muted-foreground">쿠팡 반영</span>
              <span>{formatDate(replacement.channelUpdatedAt)}</span>
              <span className="text-muted-foreground">로젠 등록</span>
              <span>{formatDate(replacement.carrierRegisteredAt)}</span>
              <span className="text-muted-foreground">출력 확인</span>
              <span>{formatDate(replacement.labelConfirmedAt)}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
