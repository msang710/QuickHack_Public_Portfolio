"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import { RefreshCcw, Search, ShieldAlert } from "lucide-react";
import { SalesChannelInventoryVerificationDetail } from "@/quickhack_client/components/admin/sales-channel-inventory-verification-detail";
import {
  SalesChannelWriteControlAlerts,
  SalesChannelWriteReviewDetail,
} from "@/quickhack_client/components/admin/sales-channel-write-review-view";
import {
  formatSalesChannelDifference,
  formatSalesChannelInventoryOption,
  formatSalesChannelQuantity,
  formatSalesChannelSyncCheckDate,
  SALES_CHANNEL_SYNC_CHECK_KIND_OPTIONS,
  salesChannelInventoryRecheckOutcomeKey,
  salesChannelSyncCheckItemKey,
  salesChannelSyncCheckStatusKey,
  salesChannelSyncCheckStatusOptions,
  salesChannelSyncCheckStatusVariant,
} from "@/quickhack_client/components/admin/sales-channel-sync-check-presentation";
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
import { MasterDetailLayout } from "@/quickhack_client/components/ui/workspace-layout";
import { cn } from "@/quickhack_shared/core/utils";
import {
  mutationWakeDeferred,
  type MutationReceipt,
} from "@/quickhack_shared/core/mutation-receipt";
import {
  SALES_CHANNEL_SYNC_CHECK_KIND,
  type SalesChannelClaimIntegritySyncCheckItem,
  type SalesChannelInventoryRepairFailureDetails,
  type SalesChannelInventoryRepairResponseDto,
  type SalesChannelInventoryRecheckResponseDto,
  type SalesChannelInventoryVerificationSyncCheckItem,
  type SalesChannelSyncCheckItem,
  type SalesChannelSyncCheckListResponseDto,
  type SalesChannelSyncCheckQueryKind,
  type SalesChannelWriteReviewItemDto,
  type SalesChannelWriteSyncCheckItem,
} from "@/quickhack_shared/sales-channel/sync-checks";

const SYNC_CHECK_LIMIT = 300;

type ApiFailure = {
  ok?: false;
  code?: string;
  message?: string;
  details?: SalesChannelInventoryRepairFailureDetails;
};

type WriteActionResponse = {
  ok?: boolean;
  message?: string;
  receipt?: MutationReceipt<unknown>;
};

type NoteDraft = {
  requestId: number | null;
  baseline: string;
  value: string;
};

function syncCheckKindKey(item: SalesChannelSyncCheckItem) {
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) return "writeRequest";
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) {
    return "inventoryVerification";
  }
  return "claimIntegrity";
}

function inventoryRepairSuccessKey(
  status: SalesChannelInventoryVerificationSyncCheckItem["verificationStatus"]
) {
  switch (status) {
    case "MATCHED":
      return "matched";
    case "MISMATCH":
      return "mismatch";
    case "CHECK_FAILED":
      return "checkFailed";
    default:
      return "changed";
  }
}

function inventoryOptionSummary(
  item: SalesChannelInventoryVerificationSyncCheckItem,
  labels: { storage: (value: string) => string; color: (value: string) => string; any: string; random: string; unknown: string },
  locale: string
) {
  const parts = [item.offerCode, item.model].filter(Boolean);

  if (item.storageMatchMode || item.storage) {
    parts.push(
      labels.storage(formatSalesChannelInventoryOption(
        item.storageMatchMode,
        item.storage,
        { locale, unknownLabel: labels.unknown, anyLabel: labels.any, randomLabel: labels.random }
      ))
    );
  }
  if (item.colorMatchMode || item.color) {
    parts.push(
      labels.color(formatSalesChannelInventoryOption(
        item.colorMatchMode,
        item.color,
        { locale, unknownLabel: labels.unknown, anyLabel: labels.any, randomLabel: labels.random }
      ))
    );
  }

  return parts.join(" · ");
}

