"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, RefreshCcw, ShieldAlert } from "lucide-react";
import {
  useGuardedDialogClose,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { statusLabel, statusMap } from "@/quickhack_client/components/shared/device-detail-sheet";
import { allocationStatusLabel } from "@/quickhack_client/components/sales-channel/allocation-status-presentation";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { DialogFrame } from "@/quickhack_client/components/ui/dialog-frame";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  createReturnActionDraftSnapshot,
  restoreReturnActionDraft,
  returnActionDraftSnapshotsEqual,
  type ReturnActionDraftSnapshot,
  type ReturnInspectionDraft,
} from "@/quickhack_client/components/returns/return-action-draft-state";

type ReturnListPhase = "before" | "after";

type ReturnListRow = {
  id: number;
  projectionRevision: number;
  integrityStatus?: string | null;
  externalReceiptId?: string | null;
  externalOrderId?: string | null;
  orderedAt?: string | null;
  receiverName?: string | null;
  receiverSafeNumber?: string | null;
  receiverAddress?: string | null;
  productText?: string | null;
  matchedPgText?: string | null;
  inventoryStatusText?: string | null;
  shipmentBatchText?: string | null;
  receiptStatus?: string | null;
  cancelCount?: number | null;
  selectedAllocationIds?: number[] | null;
  itemRequirements?: ReturnItemRequirement[];
  allocationCandidates?: ReturnAllocationCandidate[];
  nextReturnAction?: "stopShipment" | "receiveConfirm" | "approve" | null;
  reason1?: string | null;
  reason2?: string | null;
  reason3?: string | null;
  writeReviewRequired?: boolean;
  writeRequestId?: number | null;
};

type ReturnItemRequirement = {
  key: string;
  externalShipmentId: string;
  externalVendorItemId: string;
  vendorItemName?: string | null;
  requiredQuantity: number;
  selectableQuantity: number;
  missingQuantity: number;
  candidateAllocationIds: number[];
  selectedQuantity: number;
};

type ReturnAllocationCandidate = {
  allocationId: number;
  pgNo: string;
  externalShipmentId?: string | null;
  externalVendorItemId?: string | null;
  productName?: string | null;
  model?: string | null;
  modelSeq?: number | null;
  storage?: string | null;
  color?: string | null;
  saleGrade?: string | null;
  warranty?: string | null;
  imei?: string | null;
  inventoryStatus?: string | null;
  allocationStatus?: string | null;
  matchedAt?: string | null;
  shipmentBatchText?: string | null;
  selectedForReturn?: boolean | null;
  reusableSupplies?: ReturnSupplyCandidate[];
};

type ReturnSupplyCandidate = {
  consumptionEventId: number;
  supplyCode: string;
  supplyName: string;
  quantity: number;
  reusable: boolean;
  recovered: boolean;
};

type ReturnListSummary = {
  returnCount?: number;
  linkedOrderCount?: number;
  linkedShipmentCount?: number;
  matchedDeviceCount?: number;
  beforeShipmentCount?: number;
  afterShipmentCount?: number;
  orderStatusCheckCount?: number;
};

type ReturnListApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  details?: { expectedAction?: "stopShipment" | "receiveConfirm" | "approve" };
  messageCode?: "RETURN_WRITE_REVIEW_REQUIRED";
  completed?: boolean;
  reviewRequired?: boolean;
  writeRequestId?: number | null;
  phase?: ReturnListPhase;
  count?: number;
  summary?: ReturnListSummary;
  summaryCoverage?: "COMPLETE" | "PAGE";
  items?: ReturnListRow[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

type ReturnColumnKey =
  | "action"
  | "receiptStatus"
  | "inventoryStatus"
  | "shipmentBatch"
  | "externalOrderId"
  | "product"
  | "matchedPg"
  | "receiver"
  | "receiverAddress"
  | "orderedAt"
  | "reason1"
  | "reason2"
  | "reason3";

const returnInspectionResultOptions = [
  { value: "PASSED" },
  { value: "FAILED" },
  { value: "HOLD" },
  { value: "RETURN_TO_SUPPLIER" },
  { value: "DISPOSAL" },
] as const;

function defaultReturnInspectionDraft(
  candidate?: ReturnAllocationCandidate
): ReturnInspectionDraft {
  return {
    inspectionResult: "PASSED",
    appearanceGrade: "",
    appearanceDefect: "",
    functionDefect: "",
    note: "",
    reusableSupplyConsumptionEventIds:
      candidate?.reusableSupplies
        ?.filter((supply) => supply.reusable && !supply.recovered)
        .map((supply) => supply.consumptionEventId) ?? [],
  };
}

function textOrDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function numberOrZero(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatDateTime(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "-";
  }

  return text.replace("T", " ").slice(0, 19);
}

function statusVariant(value: string | null | undefined) {
  const text = String(value ?? "").toUpperCase();

  if (text.includes("FAIL") || text.includes("CANCEL") || text.includes("ERROR")) {
    return "danger" as const;
  }

  if (
    text === "RU" ||
    text === "UC" ||
    text.includes("UNCHECKED") ||
    text.includes("REQUEST") ||
    text.includes("STOP")
  ) {
    return "warning" as const;
  }

  if (
    text === "CC" ||
    text.includes("COMPLETE") ||
    text.includes("CONFIRM")
  ) {
    return "success" as const;
  }

  return "neutral" as const;
}

function splitLines(value: string | null | undefined) {
  return String(value ?? "")
    .split(/\n|,\s*/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function lineText(value: string | null | undefined) {
  return splitLines(value).join("\n");
}

function receiverText(row: ReturnListRow) {
  const name = String(row.receiverName ?? "").trim();
  const phone = String(row.receiverSafeNumber ?? "").trim();

  if (!name && !phone) {
    return "-";
  }

  return [name, phone].filter(Boolean).join(" / ");
}

function deviceSummary(
  candidate: ReturnAllocationCandidate,
  modelSequence: (value: number) => string
) {
  return [
    candidate.model,
    candidate.modelSeq ? modelSequence(candidate.modelSeq) : "",
    candidate.storage,
    candidate.color,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function gradeSummary(candidate: ReturnAllocationCandidate) {
  return [candidate.saleGrade, candidate.warranty]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" / ");
}

function maskedImei(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "-";
  }

  if (text.length <= 6) {
    return text;
  }

  return `${text.slice(0, 2)}****${text.slice(-4)}`;
}

function SummaryPill({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  const locale = useLocale();
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs text-muted-foreground">
      {label}
      <strong className="font-semibold text-foreground">
        {numberOrZero(value).toLocaleString(locale)}
      </strong>
    </span>
  );
}

function LineList({ value }: { value: string | null | undefined }) {
  const lines = splitLines(value);

  if (lines.length === 0) {
    return <span>-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-0.5 leading-4">
      {lines.map((line, index) => (
        <div key={`${line}:${index}`} className="truncate">
          {line}
        </div>
      ))}
    </div>
  );
}

function InventoryStatusBadgeList({
  value,
}: {
  value: string | null | undefined;
}) {
  const detailT = useTranslations("common.deviceDetail");
  const statuses = splitLines(value);

  if (statuses.length === 0) {
    return <span>-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 leading-4">
      {statuses.map((status, index) => {
        const mapped = statusMap[status];
        const label = statusLabel(status, detailT);

        return (
          <Badge
            key={`${status}:${index}`}
            variant={mapped?.tone ?? "neutral"}
            className="max-w-full truncate"
          >
            {label}
          </Badge>
        );
      })}
    </div>
  );
}

export function ReturnListView({
  phase,
  onOpenWriteReview,
}: {
  phase: ReturnListPhase;
  onOpenWriteReview?: (requestId: number) => void;
}) {
  const t = useTranslations("returns");
  const detailT = useTranslations("common.deviceDetail");
  const manualMatchT = useTranslations("salesChannel.manualMatch");
  const locale = useLocale();

  const phaseTitle = phase === "before" ? t("phase.before.title") : t("phase.after.title");
  const phaseEmpty = phase === "before" ? t("phase.before.empty") : t("phase.after.empty");
  const phaseLoading = phase === "before" ? t("phase.before.loading") : t("phase.after.loading");

  const returnActionLabel = React.useCallback((value: ReturnListRow["nextReturnAction"]) => {
    if (value === "stopShipment") return t("actions.stopShipment");
    if (value === "receiveConfirm") return t("actions.receiveConfirm");
    if (value === "approve") return t("actions.approve");
    return "";
  }, [t]);

  const receiptStatusLabel = React.useCallback((value: string | null | undefined) => {
    const key = String(value ?? "").trim();
    if (["RU", "RELEASE_STOP_UNCHECKED"].includes(key)) return t("receiptStatus.stop");
    if (["UC", "RETURNS_UNCHECKED"].includes(key)) return t("receiptStatus.receipt");
    if (["CC", "RETURNS_COMPLETED"].includes(key)) return t("receiptStatus.completed");
    if (key === "VENDOR_WAREHOUSE_CONFIRM") return t("receiptStatus.confirm");
    if (["PR", "REQUEST_COUPANG_CHECK"].includes(key)) return t("receiptStatus.requestCheck");
    return key || "-";
  }, [t]);

  const inspectionResultLabel = React.useCallback((value: string) => {
    if (value === "FAILED") return t("inspection.result.failed");
    if (value === "HOLD") return t("inspection.result.hold");
    if (value === "RETURN_TO_SUPPLIER") return t("inspection.result.returnToSupplier");
    if (value === "DISPOSAL") return t("inspection.result.disposal");
    return t("inspection.result.passed");
  }, [t]);

  const [rows, setRows] = React.useState<ReturnListRow[]>([]);
  const [summary, setSummary] = React.useState<ReturnListSummary>({});
  const [summaryCoverage, setSummaryCoverage] = React.useState<
    "COMPLETE" | "PAGE"
  >("COMPLETE");
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [runningActionId, setRunningActionId] = React.useState<number | null>(
    null
  );
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<"info" | "warning">(
    "info"
  );
  const [actionModalRow, setActionModalRow] =
    React.useState<ReturnListRow | null>(null);
  const [selectedAllocationIds, setSelectedAllocationIds] = React.useState<
    number[]
  >([]);
  const [returnInspectionDrafts, setReturnInspectionDrafts] = React.useState<
    Record<number, ReturnInspectionDraft>
  >({});
  const [actionDraftBaseline, setActionDraftBaseline] =
    React.useState<ReturnActionDraftSnapshot | null>(null);
  const actionDraftFormId = `returns.action:${phase}:${
    actionModalRow?.id ?? "closed"
  }`;
  const actionDraftFormIds = React.useMemo(
    () => [actionDraftFormId],
    [actionDraftFormId]
  );
  const actionDraftSnapshot = React.useMemo(
    () =>
      createReturnActionDraftSnapshot({
        allocationIds: selectedAllocationIds,
        inspectionDrafts: returnInspectionDrafts,
      }),
    [returnInspectionDrafts, selectedAllocationIds]
  );
  const actionDraftDirty =
    actionDraftBaseline !== null &&
    !returnActionDraftSnapshotsEqual(
      actionDraftBaseline,
      actionDraftSnapshot
    );

  const discardActionDraft = React.useCallback(() => {
    if (!actionDraftBaseline) {
      return;
    }

    const restored = restoreReturnActionDraft(actionDraftBaseline);
    setSelectedAllocationIds(restored.allocationIds);
    setReturnInspectionDrafts(restored.inspectionDrafts);
  }, [actionDraftBaseline]);

  const closeActionModalImmediately = React.useCallback(() => {
    setActionModalRow(null);
    setSelectedAllocationIds([]);
    setReturnInspectionDrafts({});
    setActionDraftBaseline(null);
  }, []);

  const requestActionModalClose = useGuardedDialogClose({
    formIds: actionDraftFormIds,
    targetLabel: t("actionDraft.target"),
    onClose: closeActionModalImmediately,
  });

  useUnsavedForm({
    id: actionDraftFormId,
    label: t("actionDraft.form"),
    enabled: actionModalRow !== null,
    isDirty: actionDraftDirty,
    isBusy: runningActionId !== null,
    discard: discardActionDraft,
  });

  const loadRows = React.useCallback(async (options?: {
    cursor?: string | null;
    append?: boolean;
  }) => {
    setIsLoading(true);
    setMessage("");
    setMessageTone("info");

    try {
      const query = new URLSearchParams({ phase, limit: "100" });
      if (options?.cursor) {
        query.set("cursor", options.cursor);
      }
      const response = await fetch(`/api/coupang/returns?${query.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | ReturnListApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("message.loadFailed")));
      }

      setRows((current) =>
        options?.append ? [...current, ...(payload.items ?? [])] : payload.items ?? []
      );
      setSummary(payload.summary ?? {});
      setSummaryCoverage(payload.summaryCoverage ?? "COMPLETE");
      setNextCursor(payload.nextCursor ?? null);
      setHasMore(Boolean(payload.hasMore));
    } catch (error) {
      if (!options?.append) {
        setRows([]);
        setSummary({});
        setSummaryCoverage("COMPLETE");
        setNextCursor(null);
        setHasMore(false);
      }
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsLoading(false);
    }
  }, [phase, t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadRows();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadRows]);

  const openActionModal = React.useCallback((row: ReturnListRow) => {
    const alreadySelected =
      row.allocationCandidates
        ?.filter((candidate) => candidate.selectedForReturn)
        .map((candidate) => candidate.allocationId) ??
      row.selectedAllocationIds ??
      [];
    const initialDrafts = Object.fromEntries(
      alreadySelected.map((allocationId) => [
        allocationId,
        defaultReturnInspectionDraft(
          row.allocationCandidates?.find(
            (candidate) => candidate.allocationId === allocationId
          )
        ),
      ])
    );

    setActionModalRow(row);
    setSelectedAllocationIds(alreadySelected);
    setReturnInspectionDrafts(initialDrafts);
    setActionDraftBaseline(
      createReturnActionDraftSnapshot({
        allocationIds: alreadySelected,
        inspectionDrafts: initialDrafts,
      })
    );
    setMessage("");
    setMessageTone("info");
  }, []);

  const toggleAllocationSelection = React.useCallback(
    (allocationId: number) => {
      setSelectedAllocationIds((current) => {
        const exists = current.includes(allocationId);

        if (exists) {
          setReturnInspectionDrafts((drafts) => {
            const next = { ...drafts };
            delete next[allocationId];
            return next;
          });

          return current.filter((id) => id !== allocationId);
        }

        const requirement = actionModalRow?.itemRequirements?.find((item) =>
          item.candidateAllocationIds.includes(allocationId)
        );
        const selectedInRequirement = requirement
          ? requirement.candidateAllocationIds.filter((id) => current.includes(id)).length
          : 0;
        if (
          !requirement ||
          selectedInRequirement >= requirement.selectableQuantity
        ) {
          return current;
        }

        setReturnInspectionDrafts((drafts) => ({
          ...drafts,
          [allocationId]:
            drafts[allocationId] ??
            defaultReturnInspectionDraft(
              actionModalRow?.allocationCandidates?.find(
                (candidate) => candidate.allocationId === allocationId
              )
            ),
        }));

        return [...current, allocationId];
      });
    },
    [actionModalRow]
  );

  const updateReturnInspectionDraft = React.useCallback(
    (
      allocationId: number,
      key: Exclude<
        keyof ReturnInspectionDraft,
        "reusableSupplyConsumptionEventIds"
      >,
      value: string
    ) => {
      setReturnInspectionDrafts((drafts) => ({
        ...drafts,
        [allocationId]: {
          ...(drafts[allocationId] ?? defaultReturnInspectionDraft()),
          [key]: value,
        },
      }));
    },
    []
  );

  const toggleReusableSupply = React.useCallback(
    (allocationId: number, consumptionEventId: number) => {
      setReturnInspectionDrafts((drafts) => {
        const candidate = actionModalRow?.allocationCandidates?.find(
          (item) => item.allocationId === allocationId
        );
        const current =
          drafts[allocationId] ?? defaultReturnInspectionDraft(candidate);
        const selected = current.reusableSupplyConsumptionEventIds.includes(
          consumptionEventId
        );

        return {
          ...drafts,
          [allocationId]: {
            ...current,
            reusableSupplyConsumptionEventIds: selected
              ? current.reusableSupplyConsumptionEventIds.filter(
                  (eventId) => eventId !== consumptionEventId
                )
              : [
                  ...current.reusableSupplyConsumptionEventIds,
                  consumptionEventId,
                ],
          },
        };
      });
    },
    [actionModalRow]
  );

  const runReturnAction = React.useCallback(
    async (
      row: ReturnListRow,
      allocationIds: number[],
      returnInspections: Array<ReturnInspectionDraft & { allocationId: number }>
    ) => {
      if (!row.nextReturnAction) {
        return;
      }

      setRunningActionId(row.id);
      setMessage("");
      setMessageTone("info");

      try {
        const response = await fetch("/api/coupang/returns", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            returnRawId: row.id,
            expectedProjectionRevision: row.projectionRevision,
            action: row.nextReturnAction,
            allocationIds,
            returnInspections,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | ReturnListApiResponse
          | null;

        if (!response.ok || !payload?.ok) {
          if (
            payload?.code === "RETURN_ACTION_MISMATCH" &&
            payload.details?.expectedAction
          ) {
            throw new Error(
              t("message.actionMismatch", {
                action: t(`actions.${payload.details.expectedAction}`),
              })
            );
          }
          throw new Error(legacyApiMessage(payload, t("message.actionFailed")));
        }

        await loadRows();
        setMessage(
          payload.messageCode === "RETURN_WRITE_REVIEW_REQUIRED"
            ? t("message.reviewRequired")
            : t("message.actionComplete")
        );
        setMessageTone(payload.reviewRequired ? "warning" : "info");
        closeActionModalImmediately();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        setMessageTone("warning");
      } finally {
        setRunningActionId(null);
      }
    },
    [closeActionModalImmediately, loadRows, t]
  );

  const columns = React.useMemo<
    DataGridColumn<ReturnColumnKey, ReturnListRow>[]
  >(
    () => [
      {
        key: "action",
        label: t("columns.action"),
        width: "124px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => returnActionLabel(row.nextReturnAction),
        render: (row) => {
          if (row.writeReviewRequired && row.writeRequestId) {
            return (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenWriteReview?.(row.writeRequestId!)}
                className="w-full border-red-300 text-red-800 hover:bg-red-50"
              >
                <ShieldAlert className="size-4" />
                {t("actions.reviewRequired")}
              </Button>
            );
          }

          const disabled =
            isLoading ||
            runningActionId !== null ||
            !row.nextReturnAction;

          if (!row.nextReturnAction) {
            return <span className="text-xs text-muted-foreground">-</span>;
          }

          return (
            <Button
              size="sm"
              variant={row.nextReturnAction === "approve" ? "default" : "outline"}
              disabled={disabled}
              onClick={() => openActionModal(row)}
              className="w-full"
            >
              <CheckCircle2 className="size-4" />
              {runningActionId === row.id ? t("actions.processing") : returnActionLabel(row.nextReturnAction)}
            </Button>
          );
        },
      },
      {
        key: "receiptStatus",
        label: t("columns.receiptStatus"),
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => receiptStatusLabel(row.receiptStatus),
        render: (row) => (
          <Badge variant={statusVariant(row.receiptStatus)}>
            {receiptStatusLabel(row.receiptStatus)}
          </Badge>
        ),
      },
      {
        key: "inventoryStatus",
        label: t("columns.inventoryStatus"),
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => lineText(row.inventoryStatusText),
        render: (row) => (
          <InventoryStatusBadgeList value={row.inventoryStatusText} />
        ),
      },
      {
        key: "shipmentBatch",
        label: t("columns.shipmentBatch"),
        width: "170px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => lineText(row.shipmentBatchText),
        render: (row) => <LineList value={row.shipmentBatchText} />,
      },
      {
        key: "externalOrderId",
        label: t("columns.orderId"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.externalOrderId,
        render: (row) => (
          <span className="truncate">{textOrDash(row.externalOrderId)}</span>
        ),
      },
      {
        key: "product",
        label: t("columns.product"),
        width: "minmax(260px, 1.25fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.productText,
        render: (row) => (
          <span className="truncate font-medium">
            {textOrDash(row.productText)}
          </span>
        ),
      },
      {
        key: "matchedPg",
        label: "pg",
        width: "160px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => lineText(row.matchedPgText),
        render: (row) => <LineList value={row.matchedPgText} />,
      },
      {
        key: "receiver",
        label: t("columns.receiver"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: receiverText,
        render: (row) => <span className="truncate">{receiverText(row)}</span>,
      },
      {
        key: "receiverAddress",
        label: t("columns.address"),
        width: "minmax(280px, 1fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => (
          <span className="truncate">{textOrDash(row.receiverAddress)}</span>
        ),
      },
      {
        key: "orderedAt",
        label: t("columns.orderAt"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.orderedAt,
        render: (row) => (
          <span className="truncate">{formatDateTime(row.orderedAt)}</span>
        ),
      },
      {
        key: "reason1",
        label: t("columns.reason1"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.reason1,
        render: (row) => <span className="truncate">{textOrDash(row.reason1)}</span>,
      },
      {
        key: "reason2",
        label: t("columns.reason2"),
        width: "170px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.reason2,
        render: (row) => <span className="truncate">{textOrDash(row.reason2)}</span>,
      },
      {
        key: "reason3",
        label: t("columns.reason3"),
        width: "180px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.reason3,
        render: (row) => <span className="truncate">{textOrDash(row.reason3)}</span>,
      },
    ],
    [isLoading, onOpenWriteReview, openActionModal, receiptStatusLabel, returnActionLabel, runningActionId, t]
  );

  const modalCancelCount = numberOrZero(actionModalRow?.cancelCount);
  const modalCandidates = actionModalRow?.allocationCandidates ?? [];
  const modalRequirements = actionModalRow?.itemRequirements ?? [];
  const modalRequiredCount = modalRequirements.reduce(
    (sum, requirement) => sum + requirement.selectableQuantity,
    0
  );
  const modalSelectionLocked =
    actionModalRow?.nextReturnAction === "approve" &&
    numberOrZero(actionModalRow.selectedAllocationIds?.length) > 0;
  const modalRequiresReturnInspection =
    phase === "after" &&
    actionModalRow?.nextReturnAction === "approve" &&
    selectedAllocationIds.length > 0;
  const selectedReturnInspectionCandidates = modalCandidates.filter((candidate) =>
    selectedAllocationIds.includes(candidate.allocationId)
  );
  const selectedReturnInspections = selectedAllocationIds.map((allocationId) => ({
    allocationId,
    ...(returnInspectionDrafts[allocationId] ??
      defaultReturnInspectionDraft(
        modalCandidates.find(
          (candidate) => candidate.allocationId === allocationId
        )
      )),
  }));
  const modalReturnInspectionReady =
    !modalRequiresReturnInspection ||
    selectedReturnInspections.every((inspection) =>
      String(inspection.inspectionResult ?? "").trim()
    );
  const modalCanSubmit =
    Boolean(actionModalRow?.nextReturnAction) &&
    modalRequirements.length > 0 &&
    modalRequirements.every(
      (requirement) =>
        requirement.candidateAllocationIds.filter((allocationId) =>
          selectedAllocationIds.includes(allocationId)
        ).length === requirement.selectableQuantity
    ) &&
    modalReturnInspectionReady &&
    runningActionId === null;

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{phaseTitle}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <SummaryPill label={t("summary.receipts")} value={summary.returnCount} />
            <SummaryPill label={t("summary.linkedOrders")} value={summary.linkedOrderCount} />
            <SummaryPill label={t("summary.linkedShipments")} value={summary.linkedShipmentCount} />
            <SummaryPill label={t("summary.before")} value={summary.beforeShipmentCount} />
            <SummaryPill label={t("summary.after")} value={summary.afterShipmentCount} />
            <SummaryPill label={t("summary.statusCheck")} value={summary.orderStatusCheckCount} />
            <SummaryPill label={t("summary.matchedPg")} value={summary.matchedDeviceCount} />
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadRows()}
          disabled={isLoading}
        >
          <RefreshCcw className="size-4" />
          {t("actions.refresh")}
        </Button>
      </div>

      {message ? (
        <FeedbackBanner
          tone={messageTone === "warning" ? "warning" : "info"}
          className="mb-3"
        >
          {message}
        </FeedbackBanner>
      ) : null}

      <VirtualizedDataGrid
        rows={rows}
        columns={columns}
        rowKey={(row) => `${phase}-${row.id}`}
        emptyMessage={isLoading ? phaseLoading : phaseEmpty}
        minWidth="2084px"
        rowHeight={54}
      />

      {hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            disabled={isLoading || !nextCursor}
            onClick={() => void loadRows({ cursor: nextCursor, append: true })}
          >
            {isLoading ? t("actions.loading") : t("actions.loadMore")}
          </Button>
        </div>
      ) : null}

      {summaryCoverage === "PAGE" ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {t("summary.coverage")}
        </p>
      ) : null}

      <DialogFrame
        open={Boolean(actionModalRow)}
        onOpenChange={(open) => {
          if (!open) {
            requestActionModalClose();
          }
        }}
        title={t("modal.title")}
        description={t("modal.description", { action: returnActionLabel(actionModalRow?.nextReturnAction) || t("columns.action") })}
        closeDisabled={runningActionId !== null}
        overlayClassName="z-40"
        contentClassName="z-50 max-h-[86vh] w-[min(1040px,calc(100vw-32px))] shadow-lg"
        bodyClassName="contents"
      >
        {actionModalRow ? (
              <>
                <div className="grid shrink-0 gap-2 border-b bg-secondary/35 px-5 py-3 text-xs md:grid-cols-4">
                  <div>
                    <span className="text-muted-foreground">{t("modal.orderId")}</span>
                    <div className="mt-1 font-mono font-medium">
                      {textOrDash(actionModalRow.externalOrderId)}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t("modal.receiptId")}</span>
                    <div className="mt-1 font-mono font-medium">
                      {textOrDash(actionModalRow.externalReceiptId)}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t("modal.cancelCount")}</span>
                    <div className="mt-1 font-medium">
                      {t("modal.unit", { count: modalCancelCount })}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t("modal.allocation")}</span>
                    <div
                      className={
                        selectedAllocationIds.length === modalRequiredCount
                          ? "mt-1 font-medium text-emerald-700"
                          : "mt-1 font-medium text-amber-700"
                      }
                    >
                      {selectedAllocationIds.length.toLocaleString(locale)} /{" "}
                      {modalRequiredCount.toLocaleString(locale)}
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                  {modalRequirements.length > 0 ? (
                    <div className="mb-3 grid gap-2">
                      {modalRequirements.map((requirement) => {
                        const selectedCount = requirement.candidateAllocationIds.filter(
                          (allocationId) => selectedAllocationIds.includes(allocationId)
                        ).length;
                        return (
                          <div
                            key={requirement.key}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-secondary/25 px-3 py-2 text-xs"
                          >
                            <span>
                              {t("modal.item", { shipmentId: requirement.externalShipmentId, itemId: requirement.externalVendorItemId })}
                              {requirement.vendorItemName ? ` · ${requirement.vendorItemName}` : ""}
                            </span>
                            <span className={selectedCount === requirement.selectableQuantity ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>
                              {t("modal.select", { selected: selectedCount, required: requirement.selectableQuantity })}
                              {requirement.missingQuantity > 0 ? ` · ${t("modal.missing", { count: requirement.missingQuantity })}` : ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {modalCandidates.length === 0 ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      {t("modal.candidateEmpty")}
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {modalCandidates.map((candidate) => {
                        const checked = selectedAllocationIds.includes(
                          candidate.allocationId
                        );
                        const limitReached =
                          !checked && (() => {
                            const requirement = modalRequirements.find((item) =>
                              item.candidateAllocationIds.includes(candidate.allocationId)
                            );
                            return !requirement || requirement.candidateAllocationIds.filter(
                              (allocationId) => selectedAllocationIds.includes(allocationId)
                            ).length >= requirement.selectableQuantity;
                          })();
                        const disabled =
                          limitReached ||
                          runningActionId !== null ||
                          modalSelectionLocked;

                        return (
                          <label
                            key={candidate.allocationId}
                            className={
                              checked
                                ? "grid cursor-pointer grid-cols-[28px_130px_1.2fr_1fr_110px] items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm"
                                : "grid cursor-pointer grid-cols-[28px_130px_1.2fr_1fr_110px] items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm hover:bg-secondary/50"
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() =>
                                toggleAllocationSelection(candidate.allocationId)
                              }
                              className="size-4"
                            />
                            <div className="min-w-0">
                              <div className="truncate font-mono font-semibold">
                                {candidate.pgNo}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {statusLabel(candidate.inventoryStatus ?? "", detailT)}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {textOrDash(candidate.productName)}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {textOrDash(candidate.externalVendorItemId)}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {textOrDash(deviceSummary(candidate, (value) => t("format.modelSequence", { value })))}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {textOrDash(gradeSummary(candidate))} · IMEI {maskedImei(candidate.imei)}
                              </div>
                            </div>
                            <div className="min-w-0 text-xs">
                              <div className="truncate">
                                {textOrDash(candidate.shipmentBatchText)}
                              </div>
                              <div className="truncate text-muted-foreground">
                                {allocationStatusLabel(candidate.allocationStatus, manualMatchT)}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {modalRequiresReturnInspection ? (
                    <div className="mt-4 rounded-md border bg-background">
                      <div className="border-b px-3 py-2">
                        <div className="text-sm font-semibold">{t("inspection.title")}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t("inspection.description")}
                        </div>
                      </div>
                      <div className="grid gap-3 p-3">
                        {selectedReturnInspectionCandidates.map((candidate) => {
                          const draft =
                            returnInspectionDrafts[candidate.allocationId] ??
                            defaultReturnInspectionDraft(candidate);

                          return (
                            <div
                              key={`return-inspection-${candidate.allocationId}`}
                              className="grid gap-3 rounded-md border bg-secondary/20 p-3"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-mono text-sm font-semibold">
                                    {candidate.pgNo}
                                  </div>
                                  <div className="truncate text-xs text-muted-foreground">
                                    {textOrDash(deviceSummary(candidate, (value) => t("format.modelSequence", { value })))} / {textOrDash(gradeSummary(candidate))}
                                  </div>
                                </div>
                                <select
                                  value={draft.inspectionResult}
                                  disabled={runningActionId !== null}
                                  onChange={(event) =>
                                    updateReturnInspectionDraft(
                                      candidate.allocationId,
                                      "inspectionResult",
                                      event.target.value
                                    )
                                  }
                                  className="h-9 min-w-[148px] rounded-md border border-input bg-background px-3 text-sm"
                                >
                                  {returnInspectionResultOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {inspectionResultLabel(option.value)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="grid gap-2 md:grid-cols-3">
                                <label className="grid gap-1 text-xs">
                                  <span className="text-muted-foreground">{t("inspection.appearanceGrade")}</span>
                                  <input
                                    value={draft.appearanceGrade}
                                    disabled={runningActionId !== null}
                                    onChange={(event) =>
                                      updateReturnInspectionDraft(
                                        candidate.allocationId,
                                        "appearanceGrade",
                                        event.target.value
                                      )
                                    }
                                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                    placeholder={t("inspection.appearanceGradePlaceholder")}
                                  />
                                </label>
                                <label className="grid gap-1 text-xs">
                                  <span className="text-muted-foreground">{t("inspection.appearanceDefect")}</span>
                                  <input
                                    value={draft.appearanceDefect}
                                    disabled={runningActionId !== null}
                                    onChange={(event) =>
                                      updateReturnInspectionDraft(
                                        candidate.allocationId,
                                        "appearanceDefect",
                                        event.target.value
                                      )
                                    }
                                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                    placeholder={t("inspection.appearanceDefectPlaceholder")}
                                  />
                                </label>
                                <label className="grid gap-1 text-xs">
                                  <span className="text-muted-foreground">{t("inspection.functionDefect")}</span>
                                  <input
                                    value={draft.functionDefect}
                                    disabled={runningActionId !== null}
                                    onChange={(event) =>
                                      updateReturnInspectionDraft(
                                        candidate.allocationId,
                                        "functionDefect",
                                        event.target.value
                                      )
                                    }
                                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                    placeholder={t("inspection.functionDefectPlaceholder")}
                                  />
                                </label>
                              </div>
                              <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">{t("inspection.note")}</span>
                                <textarea
                                  value={draft.note}
                                  disabled={runningActionId !== null}
                                  onChange={(event) =>
                                    updateReturnInspectionDraft(
                                      candidate.allocationId,
                                      "note",
                                      event.target.value
                                    )
                                  }
                                  className="min-h-16 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
                                  placeholder={t("inspection.notePlaceholder")}
                                />
                              </label>
                              <div className="grid gap-2 border-t pt-3">
                                <div>
                                  <div className="text-xs font-semibold">{t("supplies.title")}</div>
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    {t("supplies.description")}
                                  </div>
                                </div>
                                {candidate.reusableSupplies?.length ? (
                                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                    {candidate.reusableSupplies.map((supply) => {
                                      const disabled =
                                        runningActionId !== null ||
                                        !supply.reusable ||
                                        supply.recovered;
                                      const checked =
                                        supply.reusable &&
                                        !supply.recovered &&
                                        draft.reusableSupplyConsumptionEventIds.includes(
                                          supply.consumptionEventId
                                        );

                                      return (
                                        <label
                                          key={supply.consumptionEventId}
                                          className="flex min-w-0 items-start gap-2 rounded-md border bg-background px-3 py-2 text-xs"
                                        >
                                          <input
                                            type="checkbox"
                                            className="mt-0.5 size-4 shrink-0"
                                            checked={checked}
                                            disabled={disabled}
                                            onChange={() =>
                                              toggleReusableSupply(
                                                candidate.allocationId,
                                                supply.consumptionEventId
                                              )
                                            }
                                          />
                                          <span className="min-w-0">
                                            <span className="block truncate font-medium">
                                              {supply.supplyName} {t("supplies.unit", { count: supply.quantity })}
                                            </span>
                                            <span className="block truncate text-muted-foreground">
                                              {!supply.reusable
                                                ? t("supplies.unavailable")
                                                : supply.recovered
                                                  ? t("supplies.recovered")
                                                  : t("supplies.recoverOnReturn")}
                                            </span>
                                          </span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
                                    {t("supplies.empty")}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-4">
                  <div className="text-xs text-muted-foreground">
                    {modalSelectionLocked
                      ? t("modal.footerLocked")
                      : modalCandidates.length === 0
                        ? t("modal.footerNoCandidate")
                        : t("modal.footerSelection")}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={runningActionId !== null}
                      onClick={requestActionModalClose}
                    >
                      {t("actions.cancel")}
                    </Button>
                    <Button
                      type="button"
                      disabled={!modalCanSubmit}
                      onClick={() =>
                        actionModalRow
                          ? void runReturnAction(
                              actionModalRow,
                              selectedAllocationIds,
                              modalRequiresReturnInspection
                                ? selectedReturnInspections
                                : []
                            )
                          : undefined
                      }
                    >
                      <CheckCircle2 className="size-4" />
                      {runningActionId === actionModalRow.id
                        ? t("actions.processing")
                        : returnActionLabel(actionModalRow.nextReturnAction)}
                    </Button>
                  </div>
                </div>
              </>
        ) : null}
      </DialogFrame>
    </WorkspacePageFrame>
  );
}
