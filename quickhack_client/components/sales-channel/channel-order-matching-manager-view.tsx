// QuickHack note: 쿠팡 vendorItemId를 판매 상품 조합과 옵션 조건에 연결하는 주문 매칭 관리 화면입니다.
"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCheck,
  Database,
  ListChecks,
  Loader2,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Store,
  X,
} from "lucide-react";
import type { StatusTone } from "@/quickhack_shared/device/types";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import { warrantyGroupLabel } from "@/quickhack_shared/sales-channel/sales-matching";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { DialogFrame } from "@/quickhack_client/components/ui/dialog-frame";
import { DangerousConfirmDialog } from "@/quickhack_client/components/security/sensitive-action-guards";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  SummaryMetric as SummaryCell,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import {
  MasterDetailLayout,
  PanelToolbar,
  WorkspacePanel,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/quickhack_client/components/ui/search-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  DetailRow,
  formatDate,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import { cn } from "@/quickhack_shared/core/utils";
import {
  executeCoupangOrderRematch,
  fetchCoupangOrderRematchPreview,
  type CoupangOrderRematchOfferPreview,
  type CoupangOrderRematchPreviewData,
  type CoupangOrderRematchPreviewItem,
} from "@/quickhack_client/api/sales-channel/coupang-order-rematch-preview";

type SalesOfferDto = {
  id: number;
  offerCode: string;
  model: string;
  requiredStorage: string | null;
  requiredColor: string | null;
  warrantyGroup: string;
  warrantyLabel: string;
  isActive: boolean;
  mappedVendorItemCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

type SalesOffersApiResponse = {
  ok: boolean;
  message?: string;
  items?: SalesOfferDto[];
  count?: number;
};

type CoupangProductMappingDto = {
  id: number;
  channel: string;
  externalProductId: string | null;
  externalVendorItemId: string;
  externalOptionName: string | null;
  mappingStatus: string;
  salesOfferId: number | null;
  salesOfferCode: string | null;
  model: string | null;
  requiredStorage: string | null;
  requiredColor: string | null;
  requiredWarrantyGroup: string | null;
  requiredWarrantyLabel: string | null;
  mappedAt: string | null;
  orderItemCount: number;
  sample: {
    vendorItemName: string | null;
    sellerProductName: string | null;
    sellerProductItemName: string | null;
    externalVendorSkuCode: string | null;
  } | null;
  updatedAt: string;
};

type CoupangProductMappingsApiResponse = {
  ok: boolean;
  message?: string;
  items?: CoupangProductMappingDto[];
  count?: number;
  item?: {
    externalVendorItemId: string;
    mappingStatus: string;
    salesOfferId: number | null;
    mappingChanged: boolean;
    updatedOrderItemCount: number;
    protectedOrderItemCount: number;
    unchangedOrderItemCount: number;
  };
};

type CoupangInventoryCandidateDto = {
  pgNo: string;
  model: string;
  modelSeq: number | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  warranty: string | null;
  inventoryStatus: string | null;
  location: string | null;
};

type CoupangInventoryCandidatesApiResponse = {
  ok: boolean;
  message?: string;
  data?: {
    mappingStatus: string;
    externalVendorItemId: string;
    salesOfferId: number | null;
    salesOfferCode: string | null;
    requiredStorage: string | null;
    requiredColor: string | null;
    requiredWarrantyGroup?: string | null;
    candidates: CoupangInventoryCandidateDto[];
    warnings: string[];
  };
};

type MappingForm = {
  salesOfferId: string;
};

function emptyMappingForm(): MappingForm {
  return {
    salesOfferId: "",
  };
}

const CHANNEL_PRODUCT_MAPPING_FORM_ID =
  "sales-channel.coupang-product-mapping";

function mappingFormFromItem(item: CoupangProductMappingDto | null): MappingForm {
  return {
    salesOfferId: item?.salesOfferId ? String(item.salesOfferId) : "",
  };
}

function offerDisplayLabel(offer: SalesOfferDto | null | undefined) {
  if (!offer) {
    return "-";
  }

  const conditions = [
    offer.model,
    offer.requiredStorage || "전체 용량",
    offer.requiredColor || "전체 색상",
    offer.warrantyLabel || warrantyGroupLabel(offer.warrantyGroup),
  ];
  return conditions.join(" / ");
}

function coupangMappingSearchText(item: CoupangProductMappingDto) {
  return [
    item.externalVendorItemId,
    item.externalProductId,
    item.externalOptionName,
    item.salesOfferCode,
    item.model,
    item.requiredStorage,
    item.requiredColor,
    item.requiredWarrantyGroup,
    item.requiredWarrantyLabel,
    item.mappingStatus,
    item.sample?.vendorItemName,
    item.sample?.sellerProductName,
    item.sample?.sellerProductItemName,
    item.sample?.externalVendorSkuCode,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function mappingStatusBadge(status: string) {
  if (status === "MAPPED") {
    return <Badge variant="success">매핑됨</Badge>;
  }

  return <Badge variant="warning">미매핑</Badge>;
}

function rematchOfferLabel(offer: CoupangOrderRematchOfferPreview | null) {
  if (!offer) {
    return "매핑 없음";
  }

  return [
    offer.model,
    offer.storage || "전체 용량",
    offer.color || "전체 색상",
    offer.warrantyLabel || offer.warrantyGroup,
  ].join(" / ");
}

export function ChannelOrderMatchingManagerView() {
  const { runGuardedAction } = useUnsavedChanges();
  const [mappings, setMappings] = React.useState<CoupangProductMappingDto[]>([]);
  const [offers, setOffers] = React.useState<SalesOfferDto[]>([]);
  const [selectedVendorItemId, setSelectedVendorItemId] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<
    "ALL" | "MAPPED" | "UNMAPPED"
  >("ALL");
  const [form, setForm] = React.useState<MappingForm>(() => emptyMappingForm());
  const [candidates, setCandidates] = React.useState<
    CoupangInventoryCandidateDto[]
  >([]);
  const [candidateWarnings, setCandidateWarnings] = React.useState<string[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false);
  const [isRematchPreviewOpen, setIsRematchPreviewOpen] = React.useState(false);
  const [isRematchPreviewLoading, setIsRematchPreviewLoading] =
    React.useState(false);
  const [rematchPreview, setRematchPreview] =
    React.useState<CoupangOrderRematchPreviewData | null>(null);
  const [rematchPreviewItems, setRematchPreviewItems] = React.useState<
    CoupangOrderRematchPreviewItem[]
  >([]);
  const [rematchPreviewError, setRematchPreviewError] = React.useState("");
  const [isRematchConfirmOpen, setIsRematchConfirmOpen] = React.useState(false);
  const [isRematchExecuting, setIsRematchExecuting] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const selectedVendorItemIdRef = React.useRef("");

  const offerById = React.useMemo(
    () => new Map(offers.map((offer) => [offer.id, offer])),
    [offers]
  );
  const activeOffers = React.useMemo(
    () => offers.filter((offer) => offer.isActive),
    [offers]
  );
  const activeOfferOptions = React.useMemo<SearchSelectOption[]>(
    () =>
      activeOffers.map((offer) => ({
        value: String(offer.id),
        label: offerDisplayLabel(offer),
        description: offer.offerCode,
        searchText: [
          offer.offerCode,
          offer.model,
          offer.requiredStorage,
          offer.requiredColor,
          offer.warrantyGroup,
          offer.warrantyLabel,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      })),
    [activeOffers]
  );
  const selectedMapping = React.useMemo(
    () =>
      mappings.find(
        (mapping) => mapping.externalVendorItemId === selectedVendorItemId
      ) ?? null,
    [mappings, selectedVendorItemId]
  );
  const mappingBaseline = React.useMemo(
    () => mappingFormFromItem(selectedMapping),
    [selectedMapping]
  );
  const discardMappingDraft = React.useCallback(() => {
    setForm(mappingBaseline);
    setCandidates([]);
    setCandidateWarnings([]);
    setMessage("");
  }, [mappingBaseline]);

  useUnsavedForm({
    id: CHANNEL_PRODUCT_MAPPING_FORM_ID,
    label: selectedMapping
      ? `${selectedMapping.externalVendorItemId} 채널 주문 매핑`
      : "채널 주문 매핑",
    enabled: selectedMapping !== null,
    isDirty:
      selectedMapping !== null &&
      !unsavedFormSnapshotsEqual(mappingBaseline, form),
    isBusy: isSaving,
    discard: discardMappingDraft,
  });
  const selectedOffer = form.salesOfferId
    ? offerById.get(Number(form.salesOfferId)) ?? null
    : null;
  const filteredMappings = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return mappings.filter((mapping) => {
      if (statusFilter !== "ALL" && mapping.mappingStatus !== statusFilter) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return coupangMappingSearchText(mapping).includes(normalizedQuery);
    });
  }, [mappings, query, statusFilter]);
  const mappingColumns = React.useMemo<
    DataGridColumn<
      | "externalVendorItemId"
      | "externalOptionName"
      | "salesOfferCode"
      | "requiredStorage"
      | "requiredColor"
      | "mappingStatus"
      | "orderItemCount",
      CoupangProductMappingDto
    >[]
  >(
    () => [
      {
        key: "externalVendorItemId",
        label: "vendorItemId",
        width: "170px",
        placeholder: "vendorItemId",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (mapping) => mapping.externalVendorItemId,
        text: (mapping) => mapping.externalVendorItemId,
      },
      {
        key: "externalOptionName",
        label: "쿠팡 옵션",
        width: "minmax(260px,1fr)",
        placeholder: "상품/옵션",
        cellClassName: "min-w-0 px-3 py-2",
        render: (mapping) => (
          <>
            <div className="truncate font-medium">
              {mapping.externalOptionName ||
                mapping.sample?.sellerProductItemName ||
                mapping.sample?.vendorItemName ||
                "-"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {mapping.sample?.sellerProductName ||
                mapping.sample?.externalVendorSkuCode ||
                mapping.externalProductId ||
                "-"}
            </div>
          </>
        ),
        text: (mapping) =>
          [
            mapping.externalOptionName,
            mapping.sample?.sellerProductItemName,
            mapping.sample?.vendorItemName,
            mapping.sample?.sellerProductName,
            mapping.sample?.externalVendorSkuCode,
            mapping.externalProductId,
          ]
            .filter(Boolean)
            .join(" "),
      },
      {
        key: "salesOfferCode",
        label: "판매 오퍼",
        width: "240px",
        placeholder: "기종/조건/보증",
        cellClassName: "min-w-0 px-3 py-2",
        render: (mapping) => {
          const offer = mapping.salesOfferId
            ? offerById.get(mapping.salesOfferId)
            : null;

          return (
            <>
              <div className="truncate font-medium">
                {offerDisplayLabel(offer) || "-"}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {mapping.salesOfferCode || "-"}
              </div>
            </>
          );
        },
        text: (mapping) => {
          const offer = mapping.salesOfferId
            ? offerById.get(mapping.salesOfferId)
            : null;

          return [
            mapping.salesOfferCode,
            offer?.model,
            offer?.requiredStorage,
            offer?.requiredColor,
            offer?.warrantyLabel,
            mapping.requiredWarrantyLabel,
          ]
            .filter(Boolean)
            .join(" ");
        },
      },
      {
        key: "requiredStorage",
        label: "용량 조건",
        width: "110px",
        placeholder: "용량",
        cellClassName: "flex items-center px-3",
        render: (mapping) => mapping.requiredStorage || "-",
        text: (mapping) => mapping.requiredStorage || "",
      },
      {
        key: "requiredColor",
        label: "색상 조건",
        width: "130px",
        placeholder: "색상",
        cellClassName: "flex items-center px-3",
        render: (mapping) => mapping.requiredColor || "-",
        text: (mapping) => mapping.requiredColor || "",
      },
      {
        key: "mappingStatus",
        label: "상태",
        width: "90px",
        placeholder: "상태",
        cellClassName: "flex items-center px-3",
        render: (mapping) => mappingStatusBadge(mapping.mappingStatus),
        text: (mapping) => mapping.mappingStatus,
      },
      {
        key: "orderItemCount",
        label: "주문",
        width: "90px",
        placeholder: "주문 수",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (mapping) => mapping.orderItemCount,
        text: (mapping) => String(mapping.orderItemCount),
        sortValue: (mapping) => mapping.orderItemCount,
      },
    ],
    [offerById]
  );
  const mappedCount = mappings.filter(
    (mapping) => mapping.mappingStatus === "MAPPED"
  ).length;
  const unmappedCount = mappings.length - mappedCount;

  const loadData = React.useCallback(async () => {
    setIsLoading(true);

    try {
      const [mappingResponse, offerResponse] = await Promise.all([
        fetch("/api/coupang/product-mappings", { cache: "no-store" }),
        fetch("/api/catalog/sales-offers", { cache: "no-store" }),
      ]);
      const mappingPayload = (await mappingResponse
        .json()
        .catch(() => null)) as CoupangProductMappingsApiResponse | null;
      const offerPayload = (await offerResponse
        .json()
        .catch(() => null)) as SalesOffersApiResponse | null;

      if (!mappingResponse.ok || !mappingPayload?.ok) {
        throw new Error(
          mappingPayload?.message || "쿠팡 상품 매핑 목록을 불러오지 못했습니다."
        );
      }

      if (!offerResponse.ok || !offerPayload?.ok) {
        throw new Error(
          offerPayload?.message || "판매 오퍼 목록을 불러오지 못했습니다."
        );
      }

      const nextMappings = mappingPayload.items ?? [];
      const currentVendorItemId = selectedVendorItemIdRef.current;
      const nextVendorItemId =
        currentVendorItemId &&
        nextMappings.some(
          (mapping) => mapping.externalVendorItemId === currentVendorItemId
        )
          ? currentVendorItemId
          : nextMappings[0]?.externalVendorItemId ?? "";
      const nextSelectedMapping =
        nextMappings.find(
          (mapping) => mapping.externalVendorItemId === nextVendorItemId
        ) ?? null;

      selectedVendorItemIdRef.current = nextVendorItemId;
      setMappings(nextMappings);
      setOffers(offerPayload.items ?? []);
      setSelectedVendorItemId(nextVendorItemId);
      setForm(mappingFormFromItem(nextSelectedMapping));
      setCandidates([]);
      setCandidateWarnings([]);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadData();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadData]);

  function updateForm(key: keyof MappingForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setCandidates([]);
    setCandidateWarnings([]);
  }

  function applySelectedMapping(mapping: CoupangProductMappingDto) {
    selectedVendorItemIdRef.current = mapping.externalVendorItemId;
    setSelectedVendorItemId(mapping.externalVendorItemId);
    setForm(mappingFormFromItem(mapping));
    setCandidates([]);
    setCandidateWarnings([]);
    setMessage("");
  }

  function selectMapping(mapping: CoupangProductMappingDto) {
    if (selectedVendorItemId === mapping.externalVendorItemId) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [CHANNEL_PRODUCT_MAPPING_FORM_ID],
      targetLabel: `${mapping.externalVendorItemId} 매핑 열기`,
      action: () => applySelectedMapping(mapping),
    });
  }

  function requestMappingReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [CHANNEL_PRODUCT_MAPPING_FORM_ID],
      targetLabel: "채널 주문 매핑 새로고침",
      action: () => {
        void loadData();
      },
    });
  }

  const loadRematchPreview = React.useCallback(
    async (cursor: number | null = null, append = false) => {
      if (isRematchPreviewLoading) {
        return;
      }

      setIsRematchPreviewLoading(true);
      setRematchPreviewError("");

      try {
        const data = await fetchCoupangOrderRematchPreview({
          cursor,
          limit: 100,
        });

        if (
          append &&
          rematchPreview &&
          rematchPreview.manifestToken !== data.manifestToken
        ) {
          const refreshed = await fetchCoupangOrderRematchPreview({ limit: 100 });
          setRematchPreview(refreshed);
          setRematchPreviewItems(refreshed.items);
          setRematchPreviewError(
            "목록을 확인하는 동안 주문 상태가 변경되어 첫 페이지부터 다시 표시했습니다."
          );
          return;
        }

        setRematchPreview(data);
        setRematchPreviewItems((current) =>
          append ? [...current, ...data.items] : data.items
        );
      } catch (error) {
        setRematchPreviewError(
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        setIsRematchPreviewLoading(false);
      }
    },
    [isRematchPreviewLoading, rematchPreview]
  );

  function requestRematchPreview() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [CHANNEL_PRODUCT_MAPPING_FORM_ID],
      targetLabel: "기존 주문 재매칭 대상 확인",
      action: () => {
        setIsRematchPreviewOpen(true);
        setIsRematchConfirmOpen(false);
        setRematchPreview(null);
        setRematchPreviewItems([]);
        setRematchPreviewError("");
        void loadRematchPreview();
      },
    });
  }

  async function executeRematch() {
    if (!rematchPreview || rematchPreview.hasMore || isRematchExecuting) {
      return;
    }

    setIsRematchExecuting(true);
    setRematchPreviewError("");

    try {
      const result = await executeCoupangOrderRematch(
        rematchPreview.manifestToken
      );
      setIsRematchConfirmOpen(false);
      setIsRematchPreviewOpen(false);
      setRematchPreview(null);
      setRematchPreviewItems([]);

      if (result.rematch.status === "FAILED") {
        setMessage(result.rematch.message);
        setMessageTone("warning");
        return;
      }

      const summary = result.rematch.summary;
      const hasIncompleteResult =
        summary.partialItemCount > 0 ||
        summary.failedItemCount > 0 ||
        summary.conflictCount > 0 ||
        summary.deferredItemCount > 0;
      setMessage(
        `기존 배정 ${result.reset.allocationCount}건을 해제하고 주문 ${result.reset.shipmentCount}건을 다시 매칭했습니다. ` +
          `완료 ${summary.fullyMatchedItemCount}건, 부분 ${summary.partialItemCount}건, 실패 ${summary.failedItemCount}건입니다.`
      );
      setMessageTone(hasIncompleteResult ? "warning" : "success");
    } catch (error) {
      setIsRematchConfirmOpen(false);
      setRematchPreviewError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsRematchExecuting(false);
    }
  }

  async function submitMapping(nextForm: MappingForm) {
    if (!selectedMapping || isSaving) {
      return;
    }

    const salesOfferId = Number(nextForm.salesOfferId || 0) || null;

    setIsSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/coupang/product-mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "set",
          externalVendorItemId: selectedMapping.externalVendorItemId,
          salesOfferId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | CoupangProductMappingsApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.item) {
        throw new Error(payload?.message || "매칭 기준을 저장하지 못했습니다.");
      }

      const feedback = !payload.item.mappingChanged
        ? "동일한 매칭 기준입니다. 저장된 데이터는 변경하지 않았습니다."
        : payload.item.protectedOrderItemCount
          ? `매칭 기준을 저장했습니다. 변경 가능한 주문 ${payload.item.updatedOrderItemCount ?? 0}건에 반영했고, 진행 또는 완료 이력이 있는 주문 ${payload.item.protectedOrderItemCount}건은 기존 매핑을 유지했습니다.`
          : `매칭 기준을 저장했습니다. 변경 가능한 주문 ${payload.item.updatedOrderItemCount ?? 0}건에 반영했습니다.`;
      await loadData();
      setMessage(feedback);
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveMapping() {
    await submitMapping(form);
  }

  async function clearMapping() {
    const nextForm = emptyMappingForm();

    setForm(nextForm);
    await submitMapping(nextForm);
  }

  async function previewCandidates() {
    if (!selectedMapping || isPreviewLoading) {
      return;
    }

    setIsPreviewLoading(true);
    setCandidateWarnings([]);
    setCandidates([]);

    try {
      const response = await fetch(
        `/api/coupang/inventory-candidates?externalVendorItemId=${encodeURIComponent(
          selectedMapping.externalVendorItemId
        )}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | CoupangInventoryCandidatesApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.data) {
        throw new Error(payload?.message || "재고 후보를 조회하지 못했습니다.");
      }

      setCandidates(payload.data.candidates ?? []);
      setCandidateWarnings(payload.data.warnings ?? []);
    } catch (error) {
      setCandidateWarnings([
        error instanceof Error ? error.message : String(error),
      ]);
    } finally {
      setIsPreviewLoading(false);
    }
  }

  return (
    <>
    <MasterDetailLayout
      as="section"
      className="grid-cols-[minmax(620px,1fr)_460px] gap-4 p-5"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <SummaryStrip className="grid-cols-4">
          <SummaryCell icon={Store} label="쿠팡 옵션" value={mappings.length} />
          <SummaryCell icon={CheckCheck} label="매핑됨" value={mappedCount} />
          <SummaryCell icon={ListChecks} label="미매핑" value={unmappedCount} />
          <SummaryCell icon={Database} label="활성 오퍼" value={activeOffers.length} />
        </SummaryStrip>

        <WorkspacePanel className="flex-1">
          <PanelToolbar className="xl:grid-cols-[320px_160px_auto_auto]">
            <SearchInput
              placeholder="vendorItemId, 상품명, 기종, 보증, 용량, 색상 검색"
              value={query}
              onValueChange={setQuery}
            />

            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as "ALL" | "MAPPED" | "UNMAPPED")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">전체</SelectItem>
                <SelectItem value="MAPPED">매핑됨</SelectItem>
                <SelectItem value="UNMAPPED">미매핑</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" onClick={requestMappingReload}>
              <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
              새로고침
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={requestRematchPreview}
              disabled={isRematchPreviewLoading}
            >
              <RotateCcw className="size-4" />
              재매칭 대상 확인
            </Button>
          </PanelToolbar>

          <VirtualizedDataGrid
            rows={filteredMappings}
            columns={mappingColumns}
            rowKey={(mapping) => mapping.externalVendorItemId}
            emptyMessage={
              isLoading
                ? "쿠팡 상품 매핑 목록을 불러오는 중입니다."
                : "표시할 쿠팡 상품 매핑이 없습니다."
            }
            selectedRowKey={selectedVendorItemId}
            onRowClick={selectMapping}
            className="rounded-none border-0"
            minWidth="1160px"
            rowHeight={58}
          />
        </WorkspacePanel>
      </div>

      <aside className="min-h-0 overflow-auto rounded-md border bg-popover p-4">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">채널 주문 매칭 기준</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            쿠팡 vendorItemId를 QuickHack의 기종/보증조건 조합과 용량/색상 조건에 연결합니다.
          </p>
        </div>

        {message ? (
          <FeedbackBanner
            tone={messageTone === "success" ? "success" : "warning"}
            className="mb-4"
          >
            {message}
          </FeedbackBanner>
        ) : null}

        {selectedMapping ? (
          <div className="grid gap-4">
            <div className="rounded-md border bg-background px-3 py-2">
              <DetailRow
                label="vendorItemId"
                value={selectedMapping.externalVendorItemId}
              />
              <DetailRow
                label="쿠팡 옵션"
                value={
                  selectedMapping.externalOptionName ||
                  selectedMapping.sample?.sellerProductItemName ||
                  selectedMapping.sample?.vendorItemName
                }
              />
              <DetailRow
                label="상품명"
                value={selectedMapping.sample?.sellerProductName}
              />
              <DetailRow
                label="최근 수정"
                value={formatDate(selectedMapping.updatedAt)}
              />
            </div>

            <SearchSelect
              label="판매 오퍼"
              value={form.salesOfferId}
              options={activeOfferOptions}
              placeholder="기종, 용량, 색상 또는 보증조건 검색"
              allowEmpty
              onValueChange={(value) => updateForm("salesOfferId", value)}
            />

            {selectedOffer ? (
              <div className="rounded-md border bg-background px-3 py-2 text-sm">
                <DetailRow label="오퍼 코드" value={selectedOffer.offerCode} />
                <DetailRow label="기종" value={selectedOffer.model} />
                <DetailRow label="용량" value={selectedOffer.requiredStorage || "전체"} />
                <DetailRow label="색상" value={selectedOffer.requiredColor || "전체"} />
                <DetailRow
                  label="보증조건"
                  value={selectedOffer.warrantyLabel || warrantyGroupLabel(selectedOffer.warrantyGroup)}
                />
                <DetailRow
                  label="오퍼 상태"
                  value={selectedOffer.isActive ? "활성" : "비활성"}
                />
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <Button onClick={saveMapping} disabled={isSaving}>
                <Save className="size-4" />
                {isSaving ? "저장중" : "매칭 저장"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void clearMapping()}
                disabled={isSaving}
              >
                <X className="size-4" />
                매핑 해제
              </Button>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={() => void previewCandidates()}
              disabled={isPreviewLoading || selectedMapping.mappingStatus !== "MAPPED"}
            >
              <Search className="size-4" />
              {isPreviewLoading ? "조회중" : "재고 후보 미리보기"}
            </Button>

            {candidateWarnings.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {candidateWarnings.join(" / ")}
              </div>
            ) : null}

            <div className="rounded-md border bg-background">
              <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
                재고 후보 {candidates.length}건
              </div>
              <div className="max-h-80 overflow-auto">
                {candidates.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    조회된 재고 후보가 없습니다.
                  </div>
                ) : (
                  <div className="divide-y">
                    {candidates.map((candidate) => (
                      <div key={candidate.pgNo} className="grid gap-1 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold">
                            {candidate.pgNo}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatModelSeqLabel(candidate.model, candidate.modelSeq)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          {[candidate.model, candidate.storage, candidate.color]
                            .filter(Boolean)
                            .map((value) => (
                              <span key={value}>{value}</span>
                            ))}
                          {candidate.saleGrade ? (
                            <SaleGradeBadge
                              value={candidate.saleGrade}
                              className="ml-1 px-1.5"
                            />
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {candidate.inventoryStatus || "-"} / {candidate.location || "위치 없음"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
            왼쪽 표에서 쿠팡 옵션을 선택하세요.
          </div>
        )}
      </aside>
    </MasterDetailLayout>

    <DialogFrame
      open={isRematchPreviewOpen}
      onOpenChange={(open) => {
        if (isRematchExecuting) {
          return;
        }

        setIsRematchPreviewOpen(open);

        if (!open) {
          setIsRematchConfirmOpen(false);
        }
      }}
      title="기존 주문 재매칭 대상 확인"
      description="매칭 완료 후 아직 출고 작업에 전달되지 않은 출고 건을 확인합니다. 전체 목록을 확인한 뒤 별도 확인 단계에서 재매칭할 수 있습니다."
      icon={<AlertTriangle className="mt-0.5 size-5 text-amber-600" />}
      contentClassName="w-[min(1120px,calc(100vw-32px))]"
      bodyClassName="grid gap-4"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {rematchPreview?.hasMore
              ? "모든 페이지를 확인해야 재매칭을 실행할 수 있습니다."
              : "실행 시점에 재매칭 대상만 다시 잠금·검증합니다."}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRematchPreviewOpen(false)}
              disabled={isRematchExecuting}
            >
              닫기
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
              onClick={() => setIsRematchConfirmOpen(true)}
              disabled={
                !rematchPreview ||
                rematchPreview.hasMore ||
                rematchPreview.summary.eligibleShipmentCount === 0 ||
                isRematchPreviewLoading ||
                isRematchExecuting
              }
            >
              <RotateCcw className="size-4" />
              대상 {rematchPreview?.summary.eligibleShipmentCount ?? 0}건 재매칭
            </Button>
          </div>
        </div>
      }
    >
      {rematchPreviewError ? (
        <FeedbackBanner tone="warning">{rematchPreviewError}</FeedbackBanner>
      ) : null}

      {rematchPreview ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-xs text-muted-foreground">검토 출고 건</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {rematchPreview.summary.candidateShipmentCount}
              </div>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="text-xs text-emerald-700">재매칭 대상</div>
              <div className="mt-1 text-lg font-semibold text-emerald-800 tabular-nums">
                {rematchPreview.summary.eligibleShipmentCount}
              </div>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs text-amber-700">제외</div>
              <div className="mt-1 text-lg font-semibold text-amber-800 tabular-nums">
                {rematchPreview.summary.excludedShipmentCount}
              </div>
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-xs text-muted-foreground">대상 PG</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {rematchPreview.summary.eligibleAllocationCount}
              </div>
            </div>
          </div>

          {rematchPreview.summary.exclusionReasonCounts.length > 0 ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="mb-2 text-xs font-semibold">제외 사유</div>
              <div className="flex flex-wrap gap-2">
                {rematchPreview.summary.exclusionReasonCounts.map((reason) => (
                  <Badge key={reason.code} variant="warning">
                    {reason.label} {reason.count}건
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              주문번호와 배송번호 단위로 전체 품목을 판정합니다. 수취인·주소·전화번호는 조회하지 않습니다.
            </span>
            <span className="shrink-0">
              기준 {formatDate(rematchPreview.generatedAt)}
            </span>
          </div>

          <div className="grid gap-3">
            {rematchPreviewItems.length === 0 ? (
              <div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
                확인할 매칭 완료 출고 건이 없습니다.
              </div>
            ) : (
              rematchPreviewItems.map((shipment) => (
                <div
                  key={`${shipment.externalOrderId}:${shipment.externalShipmentId}`}
                  className={cn(
                    "rounded-md border bg-background",
                    shipment.eligible
                      ? "border-emerald-200"
                      : "border-amber-200"
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b px-3 py-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold">
                          주문 {shipment.externalOrderId}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          배송 {shipment.externalShipmentId}
                        </span>
                        <Badge variant={shipment.eligible ? "success" : "warning"}>
                          {shipment.eligible ? "재매칭 대상" : "제외"}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        쿠팡 {shipment.externalOrderStatus || "상태 없음"} · 품목 {shipment.itemCount}건 · PG {shipment.allocationCount}대
                      </div>
                    </div>
                    {!shipment.eligible ? (
                      <div className="flex max-w-xl flex-wrap justify-end gap-1">
                        {shipment.exclusionReasons.map((reason) => (
                          <Badge key={reason.code} variant="warning">
                            {reason.label}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="divide-y">
                    {shipment.items.map((item) => (
                      <div key={item.workItemId} className="grid gap-2 px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {item.vendorItemName || item.externalVendorItemId}
                            </div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              vendorItemId {item.externalVendorItemId} · 수량 {item.matchableQuantity}
                            </div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-1">
                            {item.allocations.map((allocation) => (
                              <Badge key={allocation.allocationId} variant="neutral">
                                {allocation.pgNo} · {allocation.allocationStatus} · {allocation.inventoryStatus || "재고 없음"}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="grid gap-2 text-xs sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                          <div className="rounded bg-muted/40 px-2 py-1.5">
                            <div className="text-[11px] text-muted-foreground">기존 주문 스냅샷</div>
                            <div className="mt-0.5">{rematchOfferLabel(item.matchedOffer)}</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {item.matchedOffer?.offerCode || "-"}
                            </div>
                          </div>
                          <span className="hidden text-muted-foreground sm:inline">→</span>
                          <div className="rounded bg-muted/40 px-2 py-1.5">
                            <div className="text-[11px] text-muted-foreground">현재 기본 매핑</div>
                            <div className="mt-0.5">{rematchOfferLabel(item.currentDefaultOffer)}</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {item.currentDefaultOffer?.offerCode || "-"}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRematchPreview(null);
                setRematchPreviewItems([]);
                void loadRematchPreview();
              }}
              disabled={isRematchPreviewLoading}
            >
              <RefreshCcw className={cn("size-4", isRematchPreviewLoading && "animate-spin")} />
              다시 판정
            </Button>
            {rematchPreview.hasMore && rematchPreview.nextCursor ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void loadRematchPreview(rematchPreview.nextCursor, true)
                }
                disabled={isRematchPreviewLoading}
              >
                {isRematchPreviewLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                다음 대상 더 보기
              </Button>
            ) : null}
          </div>
        </>
      ) : isRematchPreviewLoading ? (
        <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          재매칭 대상과 제외 사유를 판정하는 중입니다.
        </div>
      ) : null}
    </DialogFrame>
    <DangerousConfirmDialog
      open={isRematchConfirmOpen}
      title="기존 미포장 주문을 다시 매칭합니다"
      description="표시된 모든 대상의 기존 PG 배정을 해제하고 현재 기본 상품 매핑으로 다시 매칭합니다. 표시 후 상태가 바뀌었다면 전체 작업을 중단합니다."
      detail={
        rematchPreview ? (
          <div className="grid gap-1">
            <div>
              출고 건 {rematchPreview.summary.eligibleShipmentCount}건 · 주문 항목{" "}
              {rematchPreview.summary.eligibleWorkItemCount}건 · PG{" "}
              {rematchPreview.summary.eligibleAllocationCount}대
            </div>
            <div className="text-xs font-normal">
              대상 목록의 주문번호·배송번호·PG를 다시 확인한 뒤 실행하세요.
            </div>
          </div>
        ) : null
      }
      confirmLabel="배정 해제 후 재매칭"
      busyLabel="재매칭 중"
      isBusy={isRematchExecuting}
      onCancel={() => setIsRematchConfirmOpen(false)}
      onConfirm={() => void executeRematch()}
    />
    </>
  );
}
