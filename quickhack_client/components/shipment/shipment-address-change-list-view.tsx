"use client";

import * as React from "react";
import { AlertTriangle, RefreshCcw, X } from "lucide-react";
import { useUnsavedChanges } from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import {
  MasterDetailLayout,
  WorkspacePageFrame,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { statusBadge } from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  createOwnedRequestTargetSnapshot,
  useOwnedRequest,
} from "@/quickhack_client/hooks/use-owned-request";
import { InvoiceReplacementProgress } from "@/quickhack_client/components/invoice/invoice-replacement-progress";
import { invoiceReplacementFormIds } from "@/quickhack_client/components/invoice/invoice-operation-draft-state";
import { recoverCarrierRegistration } from "@/quickhack_client/components/invoice/invoice-replacement-recovery";
import type { InvoiceReplacement } from "@/quickhack_client/components/invoice/invoice-operation-types";
import {
  shipmentOutputFocusForReplacement,
  type ShipmentOutputFocus,
} from "@/quickhack_client/components/shipment/shipment-output-focus";

type ShipmentAddressChangeField = {
  fieldName: string;
  fieldLabel: string;
  beforeValue: string | null;
  afterValue: string | null;
};

type ShipmentAddressChangeRow = {
  id: number;
  changeStatus: string;
  changeStatusLabel: string;
  shipmentStage: string;
  shipmentStageLabel: string;
  allocationStatus: string | null;
  externalOrderId: string;
  externalShipmentId: string | null;
  channelStatus: string | null;
  orderedAt: string | null;
  detectedAt: string;
  pgNo: string | null;
  uniqueNo: string;
  model: string | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  inventoryStatus: string | null;
  inventoryStatusLabel: string;
  shipmentBatchText: string;
  receiverName: string;
  receiverSafeNumber: string;
  receiverAddress: string;
  shippingMemo: string;
  changedFieldsText: string;
  fields: ShipmentAddressChangeField[];
  packageGroupId: number | null;
  packageGroupStatus: string | null;
  currentCarrierShipmentId: number | null;
  currentTrackingNumber: string | null;
  currentShipmentStatus: string | null;
  replacementWorkId: number | null;
  replacementStatus: string | null;
  replacementStage: string | null;
  canStartReplacement: boolean;
  replacementBlockedReason: string | null;
};

type ShipmentAddressChangeApiResponse = {
  ok: boolean;
  message?: string;
  count?: number;
  summary?: {
    totalCount: number;
    filteredCount: number;
    returnedCount: number;
    pendingCount: number;
    confirmedCount: number;
    ignoredCount: number;
    failedCount: number;
  };
  items?: ShipmentAddressChangeRow[];
  nextCursor?: string | null;
  hasMore?: boolean;
};

type ColumnKey =
  | "changeStatus"
  | "changedFields"
  | "shipmentStage"
  | "channelStatus"
  | "shipmentBatch"
  | "pg"
  | "inventoryStatus"
  | "externalOrderId"
  | "receiver"
  | "address"
  | "shippingMemo"
  | "changeValues"
  | "detectedAt";

const numberFormatter = new Intl.NumberFormat("ko-KR");

function textOrDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();

  return text || "-";
}

function formatDateTime(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  return text ? text.replace("T", " ").slice(0, 19) : "-";
}

function statusVariant(value: string | null | undefined) {
  const status = String(value ?? "").toUpperCase();

  if (status === "PENDING") {
    return "warning" as const;
  }

  if (status === "CONFIRMED") {
    return "success" as const;
  }

  if (status === "FAILED") {
    return "danger" as const;
  }

  return "neutral" as const;
}

function stageVariant(value: string | null | undefined) {
  const stage = String(value ?? "").toUpperCase();

  if (stage === "AFTER_PRINT") {
    return "danger" as const;
  }

  if (stage === "BEFORE_PRINT") {
    return "warning" as const;
  }

  return "neutral" as const;
}

