"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";

type ShipmentPrintedRow = {
  allocationId: number;
  batchId: number | null;
  batchNo: number | null;
  batchLabel: string;
  printLineNo: number | null;
  printedAt: string;
  pgNo: string;
  uniqueNo: string;
  warranty: string;
  saleGrade: string;
  model: string;
  storage: string | null;
  color: string | null;
  receiverName: string;
  receiverAddress: string;
};

type ShipmentPrintedApiResponse = {
  ok: boolean;
  message?: string;
  count?: number;
  items?: ShipmentPrintedRow[];
};

type ShipmentPrintedColumnKey =
  | "printedAt"
  | "batchLabel"
  | "printLineNo"
  | "pg"
  | "uniqueNo"
  | "warranty"
  | "saleGrade"
  | "model"
  | "storage"
  | "color"
  | "receiverName"
  | "receiverAddress";

function textOrDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function formatPrintDateTime(value: string) {
  return value.replace("T", " ").slice(0, 19) || "-";
}

export function ShipmentPrintedListView() {
  const t = useTranslations("shipment.printed");
  const [rows, setRows] = React.useState<ShipmentPrintedRow[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [message, setMessage] = React.useState("");

  const loadRows = React.useCallback(async () => {
    setIsLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/coupang/shipment-list-print", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | ShipmentPrintedApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("fallback.loadFailed")));
      }

      setRows(payload.items ?? []);
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadRows();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadRows]);

  const columns = React.useMemo<
    DataGridColumn<ShipmentPrintedColumnKey, ShipmentPrintedRow>[]
  >(
    () => [
      {
        key: "printedAt",
        label: t("columns.printedAt"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => formatPrintDateTime(row.printedAt),
        render: (row) => (
          <span className="truncate">{formatPrintDateTime(row.printedAt)}</span>
        ),
      },
      {
        key: "batchLabel",
        label: t("columns.batch"),
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs font-medium",
        text: (row) => row.batchLabel,
        render: (row) => (
          <span className="truncate">{textOrDash(row.batchLabel)}</span>
        ),
      },
      {
        key: "printLineNo",
        label: "No",
        width: "70px",
        cellClassName: "flex min-w-0 items-center justify-end px-3 font-mono text-xs",
        text: (row) => textOrDash(row.printLineNo),
        render: (row) => (
          <span className="truncate">{textOrDash(row.printLineNo)}</span>
        ),
      },
      {
        key: "pg",
        label: "PG",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.pgNo,
        render: (row) => <span className="truncate">{row.pgNo}</span>,
      },
      {
        key: "uniqueNo",
        label: t("columns.uniqueId"),
        width: "120px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.uniqueNo,
        render: (row) => <span className="truncate">{row.uniqueNo}</span>,
      },
      {
        key: "warranty",
        label: t("columns.warranty"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.warranty,
        render: (row) => <span className="truncate">{textOrDash(row.warranty)}</span>,
      },
      {
        key: "saleGrade",
        label: t("columns.saleGrade"),
        width: "110px",
        cellClassName: "flex items-center px-3",
        text: (row) => row.saleGrade,
        render: (row) =>
          textOrDash(row.saleGrade) === "-" ? (
            "-"
          ) : (
            <SaleGradeBadge value={row.saleGrade} />
          ),
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(160px,1fr)",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.model,
        render: (row) => <span className="truncate">{textOrDash(row.model)}</span>,
      },
      {
        key: "storage",
        label: t("columns.storage"),
        width: "100px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.storage,
        render: (row) => <span className="truncate">{textOrDash(row.storage)}</span>,
      },
      {
        key: "color",
        label: t("columns.color"),
        width: "120px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.color,
        render: (row) => <span className="truncate">{textOrDash(row.color)}</span>,
      },
      {
        key: "receiverName",
        label: t("columns.receiver"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverName,
        render: (row) => (
          <span className="truncate">{textOrDash(row.receiverName)}</span>
        ),
      },
      {
        key: "receiverAddress",
        label: t("columns.address"),
        width: "minmax(280px,1.5fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => (
          <span className="truncate">{textOrDash(row.receiverAddress)}</span>
        ),
      },
    ],
    [t]
  );

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("summary", { count: rows.length })}
          </p>
        </div>
        <Button variant="outline" onClick={loadRows} disabled={isLoading}>
          <RefreshCcw className="size-4" />
          {t("refresh")}
        </Button>
      </div>

      {message ? (
        <FeedbackBanner tone="warning" className="mb-3">
          {message}
        </FeedbackBanner>
      ) : null}

      <VirtualizedDataGrid
        rows={rows}
        columns={columns}
        rowKey={(row) => row.allocationId}
        emptyMessage={
          isLoading
            ? t("loading")
            : t("empty")
        }
        minWidth="1560px"
        rowHeight={44}
      />
    </WorkspacePageFrame>
  );
}