function WriteListCells({ item }: { item: SalesChannelWriteSyncCheckItem }) {
  const t = useTranslations("admin.writeReview");
  const requestTypeLabel = {
    ORDER_STATUS_INSTRUCT: t("requestType.orderStatusInstruct"), COUPANG_INVOICE_UPLOAD: t("requestType.invoiceUpload"), COUPANG_INVOICE_UPDATE: t("requestType.invoiceUpdate"), RETURN_STOPPED_SHIPMENT: t("requestType.stoppedShipment"), RETURN_RECEIVE_CONFIRMATION: t("requestType.returnReceive"), RETURN_APPROVAL: t("requestType.returnApproval"), COUPANG_INVENTORY_QUANTITY_UPDATE: t("requestType.inventoryUpdate"),
  }[item.requestType] ?? item.requestType;
  return (
    <>
      <td
        className="truncate px-3 py-2"
        title={requestTypeLabel}
      >
        {requestTypeLabel}
      </td>
      <td
        className="truncate px-3 py-2 font-mono text-xs"
        title={item.externalOrderId || item.targetExternalId}
      >
        {item.externalOrderId || item.targetExternalId || "-"}
      </td>
      <td className="truncate px-3 py-2">
        {item.expectedBeforeStatus || "-"} → {item.requestedAfterStatus || "-"}
      </td>
      <td
        className="truncate px-3 py-2 text-red-700"
        title={item.errorMessage}
      >
        {item.errorMessage || "-"}
      </td>
    </>
  );
}

function InventoryListCells({
  item,
}: {
  item: SalesChannelInventoryVerificationSyncCheckItem;
}) {
  const t = useTranslations("admin.syncCheck");
  const locale = useLocale();
  const formatOptions = { locale, unknownLabel: t("format.unknown"), anyLabel: t("format.any"), randomLabel: t("format.random") };
  const optionSummary = inventoryOptionSummary(item, {
    storage: (value) => t("format.storage", { value }), color: (value) => t("format.color", { value }), any: t("format.any"), random: t("format.random"), unknown: t("format.unknown"),
  }, locale);

  return (
    <>
      <td
        className="truncate px-3 py-2 font-mono text-xs"
        title={item.externalVendorItemId}
      >
        {item.externalVendorItemId || "-"}
      </td>
      <td className="truncate px-3 py-2" title={optionSummary}>
        {optionSummary || item.externalOptionName || "-"}
      </td>
      <td className="px-3 py-2">
        <span className="whitespace-nowrap">
          {formatSalesChannelQuantity(item.expectedChannelQuantity, formatOptions)} →{" "}
          {formatSalesChannelQuantity(item.channelQuantity, formatOptions)}
        </span>
        <span
          className={cn(
            "ml-2 whitespace-nowrap text-xs",
            item.difference === 0
              ? "text-emerald-700"
              : item.difference === null
                ? "text-muted-foreground"
                : "text-red-700"
          )}
        >
          {t("columns.difference", { value: formatSalesChannelDifference(item.difference, formatOptions) })}
        </span>
      </td>
      <td
        className="truncate px-3 py-2 text-red-700"
        title={item.lastErrorMessage}
      >
        {item.lastErrorMessage || "-"}
      </td>
    </>
  );
}

function ClaimIntegrityListCells({
  item,
}: {
  item: SalesChannelClaimIntegritySyncCheckItem;
}) {
  const t = useTranslations("admin.syncCheck.claim");
  const message = t(`issue.${item.messageCode}`);
  const integrityLabels: Record<string, string> = {
    VALID: t("integrityStatus.valid"),
    MISSING_IDENTITY: t("integrityStatus.missingIdentity"),
    INVALID_QUANTITY: t("integrityStatus.invalidQuantity"),
    COUNT_MISMATCH: t("integrityStatus.countMismatch"),
  };
  return (
    <>
      <td className="truncate px-3 py-2 font-mono text-xs" title={item.externalClaimId}>
        {item.claimType} · {item.externalClaimId}
      </td>
      <td className="truncate px-3 py-2 font-mono text-xs" title={item.externalOrderId}>
        {item.externalOrderId || "-"}
      </td>
      <td className="truncate px-3 py-2" title={item.integrityStatus}>
        {integrityLabels[item.integrityStatus] ??
          t("integrityStatus.unknown", { code: item.integrityStatus })}
      </td>
      <td className="truncate px-3 py-2 text-red-700" title={message}>
        {message}
      </td>
    </>
  );
}

