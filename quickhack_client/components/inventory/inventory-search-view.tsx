"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { PanelRightOpen } from "lucide-react";
import {
  statusBadge,
  statusLabel,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import { useDeviceListQuery } from "@/quickhack_client/components/shared/device-list-query-client";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  type DataGridColumn,
  type DataGridSortState,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import type { DeviceListRow } from "@/quickhack_shared/device/device-list-query";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";

type InventoryColumnKey =
  | "pgNo"
  | "model"
  | "modelSeq"
  | "imei"
  | "saleGrade"
  | "status"
  | "batchNo"
  | "supplierName"
  | "location";
type InventoryTableColumnKey = InventoryColumnKey | "detail";
type InventoryColumnFilters = Record<InventoryColumnKey, string>;
type InventorySortState = DataGridSortState<InventoryColumnKey>;

const emptyColumnFilters: InventoryColumnFilters = {
  pgNo: "",
  model: "",
  modelSeq: "",
  imei: "",
  saleGrade: "",
  status: "",
  batchNo: "",
  supplierName: "",
  location: "",
};

const statusOptions = Array.from(
  new Set([
    ...Object.values(INBOUND_STATUS),
    ...Object.values(INVENTORY_STATUS),
  ])
);

function queryStringForInventorySearch(input: {
  query: string;
  status: string;
  model: string;
  filters: InventoryColumnFilters;
  sort: InventorySortState;
}) {
  const params = new URLSearchParams({
    context: "INVENTORY",
    includeFacets: "true",
    limit: "100",
  });
  if (input.query.trim()) params.set("q", input.query.trim());
  if (input.status !== "ALL") params.set("status", input.status);
  if (input.model !== "ALL") params.set("model", input.model);
  if (input.sort) {
    params.set("sort", input.sort.key);
    params.set("direction", input.sort.direction);
  }

  const filterParamNames: Record<InventoryColumnKey, string> = {
    pgNo: "pgNo",
    model: "modelText",
    modelSeq: "modelSeq",
    imei: "imei",
    saleGrade: "saleGrade",
    status: "statusText",
    batchNo: "batchNo",
    supplierName: "supplierName",
    location: "location",
  };
  for (const [key, value] of Object.entries(input.filters) as Array<
    [InventoryColumnKey, string]
  >) {
    if (value.trim()) params.set(filterParamNames[key], value.trim());
  }
  return params.toString();
}

export function InventorySearchView({
  selectedPgNo,
  onOpenDevice,
}: {
  selectedPgNo?: string | null;
  onOpenDevice: (pgNo: string) => void;
}) {
  const t = useTranslations("inventory.search");
  const detailT = useTranslations("common.deviceDetail");
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("ALL");
  const [model, setModel] = React.useState("ALL");
  const [columnFilters, setColumnFilters] =
    React.useState<InventoryColumnFilters>({ ...emptyColumnFilters });
  const [sort, setSort] = React.useState<InventorySortState>(null);
  const deferredQuery = React.useDeferredValue(query);
  const deferredColumnFilters = React.useDeferredValue(columnFilters);
  const queryString = React.useMemo(
    () =>
      queryStringForInventorySearch({
        query: deferredQuery,
        status,
        model,
        filters: deferredColumnFilters,
        sort,
      }),
    [deferredColumnFilters, deferredQuery, model, sort, status]
  );
  const list = useDeviceListQuery({
    endpoint: "/api/inventory/devices",
    queryString,
  });

  const columns = React.useMemo<
    DataGridColumn<InventoryTableColumnKey, DeviceListRow>[]
  >(
    () => [
      {
        key: "pgNo",
        label: "PG",
        width: "150px",
        placeholder: t("placeholders.pg"),
        cellClassName: "flex items-center px-3 font-semibold",
        render: (device) => device.pgNo,
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(240px,1fr)",
        placeholder: t("placeholders.model"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (device) => (
          <>
            <div className="font-medium">{device.model}</div>
            <div className="text-xs text-muted-foreground">
              {[device.storage, device.color].filter(Boolean).join(" / ") || "-"}
            </div>
          </>
        ),
      },
      {
        key: "modelSeq",
        label: t("columns.modelSequence"),
        width: "130px",
        placeholder: "S24-345",
        cellClassName: "flex items-center px-3",
        render: (device) => formatModelSeqLabel(device.model, device.modelSeq),
      },
      {
        key: "imei",
        label: "IMEI",
        width: "170px",
        placeholder: t("placeholders.imei"),
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (device) => device.imei || "-",
      },
      {
        key: "saleGrade",
        label: t("columns.saleGrade"),
        width: "110px",
        placeholder: "A",
        cellClassName: "flex items-center px-3",
        render: (device) => <SaleGradeBadge value={device.saleGrade} />,
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "120px",
        placeholder: t("placeholders.sellable"),
        cellClassName: "flex items-center px-3",
        render: (device) => statusBadge(device.displayStatus, detailT),
      },
      {
        key: "batchNo",
        label: t("columns.batch"),
        width: "100px",
        placeholder: t("columns.batch"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.batchNo ?? "-",
      },
      {
        key: "supplierName",
        label: t("columns.supplier"),
        width: "140px",
        placeholder: t("columns.supplier"),
        menuAlign: "right",
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.supplierName || "-",
      },
      {
        key: "location",
        label: t("columns.location"),
        width: "130px",
        placeholder: t("columns.location"),
        menuAlign: "right",
        cellClassName: "flex items-center px-3",
        render: (device) => device.inventory?.location || "-",
      },
      {
        key: "detail",
        label: t("columns.detail"),
        width: "120px",
        sortable: false,
        filterable: false,
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3",
        render: (device) => (
          <Button
            size="sm"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDevice(device.pgNo);
            }}
            title={t("actions.openDetail")}
          >
            <PanelRightOpen className="size-4" />
            {t("actions.detail")}
          </Button>
        ),
      },
    ],
    [detailT, onOpenDevice, t]
  );

  const hasActiveFilters =
    Boolean(query.trim()) ||
    status !== "ALL" ||
    model !== "ALL" ||
    Object.values(columnFilters).some((value) => value.trim()) ||
    sort !== null;

  function resetFilters() {
    setQuery("");
    setStatus("ALL");
    setModel("ALL");
    setColumnFilters({ ...emptyColumnFilters });
    setSort(null);
  }

  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("result", {
              count: list.items.length,
              hasMore: String(list.hasMore),
            })}
          </p>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(260px,420px)_180px_180px_auto]">
          <SearchInput
            placeholder={t("filters.query")}
            value={query}
            onValueChange={setQuery}
          />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue placeholder={t("filters.status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("filters.allStatuses")}</SelectItem>
              {statusOptions.map((item) => (
                <SelectItem key={item} value={item}>
                  {statusLabel(item, detailT)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger><SelectValue placeholder={t("filters.model")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("filters.allModels")}</SelectItem>
              {(list.facets?.models ?? []).map((item) => (
                <SelectItem key={item} value={item}>{item}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={resetFilters} disabled={!hasActiveFilters}>
            {t("actions.reset")}
          </Button>
        </div>
      </div>

      {list.error ? <FeedbackBanner tone="danger">{list.error}</FeedbackBanner> : null}
      {list.isLoading ? (
        <FeedbackBanner tone="info">{t("loading")}</FeedbackBanner>
      ) : null}

      <VirtualizedDataGrid
        rows={list.items}
        columns={columns}
        rowKey={(device) => device.pgNo}
        emptyMessage={list.isLoading ? t("loading") : t("empty")}
        selectedRowKey={selectedPgNo ?? null}
        filters={columnFilters}
        sort={sort}
        onFilterChange={(key, value) => {
          if (key === "detail") return;
          setColumnFilters((current) => ({ ...current, [key]: value }));
        }}
        onSortChange={(nextSort) => {
          if (nextSort?.key === "detail") return;
          setSort(nextSort as InventorySortState);
        }}
        minWidth="1410px"
      />

      {list.hasMore ? (
        <div className="flex justify-center border-t pt-3">
          <Button
            variant="outline"
            disabled={list.isLoadingMore}
            onClick={() => void list.loadMore()}
          >
            {list.isLoadingMore ? t("loadingMore") : t("loadMore")}
          </Button>
        </div>
      ) : null}
    </WorkspacePageFrame>
  );
}
