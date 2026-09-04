"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { invoiceOperationStatusLabel } from "@/quickhack_client/components/invoice/invoice-status-presentation";
import { RefreshCcw, Search } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import {
  DescriptionList,
  DescriptionRow,
} from "@/quickhack_client/components/ui/description-list";
import { MasterDetailLayout } from "@/quickhack_client/components/ui/workspace-layout";
import { cn } from "@/quickhack_shared/core/utils";
import type { InvoiceHistoryRow } from "./invoice-operation-types";

type HistoryListResponse = {
  ok: boolean;
  message?: string;
  totalCount?: number;
  nextCursor?: string | null;
  items?: InvoiceHistoryRow[];
};

type HistoryDetailResponse = {
  ok: boolean;
  message?: string;
  history?: {
    carrierShipmentId: number;
    packageGroupId: number | null;
    revisions: InvoiceHistoryRow[];
  };
};

function formatDate(value: string | null | undefined) {
  return value ? value.replace("T", " ").slice(0, 19) : "-";
}

function statusVariant(value: string | null | undefined) {
  const status = String(value ?? "");
  if (["COMPLETED", "REGISTERED", "DELIVERED", "CONFIRMED"].includes(status))
    return "success" as const;
  if (
    ["FAILED", "BLOCKED", "REVIEW_REQUIRED", "UNKNOWN"].includes(status)
  )
    return "danger" as const;
  if (["PENDING", "ALLOCATED", "NOT_PRINTED"].includes(status))
    return "warning" as const;
  return "secondary" as const;
}

function DetailLine({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <DescriptionRow
      label={label}
      value={value}
      labelWidth="105px"
      className="text-xs"
    />
  );
}

