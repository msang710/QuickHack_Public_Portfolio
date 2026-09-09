// QuickHack note: 재고 조회/수정 화면에서 쓰는 기기 상세 행, 이력 목록, 우측 상세 패널을 제공합니다.
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import {
  DescriptionList,
  DescriptionRow,
} from "@/quickhack_client/components/ui/description-list";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/quickhack_client/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/quickhack_client/components/ui/tabs";
import {
  type DetailRecord,
  type DeviceListItem,
  type StatusTone,
  formatModelSeqLabel,
} from "@/quickhack_shared/device/types";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";
import type {
  DeviceHistorySection,
} from "@/quickhack_shared/device/device-history";
import { requestDeviceHistoryPage } from "@/quickhack_client/components/shared/device-list-query-client";

export type DeviceStatusMessageKey = `status.${
  | "received" | "inspecting" | "inspected" | "purchased" | "supplierReturn"
  | "sellable" | "reserved" | "packing" | "packed" | "departure" | "delivering"
  | "finalDelivery" | "noneTracking" | "hold" | "defective" | "returnRequested"
  | "exchangeRequested" | "returnCheck" | "orderConfirm" | "returnRequest" | "exchangeRequest"}`;

export type InspectionMessageKey =
  | `inspectionType.${"appearance" | "function" | "returnCheck"}`
  | `inspectionSource.${"inbound" | "coupangReturn" | "manual"}`
  | `inspectionResult.${"passed" | "failed" | "hold" | "returnToSupplier" | "disposal"}`;

export const statusMap: Record<string, { labelKey: DeviceStatusMessageKey; tone: StatusTone }> = {
  RECEIVED: { labelKey: "status.received", tone: "neutral" }, INSPECTING: { labelKey: "status.inspecting", tone: "neutral" }, INSPECTED: { labelKey: "status.inspected", tone: "neutral" }, PURCHASED: { labelKey: "status.purchased", tone: "neutral" }, SUPPLIER_RETURN: { labelKey: "status.supplierReturn", tone: "neutral" },
  SELLABLE: { labelKey: "status.sellable", tone: "success" }, RESERVED: { labelKey: "status.reserved", tone: "purple" }, PACKING: { labelKey: "status.packing", tone: "warning" }, PACKED: { labelKey: "status.packed", tone: "sky" }, DEPARTURE: { labelKey: "status.departure", tone: "danger" }, DELIVERING: { labelKey: "status.delivering", tone: "neutral" }, FINAL_DELIVERY: { labelKey: "status.finalDelivery", tone: "neutral" }, NONE_TRACKING: { labelKey: "status.noneTracking", tone: "warning" }, HOLD: { labelKey: "status.hold", tone: "neutral" }, DEFECTIVE: { labelKey: "status.defective", tone: "danger" }, RETURN_REQUESTED: { labelKey: "status.returnRequested", tone: "orange" }, EXCHANGE_REQUESTED: { labelKey: "status.exchangeRequested", tone: "sky" }, RETURN_CHECK: { labelKey: "status.returnCheck", tone: "orange" },
  ORDER_CONFIRM: { labelKey: "status.orderConfirm", tone: "purple" }, ORDER_CONFIRMED: { labelKey: "status.orderConfirm", tone: "purple" }, 주문확인: { labelKey: "status.orderConfirm", tone: "purple" }, RETURN_REQUEST: { labelKey: "status.returnRequest", tone: "orange" }, 반품요청: { labelKey: "status.returnRequest", tone: "orange" }, EXCHANGE_REQUEST: { labelKey: "status.exchangeRequest", tone: "sky" }, 교환요청: { labelKey: "status.exchangeRequest", tone: "sky" },
};

export const APPEARANCE_INSPECTION_FIELD_KEYS = new Set([
  "inspection_type",
  "inspection_round",
  "inspection_result",
  "source_type",
  "checked_at",
  "appearance_grade",
  "appearance_defect",
  "return_yn",
  "appearance_worker",
  "appearance_checked_at",
  "note",
]);

export const APPEARANCE_INSPECTION_EVIDENCE_KEYS = new Set([
  "appearance_grade",
  "appearance_defect",
  "return_yn",
  "appearance_worker",
  "appearance_checked_at",
]);

