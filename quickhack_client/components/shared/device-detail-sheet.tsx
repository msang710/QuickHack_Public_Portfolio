// QuickHack note: 재고 조회/수정 화면에서 쓰는 기기 상세 행, 이력 목록, 우측 상세 패널을 제공합니다.
"use client";

import * as React from "react";
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
import { inboundStatusLabel } from "@/quickhack_shared/inbound/inbound-status";
import { inventoryStatusLabel } from "@/quickhack_shared/inventory/inventory-status";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";
import type {
  DeviceHistorySection,
} from "@/quickhack_shared/device/device-history";
import { requestDeviceHistoryPage } from "@/quickhack_client/components/shared/device-list-query-client";

export const statusMap: Record<string, { label: string; tone: StatusTone }> = {
  RECEIVED: { label: inboundStatusLabel("RECEIVED"), tone: "neutral" },
  INSPECTING: { label: inboundStatusLabel("INSPECTING"), tone: "neutral" },
  INSPECTED: { label: inboundStatusLabel("INSPECTED"), tone: "neutral" },
  PURCHASED: { label: inboundStatusLabel("PURCHASED"), tone: "neutral" },
  SUPPLIER_RETURN: {
    label: inboundStatusLabel("SUPPLIER_RETURN"),
    tone: "neutral",
  },
  SELLABLE: { label: inventoryStatusLabel("SELLABLE"), tone: "success" },
  RESERVED: { label: inventoryStatusLabel("RESERVED"), tone: "purple" },
  PACKING: { label: inventoryStatusLabel("PACKING"), tone: "warning" },
  PACKED: { label: inventoryStatusLabel("PACKED"), tone: "sky" },
  DEPARTURE: { label: inventoryStatusLabel("DEPARTURE"), tone: "danger" },
  DELIVERING: { label: inventoryStatusLabel("DELIVERING"), tone: "neutral" },
  FINAL_DELIVERY: {
    label: inventoryStatusLabel("FINAL_DELIVERY"),
    tone: "neutral",
  },
  NONE_TRACKING: {
    label: inventoryStatusLabel("NONE_TRACKING"),
    tone: "warning",
  },
  HOLD: { label: inventoryStatusLabel("HOLD"), tone: "neutral" },
  DEFECTIVE: { label: inventoryStatusLabel("DEFECTIVE"), tone: "danger" },
  RETURN_REQUESTED: {
    label: inventoryStatusLabel("RETURN_REQUESTED"),
    tone: "orange",
  },
  EXCHANGE_REQUESTED: {
    label: inventoryStatusLabel("EXCHANGE_REQUESTED"),
    tone: "sky",
  },
  RETURN_CHECK: { label: inventoryStatusLabel("RETURN_CHECK"), tone: "orange" },
  ORDER_CONFIRM: { label: "주문확인", tone: "purple" },
  ORDER_CONFIRMED: { label: "주문확인", tone: "purple" },
  주문확인: { label: "주문확인", tone: "purple" },
  RETURN_REQUEST: { label: "반품요청", tone: "orange" },
  반품요청: { label: "반품요청", tone: "orange" },
  EXCHANGE_REQUEST: { label: "교환요청", tone: "sky" },
  교환요청: { label: "교환요청", tone: "sky" },
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

export function statusBadge(status: string) {
  const config = statusMap[status] ?? { label: status || "-", tone: "neutral" };
  return <Badge variant={config.tone}>{config.label}</Badge>;
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
              <div className="text-sm font-semibold">{record.title}</div>
              {record.subtitle ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {record.subtitle}
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
                key={`${record.id}-${field.label}`}
                label={field.label}
                value={field.displayValue ?? field.value}
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
  if (!state.loaded && state.loading) {
    return <FeedbackBanner tone="info">이력을 불러오는 중입니다.</FeedbackBanner>;
  }

  return (
    <div className="grid gap-3">
      {state.error ? (
        <div className="grid gap-2">
          <FeedbackBanner tone="danger">{state.error}</FeedbackBanner>
          {!state.loaded ? (
            <Button variant="outline" disabled={state.loading} onClick={onLoadMore}>
              다시 시도
            </Button>
          ) : null}
        </div>
      ) : null}
      <DetailRecordList empty={empty} records={state.items} />
      {state.loaded ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            전체 {state.totalCount.toLocaleString()}건 중 {state.items.length.toLocaleString()}건
          </span>
          {state.hasMore ? (
            <Button variant="outline" disabled={state.loading} onClick={onLoadMore}>
              {state.loading ? "불러오는 중" : "이전 기록 더 보기"}
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
    [history, historyOwnerPgNo, pgNo]
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
            <SheetTitle>{requestedPgNo || "기기 상세"}</SheetTitle>
            <SheetDescription>
              선택한 기기의 상세 이력을 별도로 불러옵니다.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 px-5 py-4">
            {loading ? (
              <FeedbackBanner tone="info">
                기기 상세 정보를 불러오는 중입니다.
              </FeedbackBanner>
            ) : null}
            {error ? (
              <>
                <FeedbackBanner tone="danger">{error}</FeedbackBanner>
                {onRetry ? (
                  <Button variant="outline" onClick={onRetry}>
                    다시 시도
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
            {statusBadge(device.displayStatus)}
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
              <TabsTrigger value="basic">기본</TabsTrigger>
              <TabsTrigger value="inbound">입고</TabsTrigger>
              <TabsTrigger value="inspection">검수</TabsTrigger>
              <TabsTrigger value="order">주문</TabsTrigger>
              <TabsTrigger value="shipment">출고</TabsTrigger>
              <TabsTrigger value="return">반품</TabsTrigger>
            </TabsList>

            <TabsContent value="basic">
              <ReadOnlyDetailSection title="기기 기본 정보">
                <DescriptionList className="rounded-md border bg-background px-4">
                  <DetailRow label="PG" value={device.pgNo} />
                  <DetailRow label="모델" value={device.model} />
                  <DetailRow label="모델 코드" value={device.modelCode} />
                  <DetailRow
                    label="고유번호"
                    value={formatModelSeqLabel(device.model, device.modelSeq)}
                  />
                  <DetailRow label="IMEI" value={device.imei} />
                  <DetailRow label="용량" value={device.storage} />
                  <DetailRow label="공식 색상명" value={device.color} />
                  <DetailRow
                    label="판매등급"
                    value={<SaleGradeBadge value={device.saleGrade} />}
                  />
                  <DetailRow label="상태" value={statusBadge(device.displayStatus)} />
                  <DetailRow label="수정일시" value={formatDate(device.updatedAt)} />
                </DescriptionList>
              </ReadOnlyDetailSection>
            </TabsContent>

            <TabsContent value="inbound">
              <div className="grid gap-4">
                <ReadOnlyDetailSection title="입고 기록">
                  <HistoryDetailRecordList
                    empty="입고 정보가 없습니다."
                    state={stateFor("inbounds")}
                    onLoadMore={() => void loadHistory("inbounds", true)}
                  />
                </ReadOnlyDetailSection>
                <ReadOnlyDetailSection title="재고 상태">
                  <DetailRecordList
                    empty="재고 정보가 없습니다."
                    records={device.detailRecords.inventory}
                  />
                </ReadOnlyDetailSection>
              </div>
            </TabsContent>

            <TabsContent value="inspection">
              <div className="grid gap-4">
                <ReadOnlyDetailSection title="기능검수 기록">
                  <HistoryDetailRecordList
                    empty="기능검수 기록이 없습니다."
                    state={{
                      ...stateFor("inspections"),
                      items: functionInspectionRecords,
                    }}
                    onLoadMore={() => void loadHistory("inspections", true)}
                  />
                </ReadOnlyDetailSection>
                <ReadOnlyDetailSection title="외관검수 기록">
                  <HistoryDetailRecordList
                    empty="외관검수 기록이 없습니다."
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
                <ReadOnlyDetailSection title="판매 채널 API 원본">
                  <HistoryDetailRecordList
                    empty="기존 주문 정보가 없습니다."
                    state={stateFor("orderItems")}
                    onLoadMore={() => void loadHistory("orderItems", true)}
                  />
                </ReadOnlyDetailSection>
                <ReadOnlyDetailSection title="주문 매칭 기록">
                  <HistoryDetailRecordList
                    empty="채널 주문 매칭 정보가 없습니다."
                    state={stateFor("channelOrderMatches")}
                    onLoadMore={() =>
                      void loadHistory("channelOrderMatches", true)
                    }
                  />
                </ReadOnlyDetailSection>
              </div>
            </TabsContent>

            <TabsContent value="shipment">
              <ReadOnlyDetailSection title="출고 흐름">
                <HistoryDetailRecordList
                  empty="출고 흐름 정보가 없습니다."
                  state={stateFor("shipmentWorks")}
                  onLoadMore={() => void loadHistory("shipmentWorks", true)}
                />
              </ReadOnlyDetailSection>
            </TabsContent>

            <TabsContent value="return">
              <ReadOnlyDetailSection title="반품/교환 판단 이력">
                <HistoryDetailRecordList
                  empty="반품/교환 판단 이력이 없습니다."
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