export function InvoiceIssueHistoryView() {
  const t = useTranslations("shipment.invoiceHistory");
  const statusText = React.useCallback(
    (value: string | null | undefined, fallback: string) =>
      invoiceOperationStatusLabel(value, fallback, t),
    [t]
  );
  const [items, setItems] = React.useState<InvoiceHistoryRow[]>([]);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [detailResult, setDetailResult] = React.useState<{
    carrierShipmentId: number;
    revisions: InvoiceHistoryRow[];
  } | null>(null);
  const [search, setSearch] = React.useState("");
  const [appliedSearch, setAppliedSearch] = React.useState("");
  const [totalCount, setTotalCount] = React.useState(0);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(
    async (append = false) => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (appliedSearch) params.set("search", appliedSearch);
        if (append && nextCursor) params.set("cursor", String(nextCursor));
        const response = await fetch(
          `/api/invoices/history?${params.toString()}`,
          { cache: "no-store" }
        );
        const payload = (await response.json()) as HistoryListResponse;
        if (!response.ok || !payload.ok) {
          throw new Error(legacyApiMessage(payload, t("state.loadFailed")));
        }
        const nextItems = payload.items ?? [];
        setItems((current) => (append ? [...current, ...nextItems] : nextItems));
        setTotalCount(payload.totalCount ?? nextItems.length);
        setNextCursor(payload.nextCursor ?? null);
        if (!append) {
          setSelectedId((current) =>
            current && nextItems.some((item) => item.carrierShipmentId === current)
              ? current
              : nextItems[0]?.carrierShipmentId ?? null
          );
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [appliedSearch, nextCursor, t]
  );

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(timer);
    // nextCursor is intentionally excluded: it is only used by "더 보기".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedSearch]);

  React.useEffect(() => {
    if (!selectedId) {
      return;
    }
    let alive = true;
    void fetch(`/api/invoices/history/${selectedId}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as HistoryDetailResponse;
        if (!response.ok || !payload.ok) {
          throw new Error(legacyApiMessage(payload, t("state.detailFailed")));
        }
        if (alive) {
          setDetailResult({
            carrierShipmentId: selectedId,
            revisions: payload.history?.revisions ?? [],
          });
        }
      })
      .catch((caught) => {
        if (alive) {
          setDetailResult({
            carrierShipmentId: selectedId,
            revisions: [],
          });
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedId, t]);

  const revisions =
    detailResult?.carrierShipmentId === selectedId
      ? detailResult.revisions
      : [];
  const detailLoading =
    selectedId !== null && detailResult?.carrierShipmentId !== selectedId;
  const selected =
    revisions.find((row) => row.carrierShipmentId === selectedId) ??
    items.find((row) => row.carrierShipmentId === selectedId) ??
    null;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-2 border-b pb-3">
        <div className="mr-auto">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description", { count: totalCount })}
          </p>
        </div>
        <form
          className="relative min-w-72"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedSearch(search.trim());
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("search")}
          />
        </form>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(false)}>
          <RefreshCcw className={cn("size-4", loading && "animate-spin")} />
          {t("refresh")}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <MasterDetailLayout className="gap-3 xl:grid-cols-[minmax(0,1fr)_430px]">
        <div className="min-h-64 overflow-auto rounded-md border bg-background">
          <table className="w-full min-w-[1040px] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-40 px-3 py-2">{t("columns.tracking")}</th>
                <th className="w-20 px-3 py-2">{t("columns.revision")}</th>
                <th className="w-28 px-3 py-2">{t("columns.status")}</th>
                <th className="w-28 px-3 py-2">{t("columns.channel")}</th>
                <th className="w-28 px-3 py-2">{t("columns.carrier")}</th>
                <th className="w-28 px-3 py-2">{t("columns.output")}</th>
                <th className="w-36 px-3 py-2">{t("columns.members")}</th>
                <th className="px-3 py-2">{t("columns.order")}</th>
                <th className="w-36 px-3 py-2">{t("columns.issuedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.carrierShipmentId}
                  className={cn(
                    "cursor-pointer border-t hover:bg-muted/50",
                    selectedId === item.carrierShipmentId && "bg-primary/5"
                  )}
                  onClick={() => setSelectedId(item.carrierShipmentId)}
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    <div>{item.trackingNumber}</div>
                    {item.isCurrent ? (
                      <span className="text-[10px] font-semibold text-primary">
                        {t("state.currentInvoice")}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">rev.{item.revisionNo}</td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(item.invoiceStatus)}>
                      {statusText(item.invoiceStatus, t("state.pending"))}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(item.channelWrite?.status)}>
                      {statusText(item.channelWrite?.status, t("state.noHistory"))}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(item.registration?.status)}>
                      {statusText(item.registration?.status, t("state.pending"))}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(item.issue?.labelPrintStatus)}>
                      {statusText(item.issue?.labelPrintStatus, t("state.pending"))}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {item.members.map((member) => member.pgNo).join(", ") || item.pgNo || "-"}
                    <div className="text-[10px] text-muted-foreground">
                      {t("state.count", { count: item.memberCount })}
                    </div>
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-xs">
                    {item.members.map((member) => member.externalOrderId).join(", ") ||
                      item.externalOrderId ||
                      "-"}
                  </td>
                  <td className="px-3 py-2 text-xs">{formatDate(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              {t("state.empty")}
            </div>
          ) : null}
          {nextCursor ? (
            <div className="border-t p-3 text-center">
              <Button variant="outline" disabled={loading} onClick={() => void load(true)}>
                {t("state.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>

        <aside className="min-h-0 overflow-auto rounded-md border bg-background">
          {detailLoading ? (
            <div className="p-6 text-sm text-muted-foreground">{t("state.detailLoading")}</div>
          ) : selected ? (
            <div>
              <div className="sticky top-0 z-10 border-b bg-background px-4 py-3">
                <h3 className="font-semibold">{selected.trackingNumber}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("detail.package", { group: String(selected.packageGroupId ?? "-"), count: revisions.length })}
                </p>
              </div>
              <DescriptionList className="p-4">
                <DetailLine label={t("detail.receiver")} value={selected.receiverName} />
                <DetailLine label={t("detail.address")} value={selected.receiverAddress} />
                <DetailLine
                  label={t("detail.channel")}
                  value={
                    selected.channelWrite
                      ? `${selected.channelWrite.requestTypeLabel} · ${statusText(selected.channelWrite.status, t("state.pending"))}`
                      : t("state.noHistory")
                  }
                />
                <DetailLine
                  label={t("detail.carrier")}
                  value={statusText(selected.registration?.status, t("state.pending"))}
                />
                <DetailLine
                  label={t("detail.output")}
                  value={statusText(selected.issue?.labelPrintStatus, t("state.pending"))}
                />
                <DetailLine label={t("detail.shipment")} value={selected.shipmentStatus} />
              </DescriptionList>

              <div className="border-t p-4">
                <h4 className="mb-3 text-xs font-semibold text-muted-foreground">
                  {t("detail.revisions")}
                </h4>
                <div className="space-y-2">
                  {revisions.map((revision) => (
                    <button
                      type="button"
                      key={revision.carrierShipmentId}
                      onClick={() => setSelectedId(revision.carrierShipmentId)}
                      className={cn(
                        "w-full rounded-md border p-3 text-left text-xs",
                        revision.carrierShipmentId === selectedId &&
                          "border-primary bg-primary/5"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold">
                          rev.{revision.revisionNo} · {revision.trackingNumber}
                        </span>
                        {revision.isCurrent ? (
                          <Badge variant="success">{t("detail.current")}</Badge>
                        ) : (
                          <Badge variant="secondary">{statusText(revision.invoiceStatus, t("state.pending"))}</Badge>
                        )}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {formatDate(revision.createdAt)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-t p-4">
                <h4 className="mb-3 text-xs font-semibold text-muted-foreground">
                  {t("detail.scans")}
                </h4>
                {selected.trackingEvents.length ? (
                  <div className="space-y-2">
                    {selected.trackingEvents.map((event) => (
                      <div key={event.id} className="border-l-2 pl-3 text-xs">
                        <div className="font-medium">{event.statusName}</div>
                        <div className="text-muted-foreground">
                          {[event.scanDate, event.scanTime, event.branchName]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("detail.scansEmpty")}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center p-6 text-sm text-muted-foreground">
              {t("state.select")}
            </div>
          )}
        </aside>
      </MasterDetailLayout>
    </section>
  );
}