export const FUNCTION_INSPECTION_FIELD_KEYS = new Set([
  "inspection_type",
  "inspection_round",
  "inspection_result",
  "source_type",
  "checked_at",
  "function_defect",
  "csc",
  "first_call_date",
  "function_worker",
  "function_checked_at",
  "note",
]);

export const FUNCTION_INSPECTION_EVIDENCE_KEYS = new Set([
  "function_defect",
  "csc",
  "first_call_date",
  "function_worker",
  "function_checked_at",
]);

export function statusLabel(status: string, translate: (key: DeviceStatusMessageKey) => string) {
  const config = statusMap[status];
  return config ? translate(config.labelKey) : status || "-";
}

export function inspectionTypeLabel(
  value: string,
  translate: (key: InspectionMessageKey) => string
) {
  if (value === "APPEARANCE") return translate("inspectionType.appearance");
  if (value === "FUNCTION") return translate("inspectionType.function");
  if (value === "RETURN_CHECK") return translate("inspectionType.returnCheck");
  return value || "-";
}

export function inspectionSourceLabel(
  value: string,
  translate: (key: InspectionMessageKey) => string
) {
  if (value === "INBOUND") return translate("inspectionSource.inbound");
  if (value === "COUPANG_RETURN") return translate("inspectionSource.coupangReturn");
  if (value === "MANUAL") return translate("inspectionSource.manual");
  return value || "-";
}

export function inspectionResultLabel(
  value: string,
  translate: (key: InspectionMessageKey) => string
) {
  if (value === "PASSED") return translate("inspectionResult.passed");
  if (value === "FAILED") return translate("inspectionResult.failed");
  if (value === "HOLD") return translate("inspectionResult.hold");
  if (value === "RETURN_TO_SUPPLIER") return translate("inspectionResult.returnToSupplier");
  if (value === "DISPOSAL") return translate("inspectionResult.disposal");
  return value || "-";
}

export function detailFieldLabel(
  key: string,
  translate: (key: never) => string
) {
  return translate(`fields.${key.replaceAll(".", "_")}` as never);
}

export function detailRecordTitle(
  title: string,
  translate: (key: never, values?: never) => string
) {
  const [code, indexText] = title.split(":", 2);
  const index = Number.parseInt(indexText ?? "", 10);
  if (code === "DEVICE") return translate("recordTitle.device" as never);
  if (code === "INVENTORY") return translate("recordTitle.inventory" as never);
  if (code === "INBOUND") return translate("recordTitle.inbound" as never, { index } as never);
  if (code === "INSPECTION") return translate("recordTitle.inspection" as never, { index } as never);
  if (code === "ORDER_ITEM") return translate("recordTitle.orderItem" as never, { index } as never);
  if (code === "SHIPMENT_WORK") return translate("recordTitle.shipmentWork" as never, { index } as never);
  if (code === "CHANNEL_ORDER_MATCH") return translate("recordTitle.channelOrderMatch" as never, { index } as never);
  if (code === "RETURN_DECISION") return translate("recordTitle.returnDecision" as never, { index } as never);
  return title;
}

export function statusBadge(status: string, translate: (key: DeviceStatusMessageKey) => string) {
  const config = statusMap[status];
  return <Badge variant={config?.tone ?? "neutral"}>{statusLabel(status, translate)}</Badge>;
}

export function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  return value.replace("T", " ").slice(0, 19);
}

export function DetailRow({
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
      valueClassName="font-medium"
    />
  );
}

