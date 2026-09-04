// QuickHack note: 채널 상품에 연결할 판매 오퍼를 조회하고 관리합니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
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

function optionLabel(
  value: string | null,
  mode: MatchMode,
  randomLabel: string,
  allLabel: string
) {
  if (mode === "RANDOM" || value === RANDOM_MATCHING_OPTION_VALUE) {
    return randomLabel;
  }

  return value || allLabel;
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
  const t = useTranslations("catalog.salesOffer");
  const warrantyFallbackLabels = React.useMemo<Record<string, string>>(() => ({
    "2Y": t("warranty.twoYear"),
    "1Y": t("warranty.oneYear"),
  }), [t]);
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
      ? t("form.selected", { code: selectedItem.offerCode })
      : t("form.new"),
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
        throw new Error(criteriaPayload?.message || t("message.criteriaLoadFailed"));
      }

      if (!offerResponse.ok || !offerPayload?.ok) {
        throw new Error(offerPayload?.message || t("message.listLoadFailed"));
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
  }, [t]);

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
        { value: RANDOM_MATCHING_OPTION_VALUE, label: t("common.random") },
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
    [activeCriteriaOptions, linkedOptionIds, t]
  );
  const colorOptions = React.useMemo(
    () => {
      const linkedIds = linkedOptionIds("MODEL_COLOR");
      return [
        { value: RANDOM_MATCHING_OPTION_VALUE, label: t("common.random") },
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
    [activeCriteriaOptions, linkedOptionIds, t]
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
        label: t("columns.code"),
        width: "250px",
        placeholder: t("columns.code"),
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (item) => item.offerCode,
        text: (item) => item.offerCode,
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(190px,1fr)",
        placeholder: t("columns.model"),
        cellClassName: "flex items-center px-3 font-medium",
        render: (item) => item.model,
        text: (item) => item.model,
      },
      {
        key: "storage",
        label: t("columns.storage"),
        width: "110px",
        placeholder: t("columns.storage"),
        cellClassName: "flex items-center px-3",
        render: (item) => optionLabel(item.requiredStorage, item.storageMatchMode, t("common.random"), t("common.all")),
        text: (item) => optionLabel(item.requiredStorage, item.storageMatchMode, t("common.random"), t("common.all")),
      },
      {
        key: "color",
        label: t("columns.color"),
        width: "140px",
        placeholder: t("columns.color"),
        cellClassName: "flex items-center px-3",
        render: (item) => optionLabel(item.requiredColor, item.colorMatchMode, t("common.random"), t("common.all")),
        text: (item) => optionLabel(item.requiredColor, item.colorMatchMode, t("common.random"), t("common.all")),
      },
      {
        key: "warranty",
        label: t("columns.warranty"),
        width: "110px",
        placeholder: t("columns.warranty"),
        cellClassName: "flex items-center px-3",
        render: (item) => item.warrantyLabel || warrantyFallbackLabels[item.warrantyGroup] || "-",
        text: (item) => item.warrantyLabel || warrantyFallbackLabels[item.warrantyGroup] || "-",
      },
      {
        key: "mappings",
        label: t("columns.mappings"),
        width: "100px",
        placeholder: t("columns.mappingCount"),
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (item) => item.mappedVendorItemCount,
        text: (item) => String(item.mappedVendorItemCount),
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "90px",
        placeholder: t("columns.status"),
        cellClassName: "flex items-center px-3",
        render: (item) => (
          <Badge variant={item.isActive ? "success" : "neutral"}>
            {item.isActive ? t("common.active") : t("common.inactive")}
          </Badge>
        ),
        text: (item) => item.isActive ? t("common.active") : t("common.inactive"),
      },
    ],
    [t, warrantyFallbackLabels]
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
      targetLabel: t("unsaved.new"),
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
      targetLabel: t("unsaved.open", { code: item.offerCode }),
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
      targetLabel: t("unsaved.reload"),
      action: () => {
        void loadData(selectedId);
      },
    });
  }

  function requestBootstrap() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SALES_OFFER_FORM_ID],
      targetLabel: t("unsaved.bootstrap"),
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
      setMessage(t("message.required"));
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
        throw new Error(legacyApiMessage(payload, t("message.saveFailed")));
      }

      await loadData(payload.item.id);
      setMessage(t("message.saved"));
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
        throw new Error(legacyApiMessage(payload, t("message.bootstrapFailed")));
      }
      await loadData(selectedId);
      setMessage(t("message.bootstrapResult", {
        products: payload.data?.distinctProductCount ?? 0,
        offers: payload.data?.offerCount ?? 0,
        created: payload.data?.createdCount ?? 0,
        reactivated: payload.data?.reactivatedCount ?? 0,
        unchanged: payload.data?.unchangedCount ?? 0,
      }));
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
          <SummaryCell icon={Store} label={t("summary.total")} value={items.length} />
          <SummaryCell icon={CheckCheck} label={t("summary.active")} value={activeCount} />
          <SummaryCell icon={X} label={t("summary.inactive")} value={items.length - activeCount} />
          <SummaryCell icon={Database} label={t("summary.mapped")} value={mappedCount} />
        </SummaryStrip>

        <WorkspacePanel className="flex-1">
          <PanelToolbar className="xl:grid-cols-[360px_180px_auto_auto]">
            <SearchInput
              placeholder={t("toolbar.search")}
              value={query}
              onValueChange={setQuery}
            />
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">{t("toolbar.active")}</SelectItem>
                <SelectItem value="INACTIVE">{t("toolbar.inactive")}</SelectItem>
                <SelectItem value="ALL">{t("toolbar.all")}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={requestReload}>
              <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
              {t("toolbar.refresh")}
            </Button>
            <Button variant="outline" onClick={requestBootstrap} disabled={isSaving}>
              <Database className="size-4" />
              {t("toolbar.bootstrap")}
            </Button>
          </PanelToolbar>
          <VirtualizedDataGrid
            rows={filteredItems}
            columns={columns}
            rowKey={(item) => String(item.id)}
            emptyMessage={isLoading ? t("toolbar.loading") : t("toolbar.empty")}
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
            <h2 className="text-sm font-semibold">{t("editor.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("editor.description")}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={newItem}>
            <Plus className="size-4" /> {t("editor.add")}
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
            label={t("editor.code")}
            value={form.offerCode}
            placeholder={t("editor.generated")}
            readOnly
            onChange={() => undefined}
          />
          <SearchSelect
            label={t("editor.model")}
            value={form.modelOptionId}
            options={modelOptions}
            placeholder={t("editor.modelSelect")}
            allowEmpty
            disabled={editingExisting}
            onValueChange={(value) => {
              updateForm("modelOptionId", value);
              updateForm("storage", "");
              updateForm("color", "");
            }}
          />
          <SearchSelect
            label={t("editor.storage")}
            value={form.storage}
            options={storageOptions}
            placeholder={t("editor.allStorage")}
            allowEmpty
            disabled={editingExisting || !form.modelOptionId}
            onValueChange={(value) => updateForm("storage", value)}
          />
          <SearchSelect
            label={t("editor.color")}
            value={form.color}
            options={colorOptions}
            placeholder={t("editor.allColor")}
            allowEmpty
            disabled={editingExisting || !form.modelOptionId}
            onValueChange={(value) => updateForm("color", value)}
          />
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("editor.warranty")}</span>
            <Select
              value={form.warrantyGroupOptionId}
              disabled={editingExisting}
              onValueChange={(value) =>
                updateForm("warrantyGroupOptionId", value)
              }
            >
              <SelectTrigger><SelectValue placeholder={t("editor.warrantySelect")} /></SelectTrigger>
              <SelectContent>
                {warrantyOptions.map((option) => (
                  <SelectItem
                    key={option.optionId}
                    value={String(option.optionId)}
                  >
                    {option.label || warrantyFallbackLabels[option.optionKey] || "-"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("editor.status")}</span>
            <Select value={form.isActive} onValueChange={(value) => updateForm("isActive", value as "1" | "0")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t("common.active")}</SelectItem>
                <SelectItem value="0">{t("common.inactive")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Button onClick={() => void save()} disabled={isSaving}>
            <Save className="size-4" />
            {isSaving ? t("common.saving") : t("editor.save")}
          </Button>
        </div>
      </aside>
    </MasterDetailLayout>
  );
}
