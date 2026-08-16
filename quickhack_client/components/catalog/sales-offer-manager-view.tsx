// QuickHack note: 채널 상품에 연결할 판매 오퍼를 조회하고 관리합니다.
"use client";

import * as React from "react";
import {
  CheckCheck,
  Database,
  Plus,
  RefreshCcw,
  Save,
  Store,
  X,
} from "lucide-react";
import type { StatusTone } from "@/quickhack_shared/device/types";
import {
  type ProductCriteriaPayload,
} from "@/quickhack_shared/catalog/product-criteria";
import {
  WARRANTY_GROUPS,
  warrantyGroupLabel,
  type WarrantyGroupCode,
} from "@/quickhack_shared/sales-channel/sales-matching";
import { RANDOM_MATCHING_OPTION_VALUE } from "@/quickhack_shared/sales-channel/order-matching";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import { SearchSelect } from "@/quickhack_client/components/ui/search-select";
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
import { InventoryEditField } from "@/quickhack_client/components/inventory/inventory-edit-fields";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import { cn } from "@/quickhack_shared/core/utils";

type ProductCriteriaApiResponse = {
  ok: boolean;
  message?: string;
  data?: ProductCriteriaPayload;
};

type MatchMode = "EXACT" | "ANY" | "RANDOM";

export type SalesOfferDto = {
  id: number;
  revision: number;
  offerCode: string;
  modelOptionId: number;
  model: string;
  storageMatchMode: MatchMode;
  requiredStorage: string | null;
  storageOptionId: number | null;
  colorMatchMode: MatchMode;
  requiredColor: string | null;
  colorOptionId: number | null;
  warrantyGroupOptionId: number;
  warrantyGroup: string;
  warrantyLabel: string;
  isActive: boolean;
  mappedVendorItemCount: number;
  createdAt: string;
  updatedAt: string;
};

type SalesOffersApiResponse = {
  ok: boolean;
  message?: string;
  items?: SalesOfferDto[];
  item?: SalesOfferDto;
  data?: {
    distinctProductCount?: number;
    offerCount?: number;
    createdCount?: number;
    reactivatedCount?: number;
    unchangedCount?: number;
  };
};

type SalesOfferForm = {
  salesOfferId: number | null;
  expectedRevision: number | null;
  offerCode: string;
  modelOptionId: string;
  storage: string;
  color: string;
  warrantyGroupOptionId: string;
  isActive: "1" | "0";
};

function emptyForm(): SalesOfferForm {
  return {
    salesOfferId: null,
    expectedRevision: null,
    offerCode: "",
    modelOptionId: "",
    storage: "",
    color: "",
    warrantyGroupOptionId: "",
    isActive: "1",
  };
}

const SALES_OFFER_FORM_ID = "catalog.sales-offer";

function formFromItem(item: SalesOfferDto): SalesOfferForm {
  return {
    salesOfferId: item.id,
    expectedRevision: item.revision,
    offerCode: item.offerCode,
    modelOptionId: String(item.modelOptionId),
    storage:
      item.storageMatchMode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : item.storageOptionId
          ? String(item.storageOptionId)
          : "",
    color:
      item.colorMatchMode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : item.colorOptionId
          ? String(item.colorOptionId)
          : "",
    warrantyGroupOptionId: String(item.warrantyGroupOptionId),
    isActive: item.isActive ? "1" : "0",
  };
}

function optionLabel(value: string | null, mode: MatchMode) {
  if (mode === "RANDOM" || value === RANDOM_MATCHING_OPTION_VALUE) {
    return "랜덤";
  }

  return value || "전체";
}