function DetailRecordList({
  empty,
  records,
}: {
  empty: string;
  records: DetailRecord[];
}) {
  const t = useTranslations("common.deviceDetail");
  const fieldValue = (field: DetailRecord["fields"][number]) => {
    const value = String(field.value ?? "");
    if (field.key === "inbound_status" || field.key === "inventory_status") return statusLabel(value, t);
    if (field.key === "inspection_type") return inspectionTypeLabel(value, t);
    if (field.key === "inspection_result") return inspectionResultLabel(value, t);
    if (field.key === "source_type") return inspectionSourceLabel(value, t);
    return field.displayValue ?? field.value;
  };
  const recordSubtitle = (record: DetailRecord) => {
    if (record.kind === "inbound") {
      const value = record.fields.find((field) => field.key === "inbound_status")?.value;
      return statusLabel(String(value ?? ""), t);
    }
    if (record.kind === "inventory") {
      const value = record.fields.find((field) => field.key === "inventory_status")?.value;
      return statusLabel(String(value ?? ""), t);
    }
    if (record.kind === "inspection") {
      const type = String(record.fields.find((field) => field.key === "inspection_type")?.value ?? "");
      const result = String(record.fields.find((field) => field.key === "inspection_result")?.value ?? "");
      return [inspectionTypeLabel(type, t), inspectionResultLabel(result, t)]
        .filter((value) => value && value !== "-")
        .join(" · ");
    }
    return record.subtitle;
  };
  if (records.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {records.map((record) => (
        <div className="rounded-md border px-4" key={record.id}>
          <div className="flex items-start justify-between gap-3 border-b py-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {detailRecordTitle(record.title, t)}
              </div>
              {recordSubtitle(record) ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {recordSubtitle(record)}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-xs text-muted-foreground">
              {formatDate(record.at)}
            </div>
          </div>
          <div>
            {record.fields.map((field) => (
              <DetailRow
                key={`${record.id}-${field.key}`}
                label={detailFieldLabel(field.key, t)}
                value={fieldValue(field)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type DeviceHistoryState = {
  items: DetailRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  loaded: boolean;
  loading: boolean;
  error: string;
};

function emptyDeviceHistoryState(): DeviceHistoryState {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    totalCount: 0,
    loaded: false,
    loading: false,
    error: "",
  };
}

function HistoryDetailRecordList({
  empty,
  state,
  onLoadMore,
}: {
  empty: string;
  state: DeviceHistoryState;
  onLoadMore: () => void;
}) {
  const t = useTranslations("common.deviceDetail");
  if (!state.loaded && state.loading) {
    return <FeedbackBanner tone="info">{t("historyLoading")}</FeedbackBanner>;
  }

  return (
    <div className="grid gap-3">
      {state.error ? (
        <div className="grid gap-2">
          <FeedbackBanner tone="danger">{state.error}</FeedbackBanner>
          {!state.loaded ? (
            <Button variant="outline" disabled={state.loading} onClick={onLoadMore}>
              {t("retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <DetailRecordList empty={empty} records={state.items} />
      {state.loaded ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {t("historyCount", { total: state.totalCount, loaded: state.items.length })}
          </span>
          {state.hasMore ? (
            <Button variant="outline" disabled={state.loading} onClick={onLoadMore}>
              {state.loading ? t("loadingMore") : t("loadMore")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReadOnlyDetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3 rounded-md border bg-popover p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function hasMeaningfulInspectionField(
  record: DetailRecord,
  fieldKeys: Set<string>
) {
  const inspectionType = record.fields.find(
    (field) => field.key === "inspection_type"
  )?.value;
  const expectedType =
    fieldKeys === APPEARANCE_INSPECTION_EVIDENCE_KEYS
      ? INSPECTION_TYPE.appearance
      : fieldKeys === FUNCTION_INSPECTION_EVIDENCE_KEYS
        ? INSPECTION_TYPE.function
        : null;

  if (inspectionType && expectedType) {
    return inspectionType === expectedType;
  }

  return record.fields.some(
    (field) =>
      fieldKeys.has(field.key) && field.value !== null && field.value !== ""
  );
}

export function filterInspectionRecords(
  records: DetailRecord[],
  fieldKeys: Set<string>,
  evidenceKeys: Set<string>
) {
  return records
    .filter((record) => hasMeaningfulInspectionField(record, evidenceKeys))
    .map((record) => ({
      ...record,
      fields: record.fields
        .filter((field) => fieldKeys.has(field.key))
        .map((field) => ({ ...field })),
    }));
}

export function DeviceSheet({
  device,
  requestedPgNo = "",
  loading = false,
  error = "",
  onRetry,
  open,
  onOpenChange,
}: {
  device: DeviceListItem | null;
  requestedPgNo?: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("common.deviceDetail");
  const queryT = useTranslations("common.deviceQuery");
  const pgNo = device?.pgNo ?? "";
  const [history, setHistory] = React.useState<
    Partial<Record<DeviceHistorySection, DeviceHistoryState>>
  >({});
  const [historyOwnerPgNo, setHistoryOwnerPgNo] = React.useState(pgNo);
  const historyAbortControllers = React.useRef(
    new Map<DeviceHistorySection, AbortController>()
  );

  const stateFor = React.useCallback(
    (section: DeviceHistorySection) =>
      historyOwnerPgNo === pgNo
        ? history[section] ?? emptyDeviceHistoryState()
        : emptyDeviceHistoryState(),
    [history, historyOwnerPgNo, pgNo]
  );

  const loadHistory = React.useCallback(
    async (section: DeviceHistorySection, loadMore = false) => {
      if (!pgNo) return;
      const current =
        historyOwnerPgNo === pgNo
          ? history[section] ?? emptyDeviceHistoryState()
          : emptyDeviceHistoryState();
      if (current.loading || (!loadMore && current.loaded)) return;

      historyAbortControllers.current.get(section)?.abort();
      const controller = new AbortController();
      historyAbortControllers.current.set(section, controller);
      setHistoryOwnerPgNo(pgNo);
      setHistory((values) => ({
        ...values,
        [section]: {
          ...(values[section] ?? emptyDeviceHistoryState()),
          loading: true,
          error: "",
        },
      }));

      try {
        const page = await requestDeviceHistoryPage(
          pgNo,
          section,
          queryT("historyFailed"),
          loadMore ? current.nextCursor : null,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setHistory((values) => {
          const previous = values[section] ?? emptyDeviceHistoryState();
          const existing = loadMore ? previous.items : [];
          const ids = new Set(existing.map((item) => item.id));
          return {
            ...values,
            [section]: {
              items: [...existing, ...page.items.filter((item) => !ids.has(item.id))],
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              totalCount: page.totalCount,
              loaded: true,
              loading: false,
              error: "",
            },
          };
        });
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setHistory((values) => ({
          ...values,
          [section]: {
            ...(values[section] ?? emptyDeviceHistoryState()),
            loading: false,
            error:
              loadError instanceof Error ? loadError.message : String(loadError),
          },
        }));
      }
    },
    [history, historyOwnerPgNo, pgNo, queryT]
  );

  React.useEffect(() => {
    historyAbortControllers.current.forEach((controller) => controller.abort());
    historyAbortControllers.current.clear();
    setHistory({});
    setHistoryOwnerPgNo(pgNo);
  }, [pgNo]);

  React.useEffect(
    () => () => {
      historyAbortControllers.current.forEach((controller) => controller.abort());
    },
    []
  );

  const handleTabChange = React.useCallback(
    (tab: string) => {
      const sections: DeviceHistorySection[] =
        tab === "inbound"
          ? ["inbounds"]
          : tab === "inspection"
            ? ["inspections"]
            : tab === "order"
              ? ["orderItems", "channelOrderMatches"]
              : tab === "shipment"
                ? ["shipmentWorks"]
                : tab === "return"
                  ? ["returnDecisions"]
                  : [];
      sections.forEach((section) => void loadHistory(section));
    },
    [loadHistory]
  );

  if (!device) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{requestedPgNo || t("title")}</SheetTitle>
            <SheetDescription>
              {t("description")}
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 px-5 py-4">
            {loading ? (
              <FeedbackBanner tone="info">
                {t("loading")}
              </FeedbackBanner>
            ) : null}
            {error ? (
              <>
                <FeedbackBanner tone="danger">{error}</FeedbackBanner>
                {onRetry ? (
                  <Button variant="outline" onClick={onRetry}>
                    {t("retry")}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const functionInspectionRecords = filterInspectionRecords(
    stateFor("inspections").items,
    FUNCTION_INSPECTION_FIELD_KEYS,
    FUNCTION_INSPECTION_EVIDENCE_KEYS
  );
  const appearanceInspectionRecords = filterInspectionRecords(
    stateFor("inspections").items,
    APPEARANCE_INSPECTION_FIELD_KEYS,
    APPEARANCE_INSPECTION_EVIDENCE_KEYS
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle>{device.pgNo}</SheetTitle>
            {statusBadge(device.displayStatus, t)}
          </div>
          <SheetDescription>
            {device.model}
            {device.modelSeq
              ? ` / ${formatModelSeqLabel(device.model, device.modelSeq)}`
              : ""}
            {device.storage ? ` / ${device.storage}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Tabs defaultValue="basic" onValueChange={handleTabChange}>
            <TabsList className="grid w-full grid-cols-6">
              <TabsTrigger value="basic">{t("tabs.basic")}</TabsTrigger>
              <TabsTrigger value="inbound">{t("tabs.inbound")}</TabsTrigger>
              <TabsTrigger value="inspection">{t("tabs.inspection")}</TabsTrigger>
              <TabsTrigger value="order">{t("tabs.order")}</TabsTrigger>
              <TabsTrigger value="shipment">{t("tabs.shipment")}</TabsTrigger>
              <TabsTrigger value="return">{t("tabs.returns")}</TabsTrigger>
            </TabsList>

            <TabsContent value="basic">
              <ReadOnlyDetailSection title={t("basic.title")}>
                <DescriptionList className="rounded-md border bg-background px-4">
                  <DetailRow label="PG" value={device.pgNo} />
                  <DetailRow label={t("basic.model")} value={device.model} />
                  <DetailRow label={t("basic.modelCode")} value={device.modelCode} />
                  <DetailRow
                    label={t("basic.sequence")}
                    value={formatModelSeqLabel(device.model, device.modelSeq)}
                  />
                  <DetailRow label="IMEI" value={device.imei} />
                  <DetailRow label={t("basic.storage")} value={device.storage} />
                  <DetailRow label={t("basic.color")} value={device.color} />
                  <DetailRow
                    label={t("basic.grade")}
                    value={<SaleGradeBadge value={device.saleGrade} />}
                  />
                  <DetailRow label={t("basic.status")} value={statusBadge(device.displayStatus, t)} />
                  <DetailRow label={t("basic.updatedAt")} value={formatDate(device.updatedAt)} />
                </DescriptionList>
              </ReadOnlyDetailSection>
            </TabsContent>

            <TabsContent value="inbound">
              <div className="grid gap-4">
                <ReadOnlyDetailSection title={t("inbound.records")}>
                  <HistoryDetailRecordList
                    empty={t("inbound.empty")}
                    state={stateFor("inbounds")}
                    onLoadMore={() => void loadHistory("inbounds", true)}
                  />
                </ReadOnlyDetailSection>
                <ReadOnlyDetailSection title={t("inbound.inventory")}>
                  <DetailRecordList
                    empty={t("inbound.inventoryEmpty")}
                    records={device.detailRecords.inventory}
                  />
                </ReadOnlyDetailSection>
              </div>
            </TabsContent>

            <TabsContent value="inspection">
              <div className="grid gap-4">
                <ReadOnlyDetailSection title={t("inspection.functionRecords")}>
                  <HistoryDetailRecordList
                    empty={t("inspection.functionEmpty")}
                    state={{
                      ...stateFor("inspections"),
                      items: functionInspectionRecords,
                    }}
                    onLoadMore={() => void loadHistory("inspections", true)}
                  />
                </ReadOnlyDetailSection>
                <ReadOnlyDetailSection title={t("inspection.appearanceRecords")}>
                  <HistoryDetailRecordList
                    empty={t("inspection.appearanceEmpty")}
                    state={{
                      ...stateFor("inspections"),
                      items: appearanceInspectionRecords,
                    }}
                    onLoadMore={() => void loadHistory("inspections", true)}
                  />
                </ReadOnlyDetailSection>
              </div>
            </TabsContent>

            <TabsContent value="order">
              <div className="grid gap-4">
                <ReadOnlyDetailSection title={t("order.source")}>
                  <HistoryDetailRecordList
                    empty={t("order.sourceEmpty")}
                    state={stateFor("orderItems")}
                    onLoadMore={() => void loadHistory("orderItems", true)}
                  />
                </ReadOnlyDetailSection>
                <ReadOnlyDetailSection title={t("order.matches")}>
                  <HistoryDetailRecordList
                    empty={t("order.matchesEmpty")}
                    state={stateFor("channelOrderMatches")}
                    onLoadMore={() =>
                      void loadHistory("channelOrderMatches", true)
                    }
                  />
                </ReadOnlyDetailSection>
              </div>
            </TabsContent>

            <TabsContent value="shipment">
              <ReadOnlyDetailSection title={t("shipment.title")}>
                <HistoryDetailRecordList
                  empty={t("shipment.empty")}
                  state={stateFor("shipmentWorks")}
                  onLoadMore={() => void loadHistory("shipmentWorks", true)}
                />
              </ReadOnlyDetailSection>
            </TabsContent>

            <TabsContent value="return">
              <ReadOnlyDetailSection title={t("returns.title")}>
                <HistoryDetailRecordList
                  empty={t("returns.empty")}
                  state={stateFor("returnDecisions")}
                  onLoadMore={() => void loadHistory("returnDecisions", true)}
                />
              </ReadOnlyDetailSection>
            </TabsContent>

          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
