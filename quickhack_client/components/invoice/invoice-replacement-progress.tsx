"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
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
import { useInvoiceReplacementPresentation } from "./invoice-replacement-presentation";

const steps = [
  { code: "PRECHECK", labelKey: "steps.precheck" },
  { code: "HOLD", labelKey: "steps.hold" },
  { code: "OLD_INVOICE_HANDLING", labelKey: "steps.oldInvoice" },
  { code: "ALLOCATION", labelKey: "steps.allocation" },
  { code: "CHANNEL_UPDATE", labelKey: "steps.channel" },
  { code: "CARRIER_REGISTRATION", labelKey: "steps.carrier" },
  { code: "LABEL_PRINT", labelKey: "steps.label" },
  { code: "FINALIZE", labelKey: "steps.finalize" },
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
  const t = useTranslations("shipment.invoiceReplacement");
  const replacementPresentation = useInvoiceReplacementPresentation();
  const nextActionPresentation = replacementPresentation.action(replacement.nextAction.code);
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
  }, [setCancelNote, setCancelOpen]);
  const cancelFormIds = React.useMemo(() => [cancelFormId], [cancelFormId]);
  const requestCancelDraftClose = useGuardedDialogClose({
    formIds: cancelFormIds,
    targetLabel: t("forms.cancelInput"),
    onClose: closeCancelDraft,
  });

  useUnsavedForm({
    id: confirmFormId,
    label: t("forms.evidence", { id: String(replacement.replacementWorkId) }),
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
    label: t("forms.cancelReason", { id: String(replacement.replacementWorkId) }),
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
      targetLabel: t("guarded.confirmOld"),
      action: () => void submitOldInvoiceHandling(),
    });
  }

  function requestCancellation() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId],
      targetLabel: t("guarded.cancel"),
      action: () => void submitCancellation(),
    });
  }

  function requestReplacementRefresh() {
    if (!onRefresh) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId, cancelFormId],
      targetLabel: t("guarded.refresh"),
      action: onRefresh,
    });
  }

  function requestResume() {
    if (!onAction) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId, cancelFormId],
      targetLabel: t("guarded.resume"),
      action: () => void onAction("resume"),
    });
  }

  function requestCarrierRegistrationRecovery() {
    if (!onRecoverCarrierRegistration) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [confirmFormId, cancelFormId],
      targetLabel: t("guarded.recoverCarrier"),
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
                {t("header.title", { id: String(replacement.replacementWorkId) })}
              </h3>
              <Badge variant={statusVariant(replacement.status)}>
                {replacementPresentation.status(replacement.status)}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("header.summary", {
                old: replacement.oldTrackingNumber,
                candidate: replacement.candidateTrackingNumber ?? t("header.unallocated"),
                count: replacement.memberCount,
              })}
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
              {t("header.refresh")}
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
                <div className="leading-4">{t(step.labelKey)}</div>
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
          {t("action.now", { action: nextActionPresentation.label })}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {nextActionPresentation.description}
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
              placeholder={t("action.evidencePlaceholder")}
            />
            <Button
              disabled={busy || !note.trim()}
              onClick={requestOldInvoiceHandling}
            >
              {t("action.confirmOld")}
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
                {t("action.openChannelRecovery")}
              </Button>
            ) : null}
            {carrierRecovery && onRecoverCarrierRegistration ? (
              <Button
                disabled={busy}
                onClick={requestCarrierRegistrationRecovery}
              >
                <RotateCcw className="size-4" />
                {t("action.recoverCarrier")}
              </Button>
            ) : null}
            {shipmentOutputRecovery && onOpenShipmentOutput ? (
              <Button disabled={busy} onClick={onOpenShipmentOutput}>
                <Printer className="size-4" />
                {t("action.openOutput")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={busy || executionRunning}
              onClick={requestResume}
            >
              <RefreshCcw className="size-4" />
              {executionStale ? t("action.resumeInterrupted") : t("action.recheck")}
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
            {t("action.openOutput")}
          </Button>
        ) : null}

        {shipmentOutputRecovery && !onOpenShipmentOutput ? (
          <div className="mt-3 rounded border border-amber-300 bg-white/70 px-3 py-2 text-xs text-amber-900">
            {t("action.outputMissing")}
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
                {t("cancel.open")}
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("cancel.description")}
                </p>
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  value={cancelNote}
                  onChange={(event) => setCancelNote(event.target.value)}
                  placeholder={t("cancel.placeholder")}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    disabled={busy || !cancelNote.trim()}
                    onClick={requestCancellation}
                  >
                    {t("cancel.confirm")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={requestCancelDraftClose}
                  >
                    {t("cancel.continue")}
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
            <div className="mb-2 font-semibold">{t("detail.address")}</div>
            <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1">
              <span className="text-muted-foreground">{t("detail.before")}</span>
              <span className="break-words">
                {[
                  replacement.beforeReceiver.postCode,
                  replacement.beforeReceiver.address1,
                  replacement.beforeReceiver.address2,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </span>
              <span className="text-muted-foreground">{t("detail.after")}</span>
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
            <div className="mb-2 font-semibold">{t("detail.timestamps")}</div>
            <div className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1">
              <span className="text-muted-foreground">{t("detail.requested")}</span>
              <span>{formatDate(replacement.requestedAt)}</span>
              <span className="text-muted-foreground">{t("detail.channel")}</span>
              <span>{formatDate(replacement.channelUpdatedAt)}</span>
              <span className="text-muted-foreground">{t("detail.carrier")}</span>
              <span>{formatDate(replacement.carrierRegisteredAt)}</span>
              <span className="text-muted-foreground">{t("detail.label")}</span>
              <span>{formatDate(replacement.labelConfirmedAt)}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