function searchText(item: SalesOfferDto) {
  return [
    item.offerCode,
    item.model,
    item.requiredStorage,
    item.requiredColor,
    item.warrantyGroup,
    item.warrantyLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function SalesOfferManagerView() {
  const { runGuardedAction } = useUnsavedChanges();
  const [criteria, setCriteria] = React.useState<ProductCriteriaPayload | null>(null);
  const [items, setItems] = React.useState<SalesOfferDto[]>([]);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<
    "ACTIVE" | "INACTIVE" | "ALL"
  >("ACTIVE");
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [form, setForm] = React.useState<SalesOfferForm>(() => emptyForm());
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const selectedItem = React.useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );
  const formBaseline = React.useMemo(
    () => (selectedItem ? formFromItem(selectedItem) : emptyForm()),
    [selectedItem]
  );
  const discardForm = React.useCallback(() => {
    setForm(formBaseline);
    setMessage("");
  }, [formBaseline]);

  useUnsavedForm({
    id: SALES_OFFER_FORM_ID,
    label: selectedItem
      ? `${selectedItem.offerCode} 판매 오퍼`
      : "새 판매 오퍼",
    isDirty: !unsavedFormSnapshotsEqual(formBaseline, form),
    isBusy: isSaving,
    discard: discardForm,
  });

  const loadData = React.useCallback(async (preferredSelectedId?: number | null) => {
    setIsLoading(true);

    try {
      const [criteriaResponse, offerResponse] = await Promise.all([
        fetch("/api/product-criteria", { cache: "no-store" }),
        fetch("/api/catalog/sales-offers", { cache: "no-store" }),
      ]);
      const criteriaPayload = (await criteriaResponse
        .json()
        .catch(() => null)) as ProductCriteriaApiResponse | null;
      const offerPayload = (await offerResponse
        .json()
        .catch(() => null)) as SalesOffersApiResponse | null;

      if (!criteriaResponse.ok || !criteriaPayload?.ok || !criteriaPayload.data) {
        throw new Error(criteriaPayload?.message || "상품 기준값을 불러오지 못했습니다.");
      }

      if (!offerResponse.ok || !offerPayload?.ok) {
        throw new Error(offerPayload?.message || "판매 오퍼 목록을 불러오지 못했습니다.");
      }

      const nextItems = offerPayload.items ?? [];
      const nextSelected =
        nextItems.find((item) => item.id === preferredSelectedId) ??
        nextItems[0] ??
        null;
      setCriteria(criteriaPayload.data);
      setItems(nextItems);
      setSelectedId(nextSelected?.id ?? null);
      setForm(nextSelected ? formFromItem(nextSelected) : emptyForm());
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => void loadData(null));
  }, [loadData]);

  const filteredItems = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter === "ACTIVE" && !item.isActive) return false;
      if (statusFilter === "INACTIVE" && item.isActive) return false;
      return !normalized || searchText(item).includes(normalized);
    });
  }, [items, query, statusFilter]);
  const activeCriteriaOptions = React.useMemo(
    () => (criteria?.rawOptions ?? []).filter((option) => option.isActive),
    [criteria]
  );
  const modelOptions = React.useMemo(
    () =>
      activeCriteriaOptions
        .filter((option) => option.category === "PRODUCT_MODEL")
        .map((option) => ({
          value: String(option.optionId),
          label: option.label,
          description: option.optionKey,
          searchText: `${option.label} ${option.optionKey}`,
        })),
    [activeCriteriaOptions]
  );
  const linkedOptionIds = React.useCallback(
    (relationType: "MODEL_STORAGE" | "MODEL_COLOR") => {
      const modelOptionId = Number(form.modelOptionId);

      if (!Number.isInteger(modelOptionId) || modelOptionId <= 0) {
        return null;
      }

      const ids = (criteria?.rawLinks ?? [])
        .filter(
          (link) =>
            link.isActive &&
            link.parentOptionId === modelOptionId &&
            link.relationType === relationType
        )
        .map((link) => link.childOptionId);

      return ids.length > 0 ? new Set(ids) : null;
    },
    [criteria?.rawLinks, form.modelOptionId]
  );
  const storageOptions = React.useMemo(
    () => {
      const linkedIds = linkedOptionIds("MODEL_STORAGE");
      return [
        { value: RANDOM_MATCHING_OPTION_VALUE, label: "랜덤" },
        ...activeCriteriaOptions
          .filter(
            (option) =>
              option.category === "STORAGE" &&
              (!linkedIds || linkedIds.has(option.optionId))
          )
          .map((option) => ({
            value: String(option.optionId),
            label: option.label,
            description: option.optionKey,
          })),
      ];
    },
    [activeCriteriaOptions, linkedOptionIds]
  );
  const colorOptions = React.useMemo(
    () => {
      const linkedIds = linkedOptionIds("MODEL_COLOR");
      return [
        { value: RANDOM_MATCHING_OPTION_VALUE, label: "랜덤" },
        ...activeCriteriaOptions
          .filter(
            (option) =>
              option.category === "DEVICE_COLOR" &&
              (!linkedIds || linkedIds.has(option.optionId))
          )
          .map((option) => ({
            value: String(option.optionId),
            label: option.label,
            description: option.optionKey,
          })),
      ];
    },
    [activeCriteriaOptions, linkedOptionIds]
  );
  const warrantyOptions = React.useMemo(
    () =>
      activeCriteriaOptions.filter(
        (option) =>
          option.category === "WARRANTY_GROUP" &&
          WARRANTY_GROUPS.includes(option.optionKey as WarrantyGroupCode)
      ),
    [activeCriteriaOptions]
  );
  const columns = React.useMemo<
    DataGridColumn<
      "offerCode" | "model" | "storage" | "color" | "warranty" | "mappings" | "status",
      SalesOfferDto
    >[]
  >(
    () => [
      {
        key: "offerCode",
        label: "오퍼 코드",
        width: "250px",
        placeholder: "오퍼 코드",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (item) => item.offerCode,
        text: (item) => item.offerCode,
      },
      {
        key: "model",
        label: "기종",
        width: "minmax(190px,1fr)",
        placeholder: "기종",
        cellClassName: "flex items-center px-3 font-medium",
        render: (item) => item.model,
        text: (item) => item.model,
      },
      {
        key: "storage",
        label: "용량",
        width: "110px",
        placeholder: "용량",
        cellClassName: "flex items-center px-3",
        render: (item) => optionLabel(item.requiredStorage, item.storageMatchMode),
        text: (item) => optionLabel(item.requiredStorage, item.storageMatchMode),
      },
      {
        key: "color",
        label: "색상",
        width: "140px",
        placeholder: "색상",
        cellClassName: "flex items-center px-3",
        render: (item) => optionLabel(item.requiredColor, item.colorMatchMode),
        text: (item) => optionLabel(item.requiredColor, item.colorMatchMode),
      },
      {
        key: "warranty",
        label: "보증조건",
        width: "110px",
        placeholder: "보증조건",
        cellClassName: "flex items-center px-3",
        render: (item) => item.warrantyLabel || warrantyGroupLabel(item.warrantyGroup),
        text: (item) => item.warrantyLabel || warrantyGroupLabel(item.warrantyGroup),
      },
      {
        key: "mappings",
        label: "채널매핑",
        width: "100px",
        placeholder: "매핑 수",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (item) => item.mappedVendorItemCount,
        text: (item) => String(item.mappedVendorItemCount),
      },
      {
        key: "status",
        label: "상태",
        width: "90px",
        placeholder: "상태",
        cellClassName: "flex items-center px-3",
        render: (item) => (
          <Badge variant={item.isActive ? "success" : "neutral"}>
            {item.isActive ? "사용" : "비활성"}
          </Badge>
        ),
        text: (item) => (item.isActive ? "사용" : "비활성"),
      },
    ],
    []
  );

  function updateForm<K extends keyof SalesOfferForm>(key: K, value: SalesOfferForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function applyNewItem() {
    setSelectedId(null);
    setForm(emptyForm());
    setMessage("");
  }

  function newItem() {
    if (selectedId === null && unsavedFormSnapshotsEqual(form, emptyForm())) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [SALES_OFFER_FORM_ID],
      targetLabel: "새 판매 오퍼 작성",
      action: applyNewItem,
    });
  }

  function selectItem(item: SalesOfferDto) {
    if (selectedId === item.id) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [SALES_OFFER_FORM_ID],
      targetLabel: `${item.offerCode} 판매 오퍼 열기`,
      action: () => {
        setSelectedId(item.id);
        setForm(formFromItem(item));
        setMessage("");
      },
    });
  }

  function requestReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SALES_OFFER_FORM_ID],
      targetLabel: "판매 오퍼 목록 새로고침",
      action: () => {
        void loadData(selectedId);
      },
    });
  }

  function requestBootstrap() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SALES_OFFER_FORM_ID],
      targetLabel: "기본 판매 오퍼 생성",
      action: () => {
        void bootstrap();
      },
    });
  }

  async function save() {
    if (isSaving) return;
    if (
      !form.salesOfferId &&
      (!form.modelOptionId || !form.warrantyGroupOptionId)
    ) {
      setMessage("기종과 보증조건을 선택해야 합니다.");
      setMessageTone("warning");
      return;
    }

    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/catalog/sales-offers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          salesOfferId: form.salesOfferId,
          expectedRevision: form.expectedRevision,
          modelOptionId: Number(form.modelOptionId) || null,
          storageMatchMode:
            form.storage === RANDOM_MATCHING_OPTION_VALUE
              ? "RANDOM"
              : form.storage
                ? "EXACT"
                : "ANY",
          storageOptionId:
            form.storage && form.storage !== RANDOM_MATCHING_OPTION_VALUE
              ? Number(form.storage)
              : null,
          colorMatchMode:
            form.color === RANDOM_MATCHING_OPTION_VALUE
              ? "RANDOM"
              : form.color
                ? "EXACT"
                : "ANY",
          colorOptionId:
            form.color && form.color !== RANDOM_MATCHING_OPTION_VALUE
              ? Number(form.color)
              : null,
          warrantyGroupOptionId:
            Number(form.warrantyGroupOptionId) || null,
          isActive: form.isActive,
        }),
      });
      const payload = (await response.json().catch(() => null)) as SalesOffersApiResponse | null;
      if (!response.ok || !payload?.ok || !payload.item) {
        throw new Error(payload?.message || "판매 오퍼를 저장하지 못했습니다.");
      }

      await loadData(payload.item.id);
      setMessage("판매 오퍼를 저장했습니다.");
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  async function bootstrap() {
    if (isSaving) return;
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/catalog/sales-offers/bootstrap-from-criteria", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as SalesOffersApiResponse | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "기본 판매 오퍼를 생성하지 못했습니다.");
      }
      await loadData(selectedId);
      setMessage(
        `${payload.data?.distinctProductCount ?? 0}개 기종의 기본 판매 구성 ${
          payload.data?.offerCount ?? 0
        }건을 확인했습니다. 새로 생성 ${
          payload.data?.createdCount ?? 0
        }건, 다시 활성화 ${
          payload.data?.reactivatedCount ?? 0
        }건, 변경 없음 ${payload.data?.unchangedCount ?? 0}건입니다.`
      );
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  const activeCount = items.filter((item) => item.isActive).length;
  const mappedCount = items.filter((item) => item.mappedVendorItemCount > 0).length;
  const editingExisting = form.salesOfferId !== null;

  return (
    <MasterDetailLayout
      as="section"
      className="gap-4 xl:grid-cols-[minmax(0,1fr)_360px]"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <SummaryStrip className="md:grid-cols-4">
          <SummaryCell icon={Store} label="전체 오퍼" value={items.length} />
          <SummaryCell icon={CheckCheck} label="사용 중" value={activeCount} />
          <SummaryCell icon={X} label="비활성" value={items.length - activeCount} />
          <SummaryCell icon={Database} label="채널 연결" value={mappedCount} />
        </SummaryStrip>

        <WorkspacePanel className="flex-1">
          <PanelToolbar className="xl:grid-cols-[360px_180px_auto_auto]">
            <SearchInput
              placeholder="오퍼 코드, 기종, 용량, 색상 검색"
              value={query}
              onValueChange={setQuery}
            />
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">사용 중</SelectItem>
                <SelectItem value="INACTIVE">비활성</SelectItem>
                <SelectItem value="ALL">전체</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={requestReload}>
              <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
              새로고침
            </Button>
            <Button variant="outline" onClick={requestBootstrap} disabled={isSaving}>
              <Database className="size-4" />
              기본 오퍼 생성
            </Button>
          </PanelToolbar>
          <VirtualizedDataGrid
            rows={filteredItems}
            columns={columns}
            rowKey={(item) => String(item.id)}
            emptyMessage={isLoading ? "판매 오퍼를 불러오는 중입니다." : "표시할 판매 오퍼가 없습니다."}
            selectedRowKey={selectedId ? String(selectedId) : ""}
            onRowClick={selectItem}
            className="rounded-none border-0"
            minWidth="1000px"
            rowHeight={48}
          />
        </WorkspacePanel>
      </div>

      <aside className="min-h-0 overflow-auto rounded-md border bg-popover p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">판매 오퍼 편집</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              기종, 용량, 색상, 보증조건을 하나의 판매 단위로 관리합니다.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={newItem}>
            <Plus className="size-4" /> 추가
          </Button>
        </div>

        {message ? (
          <FeedbackBanner
            tone={messageTone === "success" ? "success" : "warning"}
            className="mb-4"
          >
            {message}
          </FeedbackBanner>
        ) : null}

        <div className="grid gap-3">
          <InventoryEditField
            label="오퍼 코드"
            value={form.offerCode}
            placeholder="저장 시 자동 생성"
            readOnly
            onChange={() => undefined}
          />
          <SearchSelect
            label="기종"
            value={form.modelOptionId}
            options={modelOptions}
            placeholder="기종 선택"
            allowEmpty
            disabled={editingExisting}
            onValueChange={(value) => {
              updateForm("modelOptionId", value);
              updateForm("storage", "");
              updateForm("color", "");
            }}
          />
          <SearchSelect
            label="용량 조건"
            value={form.storage}
            options={storageOptions}
            placeholder="전체 용량"
            allowEmpty
            disabled={editingExisting || !form.modelOptionId}
            onValueChange={(value) => updateForm("storage", value)}
          />
          <SearchSelect
            label="색상 조건"
            value={form.color}
            options={colorOptions}
            placeholder="전체 색상"
            allowEmpty
            disabled={editingExisting || !form.modelOptionId}
            onValueChange={(value) => updateForm("color", value)}
          />
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">보증조건</span>
            <Select
              value={form.warrantyGroupOptionId}
              disabled={editingExisting}
              onValueChange={(value) =>
                updateForm("warrantyGroupOptionId", value)
              }
            >
              <SelectTrigger><SelectValue placeholder="보증조건 선택" /></SelectTrigger>
              <SelectContent>
                {warrantyOptions.map((option) => (
                  <SelectItem
                    key={option.optionId}
                    value={String(option.optionId)}
                  >
                    {option.label || warrantyGroupLabel(option.optionKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">상태</span>
            <Select value={form.isActive} onValueChange={(value) => updateForm("isActive", value as "1" | "0")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">사용</SelectItem>
                <SelectItem value="0">비활성</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Button onClick={() => void save()} disabled={isSaving}>
            <Save className="size-4" />
            {isSaving ? "저장중" : "오퍼 저장"}
          </Button>
        </div>
      </aside>
    </MasterDetailLayout>
  );
}
