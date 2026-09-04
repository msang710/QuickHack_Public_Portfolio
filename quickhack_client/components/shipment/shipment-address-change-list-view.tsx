"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
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
import { statusBadge, statusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  createOwnedRequestTargetSnapshot,
  useOwnedRequest,
} from "@/quickhack_client/hooks/use-owned-request";
import { InvoiceReplacementProgress } from "@/quickhack_client/components/invoice/invoice-replacement-progress";
import { useInvoiceReplacementPresentation } from "@/quickhack_client/components/invoice/invoice-replacement-presentation";
import { packageGroupStatusLabel } from "@/quickhack_client/components/shipment/package-group-status-presentation";
import { invoiceReplacementFormIds } from "@/quickhack_client/components/invoice/invoice-operation-draft-state";
import { recoverCarrierRegistration } from "@/quickhack_client/components/invoice/invoice-replacement-recovery";
import type { InvoiceReplacement } from "@/quickhack_client/components/invoice/invoice-operation-types";
import {
  shipmentOutputFocusForReplacement,
  type ShipmentOutputFocus,
} from "@/quickhack_client/components/shipment/shipment-output-focus";

type ShipmentAddressChangeField = {
  fieldName: string;
  beforeValue: string | null;
  afterValue: string | null;
};

type ShipmentAddressChangeRow = {
  id: number;
  changeStatus: string;
  shipmentStage: string;
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
  shipmentBatchText: string;
  receiverName: string;
  receiverSafeNumber: string;
  receiverAddress: string;
  shippingMemo: string;
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

function changedValueText(row: ShipmentAddressChangeRow, fieldLabel: (value: string) => string) {
  return row.fields
    .map((field) => {
      const before = textOrDash(field.beforeValue);
      const after = textOrDash(field.afterValue);

      return `${fieldLabel(field.fieldName)}: ${before} -> ${after}`;
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

function ChangeValueList({ row, fieldLabel }: { row: ShipmentAddressChangeRow; fieldLabel: (value: string) => string }) {
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
            {fieldLabel(field.fieldName)}
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
  const t = useTranslations("shipment.addressChange");
  const packageStatusT = useTranslations("shipment.packageGroupStatus");
  const replacementPresentation = useInvoiceReplacementPresentation();
  const changeStatusLabel = React.useCallback((value: string) => {
    if (value === "PENDING") return t("presentation.changeStatus.pending");
    if (value === "CONFIRMED") return t("presentation.changeStatus.confirmed");
    if (value === "IGNORED") return t("presentation.changeStatus.ignored");
    if (value === "FAILED") return t("presentation.changeStatus.failed");
    return value || "-";
  }, [t]);
  const shipmentStageLabel = React.useCallback((value: string) => {
    if (value === "AFTER_PRINT") return t("presentation.stage.afterPrint");
    if (value === "BEFORE_PRINT") return t("presentation.stage.beforePrint");
    if (value === "UNMATCHED") return t("presentation.stage.unmatched");
    if (value === "AFTER_SHIPMENT") return t("presentation.stage.afterShipment");
    return t("presentation.stage.unknown");
  }, [t]);
  const fieldLabel = React.useCallback((value: string) => {
    if (value === "receiver_name") return t("presentation.field.receiverName");
    if (value === "receiver_safe_number") return t("presentation.field.receiverPhone");
    if (value === "receiver_address_1") return t("presentation.field.address1");
    if (value === "receiver_address_2") return t("presentation.field.address2");
    if (value === "receiver_post_code") return t("presentation.field.postCode");
    if (value === "shipping_memo") return t("presentation.field.shippingMemo");
    return value;
  }, [t]);
  const detailT = useTranslations("common.deviceDetail");
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
        "shipment-delivery-changes",
        t("outputBatchLabel", {
          id: replacement.shipmentListPrintBatchId ?? 0,
        })
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
          legacyApiMessage(payload, t("message.loadFailed"))
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
  }, [listScope, t]);

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
        throw new Error(legacyApiMessage(payload, t("message.replacementLoadFailed")));
      }
      return payload.replacement;
    },
    [t]
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
        throw new Error(t("message.replacementMismatch"));
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
    [loadReplacement, replacementRequests, t]
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
        throw new Error(legacyApiMessage(payload, t("message.replacementStartFailed")));
      }
      if (
        selectedIdRef.current !== selected.id ||
        payload.replacement.packageGroupId !== selected.packageGroupId ||
        payload.replacement.shipmentAddressChangeWorkId !== selected.id
      ) {
        throw new Error(t("message.replacementCreatedMismatch"));
      }
      setReplacementBinding({
        addressChangeWorkId: selected.id,
        packageGroupId: selected.packageGroupId,
        replacement: payload.replacement,
      });
      setMessage(t("message.replacementStarted"));
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
        throw new Error(legacyApiMessage(payload, t("message.replacementActionFailed")));
      }
      if (
        selectedIdRef.current !== selected?.id ||
        !selected ||
        payload.replacement.packageGroupId !== selected.packageGroupId ||
        payload.replacement.shipmentAddressChangeWorkId !== selected.id ||
        payload.replacement.replacementWorkId !== replacement.replacementWorkId
      ) {
        throw new Error(t("message.replacementResultMismatch"));
      }
      setReplacementBinding({
        addressChangeWorkId: selected.id,
        packageGroupId: selected.packageGroupId!,
        replacement: payload.replacement,
      });
      setMessage(
        action === "cancel"
          ? t("message.replacementCanceled")
          : t("message.replacementActionSaved")
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
      targetLabel: nextId
        ? t("unsaved.anotherChange")
        : t("unsaved.closeDetail"),
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
      targetLabel: t("unsaved.refreshList"),
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
      targetLabel: t("unsaved.changeScope"),
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
      setMessage(
        await recoverCarrierRegistration(replacement, (key) =>
          t(`recovery.${key}`)
        )
      );
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
        label: t("columns.changeStatus"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => changeStatusLabel(row.changeStatus),
        render: (row) => (
          <Badge variant={statusVariant(row.changeStatus)}>
            {changeStatusLabel(row.changeStatus)}
          </Badge>
        ),
      },
      {
        key: "changedFields",
        label: t("columns.changedFields"),
        width: "160px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.fields.map((field) => fieldLabel(field.fieldName)).join(", "),
        render: (row) => (
          <span className="line-clamp-2 break-words">
            {textOrDash(row.fields.map((field) => fieldLabel(field.fieldName)).join(", "))}
          </span>
        ),
      },
      {
        key: "shipmentStage",
        label: t("columns.shipmentStage"),
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => shipmentStageLabel(row.shipmentStage),
        render: (row) => (
          <Badge variant={stageVariant(row.shipmentStage)}>
            {shipmentStageLabel(row.shipmentStage)}
          </Badge>
        ),
      },
      {
        key: "channelStatus",
        label: t("columns.channelStatus"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.channelStatus,
        render: (row) => statusBadge(row.channelStatus ?? "", detailT),
      },
      {
        key: "shipmentBatch",
        label: t("columns.shipmentBatch"),
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
        label: t("columns.inventoryStatus"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => statusLabel(row.inventoryStatus ?? "", detailT),
        render: (row) => (
          <Badge variant="secondary">{textOrDash(statusLabel(row.inventoryStatus ?? "", detailT))}</Badge>
        ),
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
        key: "receiver",
        label: t("columns.receiver"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: receiverText,
        render: (row) => (
          <span className="line-clamp-2 break-words">{receiverText(row)}</span>
        ),
      },
      {
        key: "address",
        label: t("columns.address"),
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
        label: t("columns.shippingMemo"),
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
        label: t("columns.changeValues"),
        width: "minmax(360px,1.4fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => changedValueText(row, fieldLabel),
        render: (row) => <ChangeValueList row={row} fieldLabel={fieldLabel} />,
      },
      {
        key: "detectedAt",
        label: t("columns.detectedAt"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => formatDateTime(row.detectedAt),
        render: (row) => (
          <span className="truncate">{formatDateTime(row.detectedAt)}</span>
        ),
      },
    ],
    [changeStatusLabel, detailT, fieldLabel, shipmentStageLabel, t]
  );

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("summary", {
              filtered: summary?.filteredCount ?? 0,
              required:
                (summary?.pendingCount ?? 0) + (summary?.failedCount ?? 0),
              total: summary?.totalCount ?? 0,
              visible: rows.length,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={listScope === "ACTION_REQUIRED" ? "default" : "outline"}
            onClick={() => requestScopeChange("ACTION_REQUIRED")}
          >
            {t("actions.actionRequired")}
          </Button>
          <Button
            variant={listScope === "ALL" ? "default" : "outline"}
            onClick={() => requestScopeChange("ALL")}
          >
            {t("actions.allHistory")}
          </Button>
          {nextCursor ? (
            <Button
              variant="outline"
              onClick={() => void loadRows(nextCursor, true)}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? t("actions.loading") : t("actions.loadMore")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={requestLoadRows}
            disabled={isLoading}
          >
            <RefreshCcw className="size-4" />
            {t("actions.refresh")}
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
              ? t("loading")
              : t("empty")
          }
          minWidth="2260px"
          rowHeight={74}
        />

        {selected ? (
          <aside className="min-h-0 overflow-auto rounded-md border bg-background">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">
                  {t("detail.title", { id: selected.id })}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("detail.orderSummary", {
                    group:
                      selected.packageGroupId === null
                        ? "-"
                        : String(selected.packageGroupId),
                    orderId: selected.externalOrderId,
                  })}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => requestSelectRow(null)}
                aria-label={t("actions.close")}
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="space-y-4 p-4">
              <div className="rounded-md border p-3 text-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold">{t("detail.change")}</span>
                  <Badge variant={stageVariant(selected.shipmentStage)}>
                    {shipmentStageLabel(selected.shipmentStage)}
                  </Badge>
                </div>
                <ChangeValueList row={selected} fieldLabel={fieldLabel} />
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
                  <div className="font-semibold">{t("detail.replacementInProgress")}</div>
                  <p className="mt-1 text-muted-foreground">
                    {replacementPresentation.status(selected.replacementStatus ?? "PROCESSING")} ·{" "}
                    {selected.replacementStage
                      ? replacementPresentation.stage(selected.replacementStage)
                      : t("detail.statusChecking")}
                  </p>
                  <p className="mt-2 leading-5 text-muted-foreground">
                    {t("detail.permissionDetail")}
                  </p>
                </div>
              ) : selected.canStartReplacement && canManage ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
                  <div className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-800" />
                    <div>
                      <div className="text-sm font-semibold text-amber-900">
                        {t("detail.oldAddressWarning")}
                      </div>
                      <p className="mt-1 text-xs leading-5 text-amber-800">
                        {t("detail.oldAddressWarningDetail")}
                      </p>
                    </div>
                  </div>
                  <Button
                    className="mt-3 w-full"
                    disabled={isWorking}
                    onClick={() => void startReplacement()}
                  >
                    {t("detail.startReplacement")}
                  </Button>
                </div>
              ) : selected.canStartReplacement ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                  {t("detail.managerRequired")}
                </div>
              ) : (
                <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
                  <div className="font-semibold text-foreground">
                    {t("detail.blocked")}
                  </div>
                  <p className="mt-1 leading-5">
                    {selected.replacementBlockedReason ??
                      t("detail.checkShipmentStatus")}
                  </p>
                </div>
              )}

              <div className="rounded-md border p-3 text-xs">
                <div className="mb-2 font-semibold">{t("detail.currentInvoice")}</div>
                <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">{t("detail.invoiceNumber")}</span>
                  <span className="font-mono">
                    {selected.currentTrackingNumber ?? "-"}
                  </span>
                  <span className="text-muted-foreground">{t("detail.shipmentStatus")}</span>
                  <span>{selected.currentShipmentStatus ?? "-"}</span>
                  <span className="text-muted-foreground">{t("detail.groupStatus")}</span>
                  <span>{packageGroupStatusLabel(selected.packageGroupStatus, packageStatusT)}</span>
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