export function SalesChannelSyncCheckView({
  initialWriteRequestId,
  onOpenSourceMenu,
  onUnresolvedCountChange,
}: {
  initialWriteRequestId?: number | null;
  onOpenSourceMenu?: (menuId: string) => void;
  onUnresolvedCountChange?: (count: number) => void;
}) {
  const t = useTranslations("admin.syncCheck");
  const writeT = useTranslations("admin.writeReview");
  const claimT = useTranslations("admin.syncCheck.claim");
  const locale = useLocale();
  const [items, setItems] = React.useState<SalesChannelSyncCheckItem[]>([]);
  const [controls, setControls] = React.useState<
    SalesChannelSyncCheckListResponseDto["controls"]
  >([]);
  const [unresolvedCount, setUnresolvedCount] = React.useState(0);
  const [unresolvedCounts, setUnresolvedCounts] = React.useState({
    writeRequest: 0,
    inventoryVerification: 0,
    claimIntegrity: 0,
  });
  const [resultCount, setResultCount] = React.useState(0);
  const [resultLimit, setResultLimit] = React.useState(SYNC_CHECK_LIMIT);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<SalesChannelSyncCheckQueryKind>(
    SALES_CHANNEL_SYNC_CHECK_KIND.all
  );
  const [status, setStatus] = React.useState("UNRESOLVED");
  const [search, setSearch] = React.useState("");
  const [appliedSearch, setAppliedSearch] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [noteDraft, setNoteDraft] = React.useState<NoteDraft>({
    requestId: null,
    baseline: "",
    value: "",
  });
  const loadAbortRef = React.useRef<AbortController | null>(null);
  const pendingInitialWriteRequestIdRef = React.useRef(
    initialWriteRequestId ?? null
  );
  const { runGuardedAction } = useUnsavedChanges();

  React.useEffect(() => {
    pendingInitialWriteRequestIdRef.current = initialWriteRequestId ?? null;
  }, [initialWriteRequestId]);

  const selected =
    items.find((item) => salesChannelSyncCheckItemKey(item) === selectedKey) ??
    null;
  const selectedWrite =
    selected?.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest
      ? selected
      : null;
  const selectedInventory =
    selected?.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification
      ? selected
      : null;
  const selectedClaimIntegrity =
    selected?.kind === SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity
      ? selected
      : null;
  const selectedWriteRequiresReview =
    selectedWrite?.requestStatus === "REVIEW_REQUIRED" ||
    selectedWrite?.requestStatus === "LOCAL_PENDING";
  const note =
    selectedWrite && noteDraft.requestId === selectedWrite.id
      ? noteDraft.value
      : selectedWrite?.manualVerificationNote ?? "";
  const noteBaseline =
    selectedWrite && noteDraft.requestId === selectedWrite.id
      ? noteDraft.baseline
      : selectedWrite?.manualVerificationNote ?? "";
  const selectedWriteFormId = salesChannelWriteReviewFormId(selectedWrite?.id);
  const screenActionFormId = "sales-channel.sync-check.action";
  const guardedFormIds = selectedWriteRequiresReview
    ? [selectedWriteFormId]
    : [screenActionFormId];
  const statusOptions = salesChannelSyncCheckStatusOptions(kind).map((option) => ({
    ...option,
    label: t(`statusFilter.${option.labelKey}`),
  }));

  useUnsavedForm({
    id: selectedWriteFormId,
    label: selectedWrite
      ? writeT("unsaved.formRequest", { id: selectedWrite.id })
      : writeT("unsaved.form"),
    enabled: Boolean(selectedWrite && selectedWriteRequiresReview),
    isDirty: !invoiceActionNoteSnapshotsEqual(
      createInvoiceActionNoteSnapshot(noteBaseline),
      createInvoiceActionNoteSnapshot(note)
    ),
    isBusy: working,
    discard: () => {
      if (!selectedWrite) return;
      setNoteDraft({
        requestId: selectedWrite.id,
        baseline: noteBaseline,
        value: noteBaseline,
      });
      setError("");
    },
  });

  useUnsavedForm({
    id: screenActionFormId,
    label: t("actionForm"),
    enabled: !selectedWriteRequiresReview,
    isDirty: false,
    isBusy: working,
    discard: () => undefined,
  });

  const load = React.useCallback(async (
    cursor: string | null = null,
    append = false
  ) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({
        kind,
        status,
        limit: String(SYNC_CHECK_LIMIT),
      });
      if (appliedSearch) params.set("search", appliedSearch);
      if (cursor) params.set("cursor", cursor);

      const response = await fetch(
        `/api/admin/sales-channel-sync-checks?${params.toString()}`,
        { cache: "no-store", signal: controller.signal }
      );
      const payload = (await response.json()) as
        | SalesChannelSyncCheckListResponseDto
        | ApiFailure;

      if (!response.ok || !payload.ok || !("items" in payload)) {
        throw new Error(legacyApiMessage(payload, t("state.loadFailed")));
      }

      const nextItems = payload.items ?? [];
      const nextUnresolvedCount = payload.unresolvedCount ?? 0;
      setItems((current) => {
        if (!append) return nextItems;
        const merged = new Map(
          current.map((item) => [salesChannelSyncCheckItemKey(item), item])
        );
        for (const item of nextItems) {
          merged.set(salesChannelSyncCheckItemKey(item), item);
        }
        return Array.from(merged.values());
      });
      setControls(payload.controls ?? []);
      setUnresolvedCount(nextUnresolvedCount);
      setUnresolvedCounts(
        payload.unresolvedCounts ?? {
          writeRequest: 0,
          inventoryVerification: 0,
          claimIntegrity: 0,
        }
      );
      setResultCount(payload.totalCount ?? payload.count ?? nextItems.length);
      setResultLimit(payload.limit ?? SYNC_CHECK_LIMIT);
      setNextCursor(payload.hasMore ? payload.nextCursor : null);
      onUnresolvedCountChange?.(nextUnresolvedCount);
      if (!append) setSelectedKey((current) => {
        const initialRequestId = pendingInitialWriteRequestIdRef.current;
        pendingInitialWriteRequestIdRef.current = null;
        const initialKey = initialRequestId
          ? `${SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest}:${initialRequestId}`
          : null;

        if (
          initialKey &&
          nextItems.some(
            (item) => salesChannelSyncCheckItemKey(item) === initialKey
          )
        ) {
          return initialKey;
        }

        if (
          current &&
          nextItems.some(
            (item) => salesChannelSyncCheckItemKey(item) === current
          )
        ) {
          return current;
        }

        return nextItems[0] ? salesChannelSyncCheckItemKey(nextItems[0]) : null;
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [appliedSearch, kind, onUnresolvedCountChange, status, t]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);

    return () => {
      window.clearTimeout(timer);
      loadAbortRef.current?.abort();
    };
  }, [load, initialWriteRequestId]);

  async function runWriteAction(
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
      const payload = (await response.json()) as WriteActionResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(legacyApiMessage(payload, t("message.writeActionFailed")));
      }

      const resultMessage = t("message.writeActionSaved");
      setMessage(
        mutationWakeDeferred(payload.receipt)
          ? t("message.backgroundDeferred", { message: resultMessage })
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

  async function decideWrite(
    decision: string,
    representativeTargetId: number
  ) {
    if (!selectedWrite) return;

    if (!note.trim()) {
      setError(t("noteRequired"));
      return;
    }

    const submittedNote = note.trim();
    await runWriteAction(
      {
        action: "decision",
        requestId: selectedWrite.id,
        targetId: representativeTargetId,
        decision,
        note: submittedNote,
      },
      () =>
        setNoteDraft({
          requestId: selectedWrite.id,
          baseline: submittedNote,
          value: submittedNote,
        })
    );
  }

  async function recheckInventory() {
    if (!selectedInventory) return;

    setWorking(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/sales-channel-sync-checks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "recheckInventory",
          verificationStateId: selectedInventory.verificationStateId,
        }),
      });
      const payload = (await response.json()) as
        | SalesChannelInventoryRecheckResponseDto
        | ApiFailure;

      if (!response.ok || !payload.ok || !("outcome" in payload)) {
        throw new Error(legacyApiMessage(payload, t("message.recheckFailed")));
      }

      setMessage(t(`recheckOutcome.${salesChannelInventoryRecheckOutcomeKey(payload.outcome)}`));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  async function repairInventory() {
    if (
      !selectedInventory ||
      selectedInventory.verificationStatus !== "MISMATCH" ||
      selectedInventory.channelQuantity === null ||
      !selectedInventory.mismatchSince
    ) {
      return;
    }

    const snapshot = selectedInventory;
    setWorking(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/sales-channel-sync-checks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "repairInventory",
          verificationStateId: snapshot.verificationStateId,
          observedDesiredVersion: snapshot.desiredVersion,
          observedMismatchSince: snapshot.mismatchSince,
          observedExpectedChannelQuantity: snapshot.expectedChannelQuantity,
          observedChannelQuantity: snapshot.channelQuantity,
        }),
      });
      const payload = (await response.json()) as
        | SalesChannelInventoryRepairResponseDto
        | ApiFailure;

      if (!response.ok || !payload.ok || !("outcome" in payload)) {
        const failure = payload as ApiFailure;
        const latestItem = failure.details?.latestItem;

        if (latestItem) {
          setItems((current) =>
            current.map((item) =>
              item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification &&
              item.verificationStateId === latestItem.verificationStateId
                ? latestItem
                : item
            )
          );
        }

        if (failure.details?.writeRequestId) {
          const writeRequestId = failure.details.writeRequestId;
          const filtersWillChange =
            kind !== SALES_CHANNEL_SYNC_CHECK_KIND.all ||
            status !== "UNRESOLVED" ||
            Boolean(appliedSearch);
          pendingInitialWriteRequestIdRef.current = writeRequestId;
          setKind(SALES_CHANNEL_SYNC_CHECK_KIND.all);
          setStatus("UNRESOLVED");
          setSearch("");
          setAppliedSearch("");

          if (!filtersWillChange) {
            await load();
          }
        }

        throw new Error(legacyApiMessage(payload, t("message.repairFailed")));
      }

      const repairMessage = t(
        `repairResult.${inventoryRepairSuccessKey(payload.item.verificationStatus)}`
      );
      setMessage(`${repairMessage} ${t("writeRequest", { id: payload.writeRequestId })}`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  function requestSelectItem(item: SalesChannelSyncCheckItem) {
    if (working) return;
    const nextKey = salesChannelSyncCheckItemKey(item);
    if (nextKey === selectedKey) return;

    runGuardedAction({
      intent: "internal-change",
      formIds: guardedFormIds,
      targetLabel: t("unsaved.anotherItem"),
      action: () => setSelectedKey(nextKey),
    });
  }

  function requestKindChange(nextKind: SalesChannelSyncCheckQueryKind) {
    if (working) return;
    if (nextKind === kind) return;

    runGuardedAction({
      intent: "internal-change",
      formIds: guardedFormIds,
      targetLabel: t("unsaved.changeKind"),
      action: () => {
        setKind(nextKind);
        setStatus("UNRESOLVED");
      },
    });
  }

  function requestStatusChange(nextStatus: string) {
    if (working) return;
    if (nextStatus === status) return;

    runGuardedAction({
      intent: "internal-change",
      formIds: guardedFormIds,
      targetLabel: t("unsaved.changeStatus"),
      action: () => setStatus(nextStatus),
    });
  }

  function requestLoad() {
    if (working) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: guardedFormIds,
      targetLabel: t("unsaved.reload"),
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

  function unresolvedCountForKind(nextKind: SalesChannelSyncCheckQueryKind) {
    if (nextKind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) {
      return unresolvedCounts.writeRequest;
    }
    if (nextKind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) {
      return unresolvedCounts.inventoryVerification;
    }
    if (nextKind === SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity) {
      return unresolvedCounts.claimIntegrity;
    }
    return unresolvedCount;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <div className="border-b border-border pb-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">
                {t("title")}
              </h2>
              <Badge variant={unresolvedCount > 0 ? "danger" : "secondary"}>
                {t("unresolved", { count: unresolvedCount })}
              </Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {t("description")}
            </p>
          </div>
          <span className="pt-1 text-xs text-muted-foreground">
            {resultCount >= resultLimit
              ? t("format.resultLimit", { count: resultLimit })
              : t("format.resultCount", { count: resultCount })}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={t("filters.kind")}
          >
            {SALES_CHANNEL_SYNC_CHECK_KIND_OPTIONS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={kind === option.value ? "default" : "outline"}
                aria-pressed={kind === option.value}
                disabled={working}
                onClick={() => requestKindChange(option.value)}
              >
                {t(`kind.${option.labelKey}`)}
                <span
                  className={cn(
                    "ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-[10px]",
                    unresolvedCountForKind(option.value) > 0
                      ? "bg-red-100 text-red-700"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {unresolvedCountForKind(option.value).toLocaleString(locale)}
                </span>
              </Button>
            ))}
          </div>

          <select
            aria-label={t("filters.status")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={status}
            disabled={working}
            onChange={(event) => requestStatusChange(event.target.value)}
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label={t("filters.search")}
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder={t("filters.placeholder")}
              value={search}
              disabled={working}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  requestLoad();
                }
              }}
            />
          </div>

          <Button
            size="sm"
            variant="outline"
            disabled={loading || working}
            onClick={requestLoad}
          >
            <RefreshCcw className={cn("size-4", loading && "animate-spin")} />
            {t("filters.refresh")}
          </Button>
        </div>
      </div>

      <SalesChannelWriteControlAlerts
        controls={controls}
        working={working}
        onResume={(control) =>
          runWriteAction({
            action: "resumeControl",
            controlId: control.id,
            expectedControlRevision: control.revision,
          })
        }
      />

      {error || message ? (
        <div
          className={cn(
            "break-words border px-3 py-2 text-sm",
            error
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-emerald-300 bg-emerald-50 text-emerald-900"
          )}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          {error || message}
        </div>
      ) : null}

      <MasterDetailLayout className="grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-h-[280px] overflow-auto border border-border bg-background">
          <table className="w-full min-w-[1120px] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-24 px-3 py-2 font-medium">{t("columns.kind")}</th>
                <th className="w-36 px-3 py-2 font-medium">{t("columns.status")}</th>
                <th className="w-44 px-3 py-2 font-medium">{t("columns.target")}</th>
                <th className="w-56 px-3 py-2 font-medium">{t("columns.work")}</th>
                <th className="w-56 px-3 py-2 font-medium">{t("columns.quantities")}</th>
                <th className="px-3 py-2 font-medium">{t("columns.error")}</th>
                <th className="w-36 px-3 py-2 font-medium">{t("columns.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const itemKey = salesChannelSyncCheckItemKey(item);

                return (
                  <tr
                    key={itemKey}
                    className={cn(
                      "cursor-pointer border-t border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedKey === itemKey && "bg-primary/5"
                    )}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedKey === itemKey}
                    onClick={() => requestSelectItem(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        requestSelectItem(item);
                      }
                    }}
                  >
                    <td className="px-3 py-2 text-xs font-medium">
                      {t(`kind.${syncCheckKindKey(item)}`)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={salesChannelSyncCheckStatusVariant(item)}>
                        {t(`statusFilter.${salesChannelSyncCheckStatusKey(item)}`)}
                      </Badge>
                    </td>
                    {item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest ? (
                      <WriteListCells item={item} />
                    ) : item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification ? (
                      <InventoryListCells item={item} />
                    ) : (
                      <ClaimIntegrityListCells item={item} />
                    )}
                    <td className="px-3 py-2 text-xs">
                      {formatSalesChannelSyncCheckDate(item.updatedAt)}
                    </td>
                  </tr>
                );
              })}
              {!loading && items.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="h-40 px-3 text-center text-muted-foreground"
                  >
                    {t("state.empty")}
                  </td>
                </tr>
              ) : null}
              {loading && items.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="h-40 px-3 text-center text-muted-foreground"
                  >
                    {t("state.loading")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {nextCursor ? (
            <div className="border-t border-border p-3 text-center">
              <Button
                size="sm"
                variant="outline"
                disabled={loading || working}
                onClick={() => void load(nextCursor, true)}
              >
                {loading ? t("state.loadingMore") : t("state.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>

        <aside className="min-h-0 overflow-auto border border-border bg-background">
          {selectedWrite ? (
            <SalesChannelWriteReviewDetail
              item={selectedWrite as SalesChannelWriteReviewItemDto}
              working={working}
              note={note}
              onNoteChange={(value) =>
                setNoteDraft((current) => ({
                  requestId: selectedWrite.id,
                  baseline:
                    current.requestId === selectedWrite.id
                      ? current.baseline
                      : selectedWrite.manualVerificationNote ?? "",
                  value,
                }))
              }
              onRecheck={() =>
                runWriteAction({
                  action: "recheck",
                  requestId: selectedWrite.id,
                })
              }
              onRetryLocal={() =>
                runWriteAction({
                  action: "retryLocal",
                  requestId: selectedWrite.id,
                })
              }
              onDecision={decideWrite}
              onOpenSourceMenu={onOpenSourceMenu}
            />
          ) : selectedInventory ? (
            <SalesChannelInventoryVerificationDetail
              item={selectedInventory}
              working={working}
              onRecheck={recheckInventory}
              onRepair={repairInventory}
            />
          ) : selectedClaimIntegrity ? (
            <div className="space-y-4 p-5 text-sm">
              <div>
                <h3 className="font-semibold">{t("claim.title")}</h3>
                <p className="mt-1 text-muted-foreground">
                  {t("claim.description")}
                </p>
              </div>
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">{t("claim.kind")}</dt>
                <dd>{selectedClaimIntegrity.claimType}</dd>
                <dt className="text-muted-foreground">{t("claim.id")}</dt>
                <dd className="font-mono">{selectedClaimIntegrity.externalClaimId}</dd>
                <dt className="text-muted-foreground">{t("claim.order")}</dt>
                <dd className="font-mono">{selectedClaimIntegrity.externalOrderId}</dd>
                <dt className="text-muted-foreground">{t("claim.shipment")}</dt>
                <dd className="font-mono">{selectedClaimIntegrity.externalShipmentId || t("claim.unknown")}</dd>
                <dt className="text-muted-foreground">{t("claim.integrity")}</dt>
                <dd>
                  {{
                    VALID: claimT("integrityStatus.valid"),
                    MISSING_IDENTITY: claimT("integrityStatus.missingIdentity"),
                    INVALID_QUANTITY: claimT("integrityStatus.invalidQuantity"),
                    COUNT_MISMATCH: claimT("integrityStatus.countMismatch"),
                  }[selectedClaimIntegrity.integrityStatus] ??
                    claimT("integrityStatus.unknown", {
                      code: selectedClaimIntegrity.integrityStatus,
                    })}
                </dd>
              </dl>
              <div className="border border-red-200 bg-red-50 p-3 text-red-900">
                {t(`claim.issue.${selectedClaimIntegrity.messageCode}`)}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-60 items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <ShieldAlert className="size-4" />
              {t("state.select")}
            </div>
          )}
        </aside>
      </MasterDetailLayout>
    </div>
  );
}
