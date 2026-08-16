"use client";

import * as React from "react";
import { CheckCircle2, RefreshCcw, ShieldAlert } from "lucide-react";
import {
  useGuardedDialogClose,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { statusMap } from "@/quickhack_client/components/shared/device-detail-sheet";
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
import { inventoryStatusLabel } from "@/quickhack_shared/inventory/inventory-status";

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
  nextReturnActionLabel?: string | null;
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
  message?: string;
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

const phaseConfig = {
  before: {
    title: "출고 전 반품목록",
    empty: "출고 전 기준에 해당하는 쿠팡 반품 접수 데이터가 없습니다.",
    loading: "출고 전 반품목록을 불러오는 중입니다.",
  },
  after: {
    title: "출고 후 반품목록",
    empty: "출고 후 기준에 해당하는 쿠팡 반품 접수 데이터가 없습니다.",
    loading: "출고 후 반품목록을 불러오는 중입니다.",
  },
} satisfies Record<
  ReturnListPhase,
  { title: string; empty: string; loading: string }
>;

const receiptStatusLabels: Record<string, string> = {
  RU: "출고중지 요청",
  UC: "반품접수",
  CC: "반품완료",
  PR: "쿠팡 확인 요청",
  RELEASE_STOP_UNCHECKED: "출고중지 요청",
  RETURNS_UNCHECKED: "반품접수",
  VENDOR_WAREHOUSE_CONFIRM: "입고 확인",
  REQUEST_COUPANG_CHECK: "쿠팡 확인 요청",
  RETURNS_COMPLETED: "반품완료",
};

const returnInspectionResultOptions = [
  { value: "PASSED", label: "재판매 가능" },
  { value: "FAILED", label: "불량" },
  { value: "HOLD", label: "보류" },
  { value: "RETURN_TO_SUPPLIER", label: "매입처 반품" },
  { value: "DISPOSAL", label: "폐기" },
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

function mappedLabel(
  labels: Record<string, string>,
  value: string | null | undefined
) {
  const key = String(value ?? "").trim();
  return key ? labels[key] ?? key : "-";
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

function deviceSummary(candidate: ReturnAllocationCandidate) {
  return [
    candidate.model,
    candidate.modelSeq ? `${candidate.modelSeq}번` : "",
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
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs text-muted-foreground">
      {label}
      <strong className="font-semibold text-foreground">
        {numberOrZero(value).toLocaleString("ko-KR")}
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
  const statuses = splitLines(value);

  if (statuses.length === 0) {
    return <span>-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 leading-4">
      {statuses.map((status, index) => {
        const mapped = statusMap[status];
        const label = mapped?.label ?? inventoryStatusLabel(status);

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
    targetLabel: "반품 처리",
    onClose: closeActionModalImmediately,
  });

  useUnsavedForm({
    id: actionDraftFormId,
    label: "반품 처리 입력",
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
        throw new Error(payload?.message || "반품 목록을 불러오지 못했습니다.");
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
  }, [phase]);

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
          | (ReturnListApiResponse & { actionLabel?: string })
          | null;

        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.message || "반품 처리를 완료하지 못했습니다.");
        }

        await loadRows();
        setMessage(payload.message || "반품 처리가 완료되었습니다.");
        setMessageTone(payload.reviewRequired ? "warning" : "info");
        closeActionModalImmediately();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        setMessageTone("warning");
      } finally {
        setRunningActionId(null);
      }
    },
    [closeActionModalImmediately, loadRows]
  );

  const columns = React.useMemo<
    DataGridColumn<ReturnColumnKey, ReturnListRow>[]
  >(
    () => [
      {
        key: "action",
        label: "처리",
        width: "124px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.nextReturnActionLabel,
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
                API 확인 필요
              </Button>
            );
          }

          const disabled =
            isLoading ||
            runningActionId !== null ||
            !row.nextReturnAction;

          if (!row.nextReturnActionLabel) {
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
              {runningActionId === row.id ? "처리중" : row.nextReturnActionLabel}
            </Button>
          );
        },
      },
      {
        key: "receiptStatus",
        label: "접수상태",
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => mappedLabel(receiptStatusLabels, row.receiptStatus),
        render: (row) => (
          <Badge variant={statusVariant(row.receiptStatus)}>
            {mappedLabel(receiptStatusLabels, row.receiptStatus)}
          </Badge>
        ),
      },
      {
        key: "inventoryStatus",
        label: "재고상태",
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => lineText(row.inventoryStatusText),
        render: (row) => (
          <InventoryStatusBadgeList value={row.inventoryStatusText} />
        ),
      },
      {
        key: "shipmentBatch",
        label: "출고 차수",
        width: "170px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => lineText(row.shipmentBatchText),
        render: (row) => <LineList value={row.shipmentBatchText} />,
      },
      {
        key: "externalOrderId",
        label: "주문번호",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.externalOrderId,
        render: (row) => (
          <span className="truncate">{textOrDash(row.externalOrderId)}</span>
        ),
      },
      {
        key: "product",
        label: "상품",
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
        label: "수취인",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: receiverText,
        render: (row) => <span className="truncate">{receiverText(row)}</span>,
      },
      {
        key: "receiverAddress",
        label: "주소",
        width: "minmax(280px, 1fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => (
          <span className="truncate">{textOrDash(row.receiverAddress)}</span>
        ),
      },
      {
        key: "orderedAt",
        label: "주문일시",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.orderedAt,
        render: (row) => (
          <span className="truncate">{formatDateTime(row.orderedAt)}</span>
        ),
      },
      {
        key: "reason1",
        label: "사유 1",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.reason1,
        render: (row) => <span className="truncate">{textOrDash(row.reason1)}</span>,
      },
      {
        key: "reason2",
        label: "사유 2",
        width: "170px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.reason2,
        render: (row) => <span className="truncate">{textOrDash(row.reason2)}</span>,
      },
      {
        key: "reason3",
        label: "사유 3",
        width: "180px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.reason3,
        render: (row) => <span className="truncate">{textOrDash(row.reason3)}</span>,
      },
    ],
    [isLoading, onOpenWriteReview, openActionModal, runningActionId]
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
          <h2 className="text-sm font-semibold">{phaseConfig[phase].title}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <SummaryPill label="접수" value={summary.returnCount} />
            <SummaryPill label="연결주문" value={summary.linkedOrderCount} />
            <SummaryPill label="연결출고" value={summary.linkedShipmentCount} />
            <SummaryPill label="출고 전" value={summary.beforeShipmentCount} />
            <SummaryPill label="출고 후" value={summary.afterShipmentCount} />
            <SummaryPill label="상태확인" value={summary.orderStatusCheckCount} />
            <SummaryPill label="매칭PG" value={summary.matchedDeviceCount} />
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadRows()}
          disabled={isLoading}
        >
          <RefreshCcw className="size-4" />
          목록 새로고침
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
        emptyMessage={isLoading ? phaseConfig[phase].loading : phaseConfig[phase].empty}
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
            {isLoading ? "불러오는 중" : "다음 반품 더 보기"}
          </Button>
        </div>
      ) : null}

      {summaryCoverage === "PAGE" ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          접수 건수는 전체 대상 기준이며, 나머지 연결 요약은 현재 불러온 페이지 기준입니다.
        </p>
      ) : null}

      <DialogFrame
        open={Boolean(actionModalRow)}
        onOpenChange={(open) => {
          if (!open) {
            requestActionModalClose();
          }
        }}
        title="반품 PG 선택"
        description={`연결 가능한 PG를 선택한 뒤 ${actionModalRow?.nextReturnActionLabel ?? "처리"}합니다.`}
        closeDisabled={runningActionId !== null}
        overlayClassName="z-40"
        contentClassName="z-50 max-h-[86vh] w-[min(1040px,calc(100vw-32px))] shadow-lg"
        bodyClassName="contents"
      >
        {actionModalRow ? (
              <>
                <div className="grid shrink-0 gap-2 border-b bg-secondary/35 px-5 py-3 text-xs md:grid-cols-4">
                  <div>
                    <span className="text-muted-foreground">주문번호</span>
                    <div className="mt-1 font-mono font-medium">
                      {textOrDash(actionModalRow.externalOrderId)}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">접수번호</span>
                    <div className="mt-1 font-mono font-medium">
                      {textOrDash(actionModalRow.externalReceiptId)}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">반품 수량</span>
                    <div className="mt-1 font-medium">
                      {modalCancelCount.toLocaleString("ko-KR")}대
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">PG 연결</span>
                    <div
                      className={
                        selectedAllocationIds.length === modalRequiredCount
                          ? "mt-1 font-medium text-emerald-700"
                          : "mt-1 font-medium text-amber-700"
                      }
                    >
                      {selectedAllocationIds.length.toLocaleString("ko-KR")} / {modalRequiredCount.toLocaleString("ko-KR")}
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
                              배송 {requirement.externalShipmentId} · 상품 {requirement.externalVendorItemId}
                              {requirement.vendorItemName ? ` · ${requirement.vendorItemName}` : ""}
                            </span>
                            <span className={selectedCount === requirement.selectableQuantity ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>
                              {selectedCount} / {requirement.selectableQuantity} 선택
                              {requirement.missingQuantity > 0 ? ` · 연결 부족 ${requirement.missingQuantity}` : ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {modalCandidates.length === 0 ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      이 반품 접수와 연결할 수 있는 매칭 PG가 없습니다. 쿠팡 반품 처리는 PG 연결 없이 진행됩니다.
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
                                {inventoryStatusLabel(candidate.inventoryStatus)}
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
                                {textOrDash(deviceSummary(candidate))}
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
                                {textOrDash(candidate.allocationStatus)}
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
                        <div className="text-sm font-semibold">반품검수 입력</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          반품 완료 처리와 함께 선택한 PG별 검수 결과를 기록합니다.
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
                                    {textOrDash(deviceSummary(candidate))} / {textOrDash(gradeSummary(candidate))}
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
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="grid gap-2 md:grid-cols-3">
                                <label className="grid gap-1 text-xs">
                                  <span className="text-muted-foreground">외관 등급</span>
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
                                    placeholder="예: A, B, 파손"
                                  />
                                </label>
                                <label className="grid gap-1 text-xs">
                                  <span className="text-muted-foreground">외관 이상</span>
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
                                    placeholder="예: 액정 찍힘"
                                  />
                                </label>
                                <label className="grid gap-1 text-xs">
                                  <span className="text-muted-foreground">기능 이상</span>
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
                                    placeholder="예: 충전 불량"
                                  />
                                </label>
                              </div>
                              <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">검수 메모</span>
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
                                  placeholder="포장 상태, 누락 구성품, 재판매 판단 근거"
                                />
                              </label>
                              <div className="grid gap-2 border-t pt-3">
                                <div>
                                  <div className="text-xs font-semibold">회수 비품</div>
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    실제 출고 때 차감된 비품 중 다시 사용할 수 있는 품목만 선택합니다.
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
                                              {supply.supplyName} {supply.quantity}개
                                            </span>
                                            <span className="block truncate text-muted-foreground">
                                              {!supply.reusable
                                                ? "재사용 불가"
                                                : supply.recovered
                                                  ? "복구 완료"
                                                  : "회수 시 재고 복구"}
                                            </span>
                                          </span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
                                    해당 출고에서 차감된 비품 이력이 없습니다.
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
                      ? "반품 완료는 입고 확인 때 연결한 PG와 동일한 PG로만 처리됩니다."
                      : modalCandidates.length === 0
                        ? "매칭 PG가 없는 주문은 PG 연결 없이 쿠팡 처리만 진행합니다."
                        : "PG 연결 수량이 가능한 PG 수량과 일치해야 쿠팡 처리 버튼이 활성화됩니다."}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={runningActionId !== null}
                      onClick={requestActionModalClose}
                    >
                      취소
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
                        ? "처리중"
                        : actionModalRow.nextReturnActionLabel}
                    </Button>
                  </div>
                </div>
              </>
        ) : null}
      </DialogFrame>
    </WorkspacePageFrame>
  );
}
