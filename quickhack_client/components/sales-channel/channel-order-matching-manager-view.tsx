// QuickHack note: 쿠팡 vendorItemId를 판매 상품 조합과 옵션 조건에 연결하는 주문 매칭 관리 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import type { InventoryCandidateWarning } from "@/quickhack_shared/catalog/inventory-candidate-warning";
import { useTranslations } from "next-intl";
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
  statusLabel,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import { allocationStatusLabel } from "@/quickhack_client/components/sales-channel/allocation-status-presentation";
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
    warnings: InventoryCandidateWarning[];
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

function offerDisplayLabel(offer: SalesOfferDto | null | undefined, allStorage: string, allColor: string) {
  if (!offer) {
    return "-";
  }

  const conditions = [
    offer.model,
    offer.requiredStorage || allStorage,
    offer.requiredColor || allColor,
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

function mappingStatusBadge(status: string, mapped: string, unmapped: string) {
  if (status === "MAPPED") {
    return <Badge variant="success">{mapped}</Badge>;
  }

  return <Badge variant="warning">{unmapped}</Badge>;
}

function rematchOfferLabel(offer: CoupangOrderRematchOfferPreview | null, noMapping: string, allStorage: string, allColor: string) {
  if (!offer) {
    return noMapping;
  }

  return [
    offer.model,
    offer.storage || allStorage,
    offer.color || allColor,
    offer.warrantyLabel || offer.warrantyGroup,
  ].join(" / ");
}

function rematchExclusionLabel(
  code: string,
  t: ReturnType<typeof useTranslations<"salesChannel.orderMatching">>
) {
  return t(`rematchExclusion.${code}` as never);
}

export function ChannelOrderMatchingManagerView() {
  const t = useTranslations("salesChannel.orderMatching");
  const detailT = useTranslations("common.deviceDetail");
  const manualMatchT = useTranslations("salesChannel.manualMatch");
  const sensitiveT = useTranslations("common.sensitiveRequest");
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
  const [candidateWarnings, setCandidateWarnings] = React.useState<InventoryCandidateWarning[]>([]);
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
        label: offerDisplayLabel(offer, t("common.allStorage"), t("common.allColor")),
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
    [activeOffers, t]
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
      ? `${selectedMapping.externalVendorItemId} · ${t("detail.title")}`
      : t("detail.title"),
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
        label: t("columns.option"),
        width: "minmax(260px,1fr)",
        placeholder: t("columns.productOption"),
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
        label: t("columns.offer"),
        width: "240px",
        placeholder: t("columns.offerCondition"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (mapping) => {
          const offer = mapping.salesOfferId
            ? offerById.get(mapping.salesOfferId)
            : null;

          return (
            <>
              <div className="truncate font-medium">
                {offerDisplayLabel(offer, t("common.allStorage"), t("common.allColor")) || "-"}
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
        label: t("columns.storageCondition"),
        width: "110px",
        placeholder: t("columns.storage"),
        cellClassName: "flex items-center px-3",
        render: (mapping) => mapping.requiredStorage || "-",
        text: (mapping) => mapping.requiredStorage || "",
      },
      {
        key: "requiredColor",
        label: t("columns.colorCondition"),
        width: "130px",
        placeholder: t("columns.color"),
        cellClassName: "flex items-center px-3",
        render: (mapping) => mapping.requiredColor || "-",
        text: (mapping) => mapping.requiredColor || "",
      },
      {
        key: "mappingStatus",
        label: t("columns.status"),
        width: "90px",
        placeholder: t("columns.status"),
        cellClassName: "flex items-center px-3",
        render: (mapping) => mappingStatusBadge(mapping.mappingStatus, t("common.mapped"), t("common.unmapped")),
        text: (mapping) => mapping.mappingStatus,
      },
      {
        key: "orderItemCount",
        label: t("columns.orders"),
        width: "90px",
        placeholder: t("columns.orderCount"),
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (mapping) => mapping.orderItemCount,
        text: (mapping) => String(mapping.orderItemCount),
        sortValue: (mapping) => mapping.orderItemCount,
      },
    ],
    [offerById, t]
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
          mappingPayload?.message || t("message.mappingLoadFailed")
        );
      }

      if (!offerResponse.ok || !offerPayload?.ok) {
        throw new Error(
          offerPayload?.message || t("message.offerLoadFailed")
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
  }, [t]);

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
      targetLabel: `${mapping.externalVendorItemId} · ${t("detail.title")}`,
      action: () => applySelectedMapping(mapping),
    });
  }

  function requestMappingReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [CHANNEL_PRODUCT_MAPPING_FORM_ID],
      targetLabel: t("toolbar.refresh"),
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
          fallbackMessage: t("fallback.rematchPreviewFailed"),
        });

        if (
          append &&
          rematchPreview &&
          rematchPreview.manifestToken !== data.manifestToken
        ) {
          const refreshed = await fetchCoupangOrderRematchPreview({
            limit: 100,
            fallbackMessage: t("fallback.rematchPreviewFailed"),
          });
          setRematchPreview(refreshed);
          setRematchPreviewItems(refreshed.items);
          setRematchPreviewError(
            t("rematch.refreshed")
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
    [isRematchPreviewLoading, rematchPreview, t]
  );

  function requestRematchPreview() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [CHANNEL_PRODUCT_MAPPING_FORM_ID],
      targetLabel: t("rematch.title"),
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
        rematchPreview.manifestToken,
        t("fallback.rematchExecuteFailed"),
        {
          authRequired: sensitiveT("authRequired"),
          requestFailed: sensitiveT("requestFailed"),
          verifyFailed: sensitiveT("verifyFailed"),
        }
      );
      setIsRematchConfirmOpen(false);
      setIsRematchPreviewOpen(false);
      setRematchPreview(null);
      setRematchPreviewItems([]);

      if (result.rematch.status === "FAILED") {
        setMessage(t("message.rematchAfterResetFailed"));
        setMessageTone("warning");
        return;
      }

      const summary = result.rematch.summary;
      const hasIncompleteResult =
        summary.partialItemCount > 0 ||
        summary.failedItemCount > 0 ||
        summary.conflictCount > 0 ||
        summary.deferredItemCount > 0;
      setMessage(t("message.rematchComplete", {
        allocations: result.reset.allocationCount,
        shipments: result.reset.shipmentCount,
        completed: summary.fullyMatchedItemCount,
        partial: summary.partialItemCount,
        failed: summary.failedItemCount,
      }));
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
        throw new Error(legacyApiMessage(payload, t("message.saveFailed")));
      }

      const feedback = !payload.item.mappingChanged
        ? t("message.unchanged")
        : payload.item.protectedOrderItemCount
          ? t("message.savedWithProtected", { updated: payload.item.updatedOrderItemCount ?? 0, protected: payload.item.protectedOrderItemCount })
          : t("message.saved", { updated: payload.item.updatedOrderItemCount ?? 0 });
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
        throw new Error(legacyApiMessage(payload, t("message.candidateLoadFailed")));
      }

      setCandidates(payload.data.candidates ?? []);
      setCandidateWarnings(payload.data.warnings ?? []);
    } catch {
      setCandidateWarnings([{ code: "CANDIDATE_LOAD_FAILED" }]);
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
          <SummaryCell icon={Store} label={t("summary.options")} value={mappings.length} />
          <SummaryCell icon={CheckCheck} label={t("summary.mapped")} value={mappedCount} />
          <SummaryCell icon={ListChecks} label={t("summary.unmapped")} value={unmappedCount} />
          <SummaryCell icon={Database} label={t("summary.offers")} value={activeOffers.length} />
        </SummaryStrip>

        <WorkspacePanel className="flex-1">
          <PanelToolbar className="xl:grid-cols-[320px_160px_auto_auto]">
            <SearchInput
              placeholder={t("toolbar.search")}
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
                <SelectItem value="ALL">{t("common.all")}</SelectItem>
                <SelectItem value="MAPPED">{t("common.mapped")}</SelectItem>
                <SelectItem value="UNMAPPED">{t("common.unmapped")}</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" onClick={requestMappingReload}>
              <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
              {t("toolbar.refresh")}
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={requestRematchPreview}
              disabled={isRematchPreviewLoading}
            >
              <RotateCcw className="size-4" />
              {t("toolbar.preview")}
            </Button>
          </PanelToolbar>

          <VirtualizedDataGrid
            rows={filteredMappings}
            columns={mappingColumns}
            rowKey={(mapping) => mapping.externalVendorItemId}
            emptyMessage={
              isLoading
                ? t("grid.loading")
                : t("grid.empty")
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
          <h2 className="text-sm font-semibold">{t("detail.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("detail.subtitle")}
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
                label={t("detail.option")}
                value={
                  selectedMapping.externalOptionName ||
                  selectedMapping.sample?.sellerProductItemName ||
                  selectedMapping.sample?.vendorItemName
                }
              />
              <DetailRow
                label={t("detail.productName")}
                value={selectedMapping.sample?.sellerProductName}
              />
              <DetailRow
                label={t("detail.updated")}
                value={formatDate(selectedMapping.updatedAt)}
              />
            </div>

            <SearchSelect
              label={t("detail.offer")}
              value={form.salesOfferId}
              options={activeOfferOptions}
              placeholder={t("detail.offerSearch")}
              allowEmpty
              onValueChange={(value) => updateForm("salesOfferId", value)}
            />

            {selectedOffer ? (
              <div className="rounded-md border bg-background px-3 py-2 text-sm">
                <DetailRow label={t("detail.offerCode")} value={selectedOffer.offerCode} />
                <DetailRow label={t("detail.model")} value={selectedOffer.model} />
                <DetailRow label={t("detail.storage")} value={selectedOffer.requiredStorage || t("common.allValue")} />
                <DetailRow label={t("detail.color")} value={selectedOffer.requiredColor || t("common.allValue")} />
                <DetailRow
                  label={t("detail.warranty")}
                  value={selectedOffer.warrantyLabel || warrantyGroupLabel(selectedOffer.warrantyGroup)}
                />
                <DetailRow
                  label={t("detail.offerStatus")}
                  value={selectedOffer.isActive ? t("common.active") : t("common.inactive")}
                />
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <Button onClick={saveMapping} disabled={isSaving}>
                <Save className="size-4" />
                {isSaving ? t("detail.saving") : t("detail.save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void clearMapping()}
                disabled={isSaving}
              >
                <X className="size-4" />
                {t("detail.clear")}
              </Button>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={() => void previewCandidates()}
              disabled={isPreviewLoading || selectedMapping.mappingStatus !== "MAPPED"}
            >
              <Search className="size-4" />
              {isPreviewLoading ? t("detail.previewing") : t("detail.inventoryPreview")}
            </Button>

            {candidateWarnings.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {candidateWarnings.map((warning) =>
                  t(`candidateWarning.${warning.code}` as never, warning.args as never)
                ).join(" / ")}
              </div>
            ) : null}

            <div className="rounded-md border bg-background">
              <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
                {t("detail.candidates", { count: candidates.length })}
              </div>
              <div className="max-h-80 overflow-auto">
                {candidates.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t("detail.noCandidates")}
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
                          {statusLabel(candidate.inventoryStatus || "", detailT)} / {candidate.location || t("common.noLocation")}
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
            {t("detail.select")}
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
      title={t("rematch.title")}
      description={t("rematch.subtitle")}
      icon={<AlertTriangle className="mt-0.5 size-5 text-amber-600" />}
      contentClassName="w-[min(1120px,calc(100vw-32px))]"
      bodyClassName="grid gap-4"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {rematchPreview?.hasMore
              ? t("rematch.allPages")
              : t("rematch.revalidate")}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRematchPreviewOpen(false)}
              disabled={isRematchExecuting}
            >
              {t("rematch.close")}
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
              {t("rematch.executeCount", { count: rematchPreview?.summary.eligibleShipmentCount ?? 0 })}
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
              <div className="text-xs text-muted-foreground">{t("rematch.reviewed")}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {rematchPreview.summary.candidateShipmentCount}
              </div>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="text-xs text-emerald-700">{t("rematch.eligible")}</div>
              <div className="mt-1 text-lg font-semibold text-emerald-800 tabular-nums">
                {rematchPreview.summary.eligibleShipmentCount}
              </div>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs text-amber-700">{t("rematch.excluded")}</div>
              <div className="mt-1 text-lg font-semibold text-amber-800 tabular-nums">
                {rematchPreview.summary.excludedShipmentCount}
              </div>
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("rematch.targetPg")}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {rematchPreview.summary.eligibleAllocationCount}
              </div>
            </div>
          </div>

          {rematchPreview.summary.exclusionReasonCounts.length > 0 ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="mb-2 text-xs font-semibold">{t("rematch.reasons")}</div>
              <div className="flex flex-wrap gap-2">
                {rematchPreview.summary.exclusionReasonCounts.map((reason) => (
                  <Badge key={reason.code} variant="warning">
                    {rematchExclusionLabel(reason.code, t)} {t("common.count", { count: reason.count })}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {t("rematch.privacy")}
            </span>
            <span className="shrink-0">
              {t("rematch.basis", { date: formatDate(rematchPreview.generatedAt) })}
            </span>
          </div>

          <div className="grid gap-3">
            {rematchPreviewItems.length === 0 ? (
              <div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
                {t("rematch.empty")}
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
                          {t("rematch.order", { id: shipment.externalOrderId })}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {t("rematch.shipment", { id: shipment.externalShipmentId })}
                        </span>
                        <Badge variant={shipment.eligible ? "success" : "warning"}>
                          {shipment.eligible ? t("rematch.eligible") : t("rematch.excluded")}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("rematch.shipmentSummary", { status: shipment.externalOrderStatus || t("common.noStatus"), items: shipment.itemCount, allocations: shipment.allocationCount })}
                      </div>
                    </div>
                    {!shipment.eligible ? (
                      <div className="flex max-w-xl flex-wrap justify-end gap-1">
                        {shipment.exclusionReasons.map((reason) => (
                          <Badge key={reason.code} variant="warning">
                            {rematchExclusionLabel(reason.code, t)}
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
                              {t("rematch.quantity", { id: item.externalVendorItemId, quantity: item.matchableQuantity })}
                            </div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-1">
                            {item.allocations.map((allocation) => (
                              <Badge key={allocation.allocationId} variant="neutral">
                                {allocation.pgNo} · {allocationStatusLabel(allocation.allocationStatus, manualMatchT)} · {allocation.inventoryStatus ? statusLabel(allocation.inventoryStatus, detailT) : t("common.noInventory")}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="grid gap-2 text-xs sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                          <div className="rounded bg-muted/40 px-2 py-1.5">
                            <div className="text-[11px] text-muted-foreground">{t("rematch.snapshot")}</div>
                            <div className="mt-0.5">{rematchOfferLabel(item.matchedOffer, t("common.noMapping"), t("common.allStorage"), t("common.allColor"))}</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {item.matchedOffer?.offerCode || "-"}
                            </div>
                          </div>
                          <span className="hidden text-muted-foreground sm:inline">→</span>
                          <div className="rounded bg-muted/40 px-2 py-1.5">
                            <div className="text-[11px] text-muted-foreground">{t("rematch.current")}</div>
                            <div className="mt-0.5">{rematchOfferLabel(item.currentDefaultOffer, t("common.noMapping"), t("common.allStorage"), t("common.allColor"))}</div>
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
              {t("rematch.retry")}
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
                {t("rematch.more")}
              </Button>
            ) : null}
          </div>
        </>
      ) : isRematchPreviewLoading ? (
        <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t("rematch.loading")}
        </div>
      ) : null}
    </DialogFrame>
    <DangerousConfirmDialog
      open={isRematchConfirmOpen}
      title={t("rematch.confirmTitle")}
      description={t("rematch.confirmDescription")}
      detail={
        rematchPreview ? (
          <div className="grid gap-1">
            <div>
              {t("rematch.confirmSummary", { shipments: rematchPreview.summary.eligibleShipmentCount, items: rematchPreview.summary.eligibleWorkItemCount, allocations: rematchPreview.summary.eligibleAllocationCount })}
            </div>
            <div className="text-xs font-normal">
              {t("rematch.confirmNote")}
            </div>
          </div>
        ) : null
      }
      confirmLabel={t("rematch.confirm")}
      busyLabel={t("rematch.busy")}
      isBusy={isRematchExecuting}
      onCancel={() => setIsRematchConfirmOpen(false)}
      onConfirm={() => void executeRematch()}
    />
    </>
  );
}