function receiverText(row: ShipmentAddressChangeRow) {
  const name = String(row.receiverName ?? "").trim();
  const phone = String(row.receiverSafeNumber ?? "").trim();

  if (!name && !phone) {
    return "-";
  }

  return [name, phone].filter(Boolean).join(" / ");
}

function pgText(row: ShipmentAddressChangeRow) {
  return [row.pgNo, row.uniqueNo].filter(Boolean).join("\n");
}

function deviceOptionText(row: ShipmentAddressChangeRow) {
  return [row.model, row.storage, row.color, row.saleGrade]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function changedValueText(row: ShipmentAddressChangeRow) {
  return row.fields
    .map((field) => {
      const before = textOrDash(field.beforeValue);
      const after = textOrDash(field.afterValue);

      return `${field.fieldLabel}: ${before} -> ${after}`;
    })
    .join("\n");
}

function MultiLineText({ value }: { value: string | null | undefined }) {
  return (
    <span className="whitespace-pre-line break-words leading-4">
      {textOrDash(value)}
    </span>
  );
}

function ChangeValueList({ row }: { row: ShipmentAddressChangeRow }) {
  if (row.fields.length === 0) {
    return <span>-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {row.fields.map((field) => (
        <div
          key={field.fieldName}
          className="grid min-w-0 grid-cols-[68px_minmax(0,1fr)] gap-2 text-[11px] leading-4"
        >
          <span className="font-medium text-muted-foreground">
            {field.fieldLabel}
          </span>
          <span className="min-w-0 break-words">
            {textOrDash(field.beforeValue)} -&gt; {textOrDash(field.afterValue)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ShipmentAddressChangeListView({
  canManage = false,
  onOpenSourceMenu,
  onOpenShipmentOutput,
}: {
  canManage?: boolean;
  onOpenSourceMenu?: (menuId: string, search?: string) => void;
  onOpenShipmentOutput?: (focus: ShipmentOutputFocus) => void;
}) {
  const [rows, setRows] = React.useState<ShipmentAddressChangeRow[]>([]);
  const [summary, setSummary] =
    React.useState<ShipmentAddressChangeApiResponse["summary"]>();
  const [isLoading, setIsLoading] = React.useState(true);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [listScope, setListScope] = React.useState<"ACTION_REQUIRED" | "ALL">(
    "ACTION_REQUIRED"
  );
  const [message, setMessage] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const selectedIdRef = React.useRef<number | null>(null);
  const [replacementBinding, setReplacementBinding] = React.useState<{
    addressChangeWorkId: number;
    packageGroupId: number;
    replacement: InvoiceReplacement;
  } | null>(null);
  const [isWorking, setIsWorking] = React.useState(false);
  const replacementRequests = useOwnedRequest();
  const { runGuardedAction } = useUnsavedChanges();
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const replacement =
    selected &&
    replacementBinding?.addressChangeWorkId === selected.id &&
    replacementBinding.packageGroupId === selected.packageGroupId &&
    replacementBinding.replacement.replacementWorkId === selected.replacementWorkId
      ? replacementBinding.replacement
      : null;
  const selectedOutputFocus = replacement
    ? shipmentOutputFocusForReplacement(
        replacement,
        "shipment-delivery-changes"
      )
    : null;

  const loadRows = React.useCallback(async (
    cursor: string | null = null,
    append = false
  ) => {
    if (append) setIsLoadingMore(true);
    else setIsLoading(true);
    setMessage("");

    try {
      const params = new URLSearchParams({ status: listScope, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/coupang/shipment-address-changes?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | ShipmentAddressChangeApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.message || "배송 정보 변경 건을 불러오지 못했습니다."
        );
      }

      const nextRows = payload.items ?? [];
      setRows((current) => append ? [...current, ...nextRows] : nextRows);
      setSummary(payload.summary);
      setNextCursor(payload.hasMore ? payload.nextCursor ?? null : null);
      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId =
        append ||
        (currentSelectedId &&
          nextRows.some((row) => row.id === currentSelectedId))
          ? currentSelectedId
          : null;
      selectedIdRef.current = nextSelectedId;
      setSelectedId(nextSelectedId);
    } catch (error) {
      if (!append) {
        setRows([]);
        setSummary(undefined);
        setNextCursor(null);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (append) setIsLoadingMore(false);
      else setIsLoading(false);
    }
  }, [listScope]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadRows();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadRows]);

  const loadReplacement = React.useCallback(
    async (replacementWorkId: number, signal?: AbortSignal) => {
      const response = await fetch(
        `/api/invoices/replacements/${replacementWorkId}`,
        { cache: "no-store", signal }
      );
      const payload = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            message?: string;
            replacement?: InvoiceReplacement;
          }
        | null;
      if (!response.ok || !payload?.ok || !payload.replacement) {
        throw new Error(payload?.message || "송장 재발급 상태를 불러오지 못했습니다.");
      }
      return payload.replacement;
    },
    []
  );

  const loadOwnedReplacement = React.useCallback(
    async (row: ShipmentAddressChangeRow, replacementWorkId: number) => {
      if (!row.packageGroupId) return null;
      const request = replacementRequests.begin(
        createOwnedRequestTargetSnapshot({
          targetId: row.id,
          queryKey: `replacement:${replacementWorkId}`,
          revision: row.packageGroupId,
        })
      );
      const loaded = await loadReplacement(replacementWorkId, request.signal);
      if (
        loaded.replacementWorkId !== replacementWorkId ||
        loaded.packageGroupId !== row.packageGroupId ||
        loaded.shipmentAddressChangeWorkId !== row.id
      ) {
        throw new Error("선택한 배송지 변경 건과 송장 교체 작업이 일치하지 않습니다.");
      }
      request.commit(() =>
        setReplacementBinding({
          addressChangeWorkId: row.id,
          packageGroupId: row.packageGroupId!,
          replacement: loaded,
        })
      );
      return loaded;
    },
    [loadReplacement, replacementRequests]
  );

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      setReplacementBinding(null);
      if (!canManage || !selected?.replacementWorkId) return;
      void loadOwnedReplacement(selected, selected.replacementWorkId).catch(
        (error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setMessage(error instanceof Error ? error.message : String(error));
        }
      );
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [canManage, loadOwnedReplacement, selected]);

  React.useEffect(() => {
    if (
      !replacement ||
      ["COMPLETED", "CANCELED", "FAILED"].includes(replacement.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!selected) return;
      void loadOwnedReplacement(selected, replacement.replacementWorkId).catch(
        () => undefined
      );
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadOwnedReplacement, replacement, selected]);

  async function startReplacement() {
    if (!canManage || !selected?.packageGroupId) return;
    setIsWorking(true);
    setMessage("");
    try {
      const response = await fetch("/api/invoices/replacements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packageGroupId: selected.packageGroupId,
          sourceType: "ADDRESS_CHANGE",
          shipmentAddressChangeWorkId: selected.id,
          reasonCode: "COUPANG_ADDRESS_CHANGED_AFTER_PRINT",
          reasonNote: `배송정보 변경 감지 #${selected.id}`,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            message?: string;
            replacement?: InvoiceReplacement;
          }
        | null;
      if (!response.ok || !payload?.ok || !payload.replacement) {
        throw new Error(payload?.message || "송장 재발급을 시작하지 못했습니다.");
      }
      if (
        selectedIdRef.current !== selected.id ||
        payload.replacement.packageGroupId !== selected.packageGroupId ||
        payload.replacement.shipmentAddressChangeWorkId !== selected.id
      ) {
        throw new Error("선택한 배송지 변경 건과 생성된 송장 교체 작업이 일치하지 않습니다.");
      }
      setReplacementBinding({
        addressChangeWorkId: selected.id,
        packageGroupId: selected.packageGroupId,
        replacement: payload.replacement,
      });
      setMessage(
        "송장 재발급을 시작했습니다. 오른쪽 진행 단계에서 현재 상태와 다음 할 일을 확인하세요."
      );
      await loadRows();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function runReplacementAction(action: string, note?: string) {
    if (!replacement) return false;
    setIsWorking(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/invoices/replacements/${replacement.replacementWorkId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, note }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            message?: string;
            replacement?: InvoiceReplacement;
          }
        | null;
      if (!response.ok || !payload?.ok || !payload.replacement) {
        throw new Error(payload?.message || "송장 재발급을 진행하지 못했습니다.");
      }
      if (
        selectedIdRef.current !== selected?.id ||
        !selected ||
        payload.replacement.packageGroupId !== selected.packageGroupId ||
        payload.replacement.shipmentAddressChangeWorkId !== selected.id ||
        payload.replacement.replacementWorkId !== replacement.replacementWorkId
      ) {
        throw new Error("선택한 배송지 변경 건과 처리 결과가 일치하지 않습니다.");
      }
      setReplacementBinding({
        addressChangeWorkId: selected.id,
        packageGroupId: selected.packageGroupId!,
        replacement: payload.replacement,
      });
      setMessage(
        action === "cancel"
          ? "송장 재발급을 취소하고 기존 송장을 유지했습니다."
          : "처리 결과를 저장하고 다음 단계를 이어서 확인했습니다."
      );
      await loadRows();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setIsWorking(false);
    }
  }

  function requestSelectRow(nextId: number | null) {
    if (nextId === selectedId) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: invoiceReplacementFormIds(
        replacement?.replacementWorkId ?? selected?.replacementWorkId
      ),
      targetLabel: nextId ? "다른 배송정보 변경 건" : "배송정보 변경 상세 닫기",
      action: () => {
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
      },
    });
  }

  function requestLoadRows() {
    runGuardedAction({
      intent: "internal-change",
      formIds: invoiceReplacementFormIds(
        replacement?.replacementWorkId ?? selected?.replacementWorkId
      ),
      targetLabel: "배송정보 변경 목록 새로고침",
      action: () => void loadRows(),
    });
  }

  function requestScopeChange(nextScope: "ACTION_REQUIRED" | "ALL") {
    if (nextScope === listScope) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: invoiceReplacementFormIds(
        replacement?.replacementWorkId ?? selected?.replacementWorkId
      ),
      targetLabel: "배송정보 변경 목록 범위 변경",
      action: () => {
        replacementRequests.dispose();
        setReplacementBinding(null);
        selectedIdRef.current = null;
        setSelectedId(null);
        setRows([]);
        setNextCursor(null);
        setListScope(nextScope);
      },
    });
  }

  async function runCarrierRegistrationRecovery() {
    if (!replacement) return;
    setIsWorking(true);
    setMessage("");
    try {
      setMessage(await recoverCarrierRegistration(replacement));
      if (selected) {
        await loadOwnedReplacement(selected, replacement.replacementWorkId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsWorking(false);
    }
  }

  const columns = React.useMemo<
    DataGridColumn<ColumnKey, ShipmentAddressChangeRow>[]
  >(
    () => [
      {
        key: "changeStatus",
        label: "처리상태",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.changeStatusLabel,
        render: (row) => (
          <Badge variant={statusVariant(row.changeStatus)}>
            {row.changeStatusLabel}
          </Badge>
        ),
      },
      {
        key: "changedFields",
        label: "변경항목",
        width: "160px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.changedFieldsText,
        render: (row) => (
          <span className="line-clamp-2 break-words">
            {textOrDash(row.changedFieldsText)}
          </span>
        ),
      },
      {
        key: "shipmentStage",
        label: "감지단계",
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.shipmentStageLabel,
        render: (row) => (
          <Badge variant={stageVariant(row.shipmentStage)}>
            {row.shipmentStageLabel}
          </Badge>
        ),
      },
      {
        key: "channelStatus",
        label: "주문상태",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.channelStatus,
        render: (row) => statusBadge(row.channelStatus ?? ""),
      },
      {
        key: "shipmentBatch",
        label: "출고차수",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.shipmentBatchText,
        render: (row) => <MultiLineText value={row.shipmentBatchText} />,
      },
      {
        key: "pg",
        label: "PG",
        width: "160px",
        cellClassName: "flex min-w-0 flex-col justify-center px-3 font-mono text-xs",
        text: pgText,
        render: (row) => (
          <>
            <MultiLineText value={pgText(row)} />
            {deviceOptionText(row) ? (
              <span className="mt-1 truncate text-[11px] text-muted-foreground">
                {deviceOptionText(row)}
              </span>
            ) : null}
          </>
        ),
      },
      {
        key: "inventoryStatus",
        label: "재고상태",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.inventoryStatusLabel,
        render: (row) => (
          <Badge variant="secondary">{textOrDash(row.inventoryStatusLabel)}</Badge>
        ),
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
        key: "receiver",
        label: "수취인",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: receiverText,
        render: (row) => (
          <span className="line-clamp-2 break-words">{receiverText(row)}</span>
        ),
      },
      {
        key: "address",
        label: "현재 주소",
        width: "minmax(300px,1.2fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => (
          <span className="line-clamp-2 break-words">
            {textOrDash(row.receiverAddress)}
          </span>
        ),
      },
      {
        key: "shippingMemo",
        label: "배송메모",
        width: "220px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.shippingMemo,
        render: (row) => (
          <span className="line-clamp-2 break-words">
            {textOrDash(row.shippingMemo)}
          </span>
        ),
      },
      {
        key: "changeValues",
        label: "변경 전후",
        width: "minmax(360px,1.4fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: changedValueText,
        render: (row) => <ChangeValueList row={row} />,
      },
      {
        key: "detectedAt",
        label: "감지일시",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => formatDateTime(row.detectedAt),
        render: (row) => (
          <span className="truncate">{formatDateTime(row.detectedAt)}</span>
        ),
      },
    ],
    []
  );

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">배송 정보 변경 건 조회</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            전체 {numberFormatter.format(summary?.totalCount ?? 0)}건 / 처리 필요{" "}
            {numberFormatter.format(
              (summary?.pendingCount ?? 0) + (summary?.failedCount ?? 0)
            )}건 / 현재 범위 {numberFormatter.format(summary?.filteredCount ?? 0)}건 / 표시{" "}
            {numberFormatter.format(rows.length)}건
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={listScope === "ACTION_REQUIRED" ? "default" : "outline"}
            onClick={() => requestScopeChange("ACTION_REQUIRED")}
          >
            처리 필요
          </Button>
          <Button
            variant={listScope === "ALL" ? "default" : "outline"}
            onClick={() => requestScopeChange("ALL")}
          >
            전체 이력
          </Button>
          {nextCursor ? (
            <Button
              variant="outline"
              onClick={() => void loadRows(nextCursor, true)}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? "불러오는 중" : "더 보기"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={requestLoadRows}
            disabled={isLoading}
          >
            <RefreshCcw className="size-4" />
            목록 새로고침
          </Button>
        </div>
      </div>

      {message ? (
        <FeedbackBanner tone="warning" className="mb-3">
          {message}
        </FeedbackBanner>
      ) : null}

      <MasterDetailLayout
        className={
          selected
            ? "gap-3 xl:grid-cols-[minmax(0,1fr)_470px]"
            : "flex"
        }
      >
        <VirtualizedDataGrid
          rows={rows}
          columns={columns}
          rowKey={(row) => row.id}
          selectedRowKey={selectedId}
          onRowClick={(row) => requestSelectRow(row.id)}
          emptyMessage={
            isLoading
              ? "배송 정보 변경 건을 불러오는 중입니다."
              : "배송 정보 변경 건이 없습니다."
          }
          minWidth="2260px"
          rowHeight={74}
        />

        {selected ? (
          <aside className="min-h-0 overflow-auto rounded-md border bg-background">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">
                  배송정보 변경 #{selected.id}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  주문 {selected.externalOrderId} · 그룹 #
                  {selected.packageGroupId ?? "-"}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => requestSelectRow(null)}
                aria-label="상세 닫기"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="space-y-4 p-4">
              <div className="rounded-md border p-3 text-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold">변경 내용</span>
                  <Badge variant={stageVariant(selected.shipmentStage)}>
                    {selected.shipmentStageLabel}
                  </Badge>
                </div>
                <ChangeValueList row={selected} />
              </div>

              {replacement ? (
                <InvoiceReplacementProgress
                  key={replacement.replacementWorkId}
                  replacement={replacement}
                  busy={isWorking}
                  compact
                  onRefresh={() =>
                    selected
                      ? void loadOwnedReplacement(
                          selected,
                          replacement.replacementWorkId
                        )
                      : undefined
                  }
                  onAction={runReplacementAction}
                  onOpenChannelRecovery={
                    onOpenSourceMenu
                      ? () =>
                          onOpenSourceMenu(
                            "invoice-registration-failures",
                            replacement.candidateTrackingNumber ??
                              replacement.oldTrackingNumber
                          )
                      : undefined
                  }
                  onOpenShipmentOutput={
                    onOpenShipmentOutput && selectedOutputFocus
                      ? () => onOpenShipmentOutput(selectedOutputFocus)
                      : undefined
                  }
                  onRecoverCarrierRegistration={() =>
                    void runCarrierRegistrationRecovery()
                  }
                />
              ) : selected.replacementWorkId && !canManage ? (
                <div className="rounded-md border bg-muted/30 p-4 text-xs">
                  <div className="font-semibold">송장 재발급 진행 중</div>
                  <p className="mt-1 text-muted-foreground">
                    {selected.replacementStatus ?? "PROCESSING"} ·{" "}
                    {selected.replacementStage ?? "상태 확인 중"}
                  </p>
                  <p className="mt-2 leading-5 text-muted-foreground">
                    상세 진행 확인과 관리자 판정은 송장 관리 권한이 있는
                    사용자만 수행할 수 있습니다.
                  </p>
                </div>
              ) : selected.canStartReplacement && canManage ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
                  <div className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-800" />
                    <div>
                      <div className="text-sm font-semibold text-amber-900">
                        기존 송장에 이전 배송지가 남아 있습니다
                      </div>
                      <p className="mt-1 text-xs leading-5 text-amber-800">
                        최신 쿠팡 주문을 다시 확인하고 합포장 구성원 전체가 같은
                        배송지일 때만 새 송장을 후보로 채번합니다. 쿠팡 반영 전에는
                        현재 송장을 바꾸지 않습니다.
                      </p>
                    </div>
                  </div>
                  <Button
                    className="mt-3 w-full"
                    disabled={isWorking}
                    onClick={() => void startReplacement()}
                  >
                    안전한 송장 재발급 시작
                  </Button>
                </div>
              ) : selected.canStartReplacement ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                  배송정보 변경으로 송장 재발급이 필요합니다. 송장 관리 권한이
                  있는 관리자에게 처리를 요청하세요.
                </div>
              ) : (
                <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
                  <div className="font-semibold text-foreground">
                    자동 재발급을 시작할 수 없습니다
                  </div>
                  <p className="mt-1 leading-5">
                    {selected.replacementBlockedReason ??
                      "현재 출고 상태와 송장 정보를 확인하세요."}
                  </p>
                </div>
              )}

              <div className="rounded-md border p-3 text-xs">
                <div className="mb-2 font-semibold">현재 송장</div>
                <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">송장번호</span>
                  <span className="font-mono">
                    {selected.currentTrackingNumber ?? "-"}
                  </span>
                  <span className="text-muted-foreground">택배 상태</span>
                  <span>{selected.currentShipmentStatus ?? "-"}</span>
                  <span className="text-muted-foreground">그룹 상태</span>
                  <span>{selected.packageGroupStatus ?? "-"}</span>
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
