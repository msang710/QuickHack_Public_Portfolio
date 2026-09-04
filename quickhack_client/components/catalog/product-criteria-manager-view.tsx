// QuickHack note: 검수 드롭다운과 상품 기준값 옵션을 DB에서 조회/수정하는 관리 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { Database, Link2, Plus, RefreshCcw, Save } from "lucide-react";
import type { StatusTone } from "@/quickhack_shared/device/types";
import {
  PRODUCT_CRITERIA_CATEGORIES,
  canUseProductCriteriaParentKey,
  type ProductCameraCheckRuleDto,
  type ProductCriteriaCategory,
  type ProductCriteriaOptionDto,
  type ProductCriteriaPayload,
} from "@/quickhack_shared/catalog/product-criteria";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
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
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  PanelToolbar,
  WorkspacePanel,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/quickhack_client/components/ui/tabs";
import { SearchSelect } from "@/quickhack_client/components/ui/search-select";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import { InventoryEditField } from "@/quickhack_client/components/inventory/inventory-edit-fields";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import { cn } from "@/quickhack_shared/core/utils";
import type { MutationReceipt } from "@/quickhack_shared/core/mutation-receipt";

type ProductCriteriaForm = {
  category: ProductCriteriaCategory;
  optionKey: string;
  label: string;
  parentKey: string;
  sortOrder: string;
  isActive: "1" | "0";
};

type ProductCriteriaApiResponse = {
  ok: boolean;
  message?: string;
  data?: ProductCriteriaPayload;
  option?: ProductCriteriaOptionDto;
  relation?: ProductCriteriaOptionDto;
  receipt?: MutationReceipt<unknown>;
};

function emptyProductCriteriaForm(): ProductCriteriaForm {
  return {
    category: "PRODUCT_MODEL",
    optionKey: "",
    label: "",
    parentKey: "",
    sortOrder: "0",
    isActive: "1",
  };
}

function productCriteriaFormFromOption(
  option: ProductCriteriaOptionDto
): ProductCriteriaForm {
  return {
    category: option.category,
    optionKey: option.optionKey,
    label: option.label,
    parentKey: option.parentKey,
    sortOrder: String(option.sortOrder),
    isActive: option.isActive ? "1" : "0",
  };
}

function productCriteriaSearchText(
  option: ProductCriteriaOptionDto,
  categoryLabel: string
) {
  return [
    categoryLabel,
    option.category,
    option.parentKey,
    option.optionKey,
    option.label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function productCriteriaOptionLabel(option: ProductCriteriaOptionDto) {
  return `${option.label}${option.optionKey ? ` (${option.optionKey})` : ""}`;
}

function sortCriteriaOptions(options: ProductCriteriaOptionDto[]) {
  return [...options].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.label.localeCompare(b.label, "ko", { numeric: true }) ||
      a.optionId - b.optionId
  );
}

function criteriaOptionsByCategory(
  criteria: ProductCriteriaPayload | null,
  category: ProductCriteriaCategory
) {
  return sortCriteriaOptions(
    (criteria?.rawOptions ?? []).filter(
      (option) => option.category === category && option.isActive
    )
  );
}

function relationChildIds(
  criteria: ProductCriteriaPayload,
  relationType: string,
  parentOptionId: number
) {
  return new Set(
    criteria.rawLinks
      .filter(
        (link) =>
          link.isActive &&
          link.relationType === relationType &&
          link.parentOptionId === parentOptionId
      )
      .map((link) => link.childOptionId)
  );
}

function cameraRuleDrafts(
  rules: ProductCameraCheckRuleDto[],
  modelOptionId: number
) {
  return rules
    .filter(
      (rule) =>
        rule.modelOptionId === modelOptionId &&
        rule.isActive &&
        rule.cameraLensOptionId
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.ruleId - b.ruleId)
    .map((rule) => ({
      cameraLensOptionId: rule.cameraLensOptionId ?? 0,
      focusRuleOptionId: rule.focusRuleOptionId,
    }));
}

type CameraRuleDraft = ReturnType<typeof cameraRuleDrafts>[number];
type ProductCriteriaRelationSnapshot = {
  relationRevision: number;
  storageOptionIds: number[];
  colorOptionIds: number[];
  cameraRules: CameraRuleDraft[];
};

const PRODUCT_CRITERIA_OPTION_FORM_ID = "catalog.product-criteria-option";
const PRODUCT_CRITERIA_RELATION_FORM_ID =
  "catalog.product-criteria-relations";

function sortedUniqueOptionIds(optionIds: readonly number[]) {
  return Array.from(new Set(optionIds)).sort((left, right) => left - right);
}

function normalizedCameraRules(rules: readonly CameraRuleDraft[]) {
  return rules
    .map((rule) => ({ ...rule }))
    .sort(
      (left, right) =>
        left.cameraLensOptionId - right.cameraLensOptionId ||
        (left.focusRuleOptionId ?? 0) - (right.focusRuleOptionId ?? 0)
    );
}

function relationSnapshot(
  criteria: ProductCriteriaPayload | null,
  modelOptionId: number | null
): ProductCriteriaRelationSnapshot | null {
  if (!criteria || !modelOptionId) {
    return null;
  }

  return {
    relationRevision:
      criteria.rawOptions.find((option) => option.optionId === modelOptionId)
        ?.relationRevision ?? 0,
    storageOptionIds: sortedUniqueOptionIds(
      Array.from(relationChildIds(criteria, "MODEL_STORAGE", modelOptionId))
    ),
    colorOptionIds: sortedUniqueOptionIds(
      Array.from(relationChildIds(criteria, "MODEL_COLOR", modelOptionId))
    ),
    cameraRules: normalizedCameraRules(
      cameraRuleDrafts(criteria.rawCameraRules, modelOptionId)
    ),
  };
}

function currentRelationSnapshot({
  relationRevision,
  storageOptionIds,
  colorOptionIds,
  cameraRules,
}: ProductCriteriaRelationSnapshot): ProductCriteriaRelationSnapshot {
  return {
    relationRevision,
    storageOptionIds: sortedUniqueOptionIds(storageOptionIds),
    colorOptionIds: sortedUniqueOptionIds(colorOptionIds),
    cameraRules: normalizedCameraRules(cameraRules),
  };
}

function ProductCriteriaOptionChecklist({
  title,
  options,
  selectedIds,
  onChange,
  listClassName,
}: {
  title: string;
  options: ProductCriteriaOptionDto[];
  selectedIds: number[];
  onChange: (nextIds: number[]) => void;
  listClassName?: string;
}) {
  const t = useTranslations("catalog.productCriteria");
  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const allChecked =
    options.length > 0 && options.every((option) => selected.has(option.optionId));
  const someChecked = options.some((option) => selected.has(option.optionId));

  function toggleOption(optionId: number, checked: boolean) {
    const next = new Set(selected);

    if (checked) {
      next.add(optionId);
    } else {
      next.delete(optionId);
    }

    onChange(Array.from(next));
  }

  function toggleAll(checked: boolean) {
    onChange(checked ? options.map((option) => option.optionId) : []);
  }

  return (
    <section className="grid min-h-0 content-start gap-2 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("common.selected", { count: selectedIds.length })}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <TableSelectCheckbox
            checked={allChecked}
            indeterminate={someChecked && !allChecked}
            ariaLabel={t("common.selectAll", { title })}
            onCheckedChange={toggleAll}
          />
          {t("common.all")}
        </label>
      </div>
      <div className={cn("max-h-[240px] overflow-auto rounded-md border", listClassName)}>
        {options.length > 0 ? (
          options.map((option) => (
            <label
              key={option.optionId}
              className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-secondary/60"
            >
              <TableSelectCheckbox
                checked={selected.has(option.optionId)}
                ariaLabel={productCriteriaOptionLabel(option)}
                onCheckedChange={(checked) => toggleOption(option.optionId, checked)}
              />
              <span className="truncate">{productCriteriaOptionLabel(option)}</span>
            </label>
          ))
        ) : (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t("common.empty")}
          </div>
        )}
      </div>
    </section>
  );
}

function ProductCameraRuleChecklist({
  lensOptions,
  focusRuleOptions,
  rules,
  onChange,
}: {
  lensOptions: ProductCriteriaOptionDto[];
  focusRuleOptions: ProductCriteriaOptionDto[];
  rules: CameraRuleDraft[];
  onChange: (nextRules: CameraRuleDraft[]) => void;
}) {
  const t = useTranslations("catalog.productCriteria");
  const selectedByLensId = React.useMemo(
    () => new Map(rules.map((rule) => [rule.cameraLensOptionId, rule])),
    [rules]
  );
  const defaultFocusRuleId = focusRuleOptions[0]?.optionId ?? null;
  const allChecked =
    lensOptions.length > 0 &&
    lensOptions.every((option) => selectedByLensId.has(option.optionId));
  const someChecked = lensOptions.some((option) =>
    selectedByLensId.has(option.optionId)
  );

  function toggleLens(optionId: number, checked: boolean) {
    if (!checked) {
      onChange(rules.filter((rule) => rule.cameraLensOptionId !== optionId));
      return;
    }

    if (selectedByLensId.has(optionId)) {
      return;
    }

    onChange([
      ...rules,
      {
        cameraLensOptionId: optionId,
        focusRuleOptionId: defaultFocusRuleId,
      },
    ]);
  }

  function toggleAll(checked: boolean) {
    if (!checked) {
      onChange([]);
      return;
    }

    onChange(
      lensOptions.map((option) => ({
        cameraLensOptionId: option.optionId,
        focusRuleOptionId:
          selectedByLensId.get(option.optionId)?.focusRuleOptionId ??
          defaultFocusRuleId,
      }))
    );
  }

  function updateFocusRule(lensOptionId: number, focusRuleOptionId: string) {
    const nextFocusRuleOptionId = Number.parseInt(focusRuleOptionId, 10);

    if (!Number.isInteger(nextFocusRuleOptionId)) {
      return;
    }

    onChange(
      rules.map((rule) =>
        rule.cameraLensOptionId === lensOptionId
          ? { ...rule, focusRuleOptionId: nextFocusRuleOptionId }
          : rule
      )
    );
  }

  return (
    <section className="flex min-h-0 flex-col gap-3 rounded-md border bg-popover p-4 xl:col-span-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("camera.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("camera.description")}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <TableSelectCheckbox
            checked={allChecked}
            indeterminate={someChecked && !allChecked}
            ariaLabel={t("camera.selectAll")}
            onCheckedChange={toggleAll}
          />
          {t("common.all")}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border pb-4">
        {lensOptions.length > 0 ? (
          lensOptions.map((option) => {
            const selectedRule = selectedByLensId.get(option.optionId);
            const isChecked = Boolean(selectedRule);

            return (
              <div
                key={option.optionId}
                className="grid items-center gap-2 border-b px-3 py-2 last:border-b-0 md:grid-cols-[minmax(160px,1fr)_220px]"
              >
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <TableSelectCheckbox
                    checked={isChecked}
                    ariaLabel={productCriteriaOptionLabel(option)}
                    onCheckedChange={(checked) =>
                      toggleLens(option.optionId, checked)
                    }
                  />
                  <span>{productCriteriaOptionLabel(option)}</span>
                </label>
                <Select
                  value={
                    selectedRule?.focusRuleOptionId
                      ? String(selectedRule.focusRuleOptionId)
                      : ""
                  }
                  disabled={!isChecked || focusRuleOptions.length === 0}
                  onValueChange={(value) =>
                    updateFocusRule(option.optionId, value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("camera.focus")} />
                  </SelectTrigger>
                  <SelectContent>
                    {focusRuleOptions.map((focusRule) => (
                      <SelectItem
                        key={focusRule.optionId}
                        value={String(focusRule.optionId)}
                      >
                        {focusRule.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })
        ) : (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("camera.empty")}
          </div>
        )}
      </div>
    </section>
  );
}

function ProductCriteriaRelationEditor({
  criteria,
  onSaved,
  onRefresh,
}: {
  criteria: ProductCriteriaPayload | null;
  onSaved: (data: ProductCriteriaPayload) => void;
  onRefresh: () => Promise<boolean>;
}) {
  const t = useTranslations("catalog.productCriteria");
  const { runGuardedAction } = useUnsavedChanges();
  const models = React.useMemo(
    () => criteriaOptionsByCategory(criteria, "PRODUCT_MODEL"),
    [criteria]
  );
  const storages = React.useMemo(
    () => criteriaOptionsByCategory(criteria, "STORAGE"),
    [criteria]
  );
  const colors = React.useMemo(
    () => criteriaOptionsByCategory(criteria, "DEVICE_COLOR"),
    [criteria]
  );
  const cameraLenses = React.useMemo(
    () => criteriaOptionsByCategory(criteria, "CAMERA_LENS"),
    [criteria]
  );
  const cameraFocusRules = React.useMemo(
    () => criteriaOptionsByCategory(criteria, "CAMERA_FOCUS_RULE"),
    [criteria]
  );
  const [selectedModelId, setSelectedModelId] = React.useState<number | null>(
    null
  );
  const [storageOptionIds, setStorageOptionIds] = React.useState<number[]>([]);
  const [colorOptionIds, setColorOptionIds] = React.useState<number[]>([]);
  const [cameraRules, setCameraRules] = React.useState<CameraRuleDraft[]>([]);
  const [loadedRelationModelId, setLoadedRelationModelId] =
    React.useState<number | null>(null);
  const [loadedRelations, setLoadedRelations] =
    React.useState<ProductCriteriaRelationSnapshot | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");

  const effectiveSelectedModelId = React.useMemo(() => {
    if (selectedModelId && models.some((model) => model.optionId === selectedModelId)) {
      return selectedModelId;
    }

    return models[0]?.optionId ?? null;
  }, [models, selectedModelId]);
  const selectedModel = React.useMemo(
    () =>
      models.find((model) => model.optionId === effectiveSelectedModelId) ??
      null,
    [effectiveSelectedModelId, models]
  );
  const savedRelations = React.useMemo(
    () => relationSnapshot(criteria, effectiveSelectedModelId),
    [criteria, effectiveSelectedModelId]
  );
  const currentRelations = React.useMemo(
    () =>
      currentRelationSnapshot({
        relationRevision: loadedRelations?.relationRevision ?? 0,
        storageOptionIds,
        colorOptionIds,
        cameraRules,
      }),
    [cameraRules, colorOptionIds, loadedRelations?.relationRevision, storageOptionIds]
  );
  const discardRelations = React.useCallback(() => {
    setStorageOptionIds(loadedRelations?.storageOptionIds ?? []);
    setColorOptionIds(loadedRelations?.colorOptionIds ?? []);
    setCameraRules(loadedRelations?.cameraRules ?? []);
    setLoadedRelationModelId(effectiveSelectedModelId);
    setMessage("");
  }, [effectiveSelectedModelId, loadedRelations]);

  useUnsavedForm({
    id: PRODUCT_CRITERIA_RELATION_FORM_ID,
    label: selectedModel
      ? t("relation.formModel", { model: selectedModel.label })
      : t("relation.form"),
    enabled: savedRelations !== null,
    isDirty:
      loadedRelations !== null &&
      loadedRelationModelId === effectiveSelectedModelId &&
      !unsavedFormSnapshotsEqual(loadedRelations, currentRelations),
    isBusy: isSaving,
    discard: discardRelations,
  });

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      if (!savedRelations) {
        setStorageOptionIds([]);
        setColorOptionIds([]);
        setCameraRules([]);
        setLoadedRelationModelId(null);
        setLoadedRelations(null);
        return;
      }

      setStorageOptionIds(savedRelations.storageOptionIds);
      setColorOptionIds(savedRelations.colorOptionIds);
      setCameraRules(savedRelations.cameraRules);
      setLoadedRelationModelId(effectiveSelectedModelId);
      setLoadedRelations(savedRelations);
      setMessage("");
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [effectiveSelectedModelId, savedRelations]);
  const modelSelectOptions = React.useMemo(
    () =>
      models.map((model) => ({
        value: String(model.optionId),
        label: model.label,
        description: model.optionKey,
        searchText: `${model.label} ${model.optionKey}`,
      })),
    [models]
  );
  const cameraSummary = selectedModel
    ? criteria?.cameraCheckByProduct[selectedModel.label] ?? "-"
    : "-";

  async function saveRelations() {
    if (!effectiveSelectedModelId || isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/product-criteria", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "saveRelations",
          modelOptionId: effectiveSelectedModelId,
          expectedRelationRevision: loadedRelations?.relationRevision,
          storageOptionIds,
          colorOptionIds,
          cameraRules: cameraRules
            .map((rule) => ({
              cameraLensOptionId: rule.cameraLensOptionId,
              focusRuleOptionId: rule.focusRuleOptionId,
            }))
            .filter((rule) => rule.cameraLensOptionId && rule.focusRuleOptionId),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ProductCriteriaApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("relation.saveFailed")));
      }

      const refreshDeferred = payload.receipt?.refreshRequired === true;
      const refreshed = payload.data
        ? true
        : refreshDeferred
          ? await onRefresh()
          : false;
      const nextRelations = payload.data
        ? relationSnapshot(payload.data, effectiveSelectedModelId)
        : payload.relation
          ? currentRelationSnapshot({
              relationRevision: payload.relation.relationRevision,
              storageOptionIds,
              colorOptionIds,
              cameraRules,
            })
          : null;
      if (!nextRelations) {
        throw new Error(t("relation.verifyFailed"));
      }
      setStorageOptionIds(nextRelations?.storageOptionIds ?? []);
      setColorOptionIds(nextRelations?.colorOptionIds ?? []);
      setCameraRules(nextRelations?.cameraRules ?? []);
      setLoadedRelationModelId(effectiveSelectedModelId);
      setLoadedRelations(nextRelations);
      if (payload.data) {
        onSaved(payload.data);
      }
      setMessage(
        refreshed
          ? t("relation.saved")
          : t("relation.refreshRequired", {
              result: t("relation.saved"),
            })
      );
      setMessageTone(refreshed ? "success" : "warning");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  function requestSelectedModel(value: string) {
    const nextModelId = Number(value);
    if (!nextModelId || nextModelId === effectiveSelectedModelId) {
      return;
    }

    const nextModel = models.find((model) => model.optionId === nextModelId);
    runGuardedAction({
      intent: "internal-change",
      formIds: [PRODUCT_CRITERIA_RELATION_FORM_ID],
      targetLabel: t("relation.open", {
        model: nextModel?.label ?? t("relation.otherModel"),
      }),
      action: () => setSelectedModelId(nextModelId),
    });
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 px-5 pb-5 pt-5">
      <div className="rounded-md border bg-popover p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SearchSelect
            label={t("relation.model")}
            value={effectiveSelectedModelId ? String(effectiveSelectedModelId) : ""}
            options={modelSelectOptions}
            placeholder={t("relation.modelPlaceholder")}
            allowEmpty={false}
            className="min-w-[320px] flex-1"
            onValueChange={requestSelectedModel}
          />
          <Button
            onClick={saveRelations}
            disabled={!effectiveSelectedModelId || isSaving}
          >
            <Save className="size-4" />
            {isSaving ? t("common.saving") : t("relation.save")}
          </Button>
        </div>

        {message ? (
          <FeedbackBanner
            tone={messageTone === "success" ? "success" : "warning"}
            className="mt-3"
          >
            {message}
          </FeedbackBanner>
        ) : null}
      </div>

      {selectedModel ? (
        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden xl:grid-cols-[320px_minmax(360px,1fr)_minmax(360px,1fr)] xl:grid-rows-[auto_minmax(0,1fr)]">
          <section className="grid content-start gap-3 rounded-md border bg-popover p-4">
            <div className="flex items-start gap-2">
              <Link2 className="mt-0.5 size-4 text-primary" />
              <div>
                <h2 className="text-sm font-semibold">
                  {productCriteriaOptionLabel(selectedModel)}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("relation.description")}
                </p>
              </div>
            </div>
            <div className="rounded-md bg-secondary px-3 py-2 text-xs leading-5">
              {t("relation.cameraSummary", { summary: cameraSummary })}
            </div>
          </section>

          <ProductCriteriaOptionChecklist
            title={t("relation.storage")}
            options={storages}
            selectedIds={storageOptionIds}
            onChange={setStorageOptionIds}
          />

          <ProductCriteriaOptionChecklist
            title={t("relation.color")}
            options={colors}
            selectedIds={colorOptionIds}
            onChange={setColorOptionIds}
          />

          <ProductCameraRuleChecklist
            lensOptions={cameraLenses}
            focusRuleOptions={cameraFocusRules}
            rules={cameraRules}
            onChange={setCameraRules}
          />
        </div>
      ) : (
        <div className="rounded-md border border-dashed bg-popover px-4 py-16 text-center text-sm text-muted-foreground">
          {t("relation.emptyModel")}
        </div>
      )}
    </section>
  );
}

// QuickHack object: 검수와 상품 등록에 사용하는 입력 기준값을 관리하는 화면입니다.
export function ProductCriteriaManagerView() {
  const t = useTranslations("catalog.productCriteria");
  const categoryLabels = React.useMemo<Record<ProductCriteriaCategory, string>>(() => ({
    PRODUCT_MODEL: t("category.productModel"),
    CARRIER: t("category.carrier"),
    STORAGE: t("category.storage"),
    DEVICE_COLOR: t("category.deviceColor"),
    APPEARANCE_GRADE: t("category.appearanceGrade"),
    SALE_GRADE: t("category.saleGrade"),
    WARRANTY_GROUP: t("category.warrantyGroup"),
    APPEARANCE_DEFECT: t("category.appearanceDefect"),
    FUNCTION_DEFECT: t("category.functionDefect"),
    CAMERA_LENS: t("category.cameraLens"),
    CAMERA_FOCUS_RULE: t("category.cameraFocusRule"),
  }), [t]);
  const { runGuardedAction } = useUnsavedChanges();
  const [criteria, setCriteria] = React.useState<ProductCriteriaPayload | null>(
    null
  );
  const [activeTab, setActiveTab] = React.useState<"options" | "relations">(
    "options"
  );
  const [query, setQuery] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<
    ProductCriteriaCategory | "ALL"
  >("ALL");
  const [selectedOptionId, setSelectedOptionId] = React.useState<number | null>(
    null
  );
  const selectedOptionIdRef = React.useRef<number | null>(null);
  const [form, setForm] = React.useState<ProductCriteriaForm>(() =>
    emptyProductCriteriaForm()
  );
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const selectedOption = React.useMemo(
    () =>
      criteria?.rawOptions.find(
        (option) => option.optionId === selectedOptionId
      ) ?? null,
    [criteria?.rawOptions, selectedOptionId]
  );
  const formBaseline = React.useMemo(
    () =>
      selectedOption
        ? productCriteriaFormFromOption(selectedOption)
        : emptyProductCriteriaForm(),
    [selectedOption]
  );
  const discardOptionForm = React.useCallback(() => {
    setForm(formBaseline);
    setMessage("");
  }, [formBaseline]);

  useUnsavedForm({
    id: PRODUCT_CRITERIA_OPTION_FORM_ID,
    label: selectedOption
      ? t("option.formSelected", { label: selectedOption.label })
      : t("option.form"),
    enabled: activeTab === "options",
    isDirty: !unsavedFormSnapshotsEqual(formBaseline, form),
    isBusy: isSaving,
    discard: discardOptionForm,
  });

  const loadCriteria = React.useCallback(async (synchronizeEditor = false) => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/product-criteria?includeInactive=1", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | ProductCriteriaApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.data) {
        throw new Error(legacyApiMessage(payload, t("option.loadFailed")));
      }

      setCriteria(payload.data);
      if (synchronizeEditor) {
        const currentOptionId = selectedOptionIdRef.current;
        const nextOption =
          payload.data.rawOptions.find(
            (option) => option.optionId === currentOptionId
          ) ?? null;
        selectedOptionIdRef.current = nextOption?.optionId ?? null;
        setSelectedOptionId(nextOption?.optionId ?? null);
        setForm(
          nextOption
            ? productCriteriaFormFromOption(nextOption)
            : emptyProductCriteriaForm()
        );
      }
      setMessage("");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadCriteria(false);
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadCriteria]);

  const filteredOptions = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const options = criteria?.rawOptions ?? [];

    return options.filter((option) => {
      if (categoryFilter !== "ALL" && option.category !== categoryFilter) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return productCriteriaSearchText(
        option,
        categoryLabels[option.category]
      ).includes(normalizedQuery);
    });
  }, [categoryFilter, categoryLabels, criteria?.rawOptions, query]);
  const optionColumns = React.useMemo<
    DataGridColumn<
      "category" | "parentKey" | "optionKey" | "label" | "status" | "sortOrder",
      ProductCriteriaOptionDto
    >[]
  >(
    () => [
      {
        key: "category",
        label: t("option.category"),
        width: "170px",
        placeholder: t("option.category"),
        cellClassName: "flex items-center px-3",
        render: (option) => categoryLabels[option.category],
        text: (option) => categoryLabels[option.category],
      },
      {
        key: "parentKey",
        label: t("option.parent"),
        width: "150px",
        placeholder: t("option.parent"),
        cellClassName: "flex items-center px-3",
        render: (option) => option.parentKey || "-",
        text: (option) => option.parentKey || "",
      },
      {
        key: "optionKey",
        label: t("option.key"),
        width: "180px",
        placeholder: t("option.key"),
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (option) => option.optionKey,
        text: (option) => option.optionKey,
      },
      {
        key: "label",
        label: t("option.label"),
        width: "minmax(180px,1fr)",
        placeholder: t("option.label"),
        cellClassName: "flex items-center px-3 font-medium",
        render: (option) => option.label,
        text: (option) => option.label,
      },
      {
        key: "status",
        label: t("option.status"),
        width: "90px",
        placeholder: t("option.status"),
        cellClassName: "flex items-center px-3",
        render: (option) => (
          <Badge variant={option.isActive ? "success" : "neutral"}>
            {option.isActive ? t("common.active") : t("common.inactive")}
          </Badge>
        ),
        text: (option) =>
          option.isActive ? t("common.active") : t("common.inactive"),
      },
      {
        key: "sortOrder",
        label: t("option.order"),
        width: "80px",
        placeholder: t("option.order"),
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        render: (option) => option.sortOrder,
        text: (option) => String(option.sortOrder),
        sortValue: (option) => option.sortOrder,
      },
    ],
    [categoryLabels, t]
  );

  function updateForm<K extends keyof ProductCriteriaForm>(
    key: K,
    value: ProductCriteriaForm[K]
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function updateCategory(category: ProductCriteriaCategory) {
    setForm((current) => ({
      ...current,
      category,
      parentKey: canUseProductCriteriaParentKey(category)
        ? current.parentKey
        : "",
    }));
  }

  function applySelectedOption(option: ProductCriteriaOptionDto) {
    selectedOptionIdRef.current = option.optionId;
    setSelectedOptionId(option.optionId);
    setForm(productCriteriaFormFromOption(option));
    setMessage("");
  }

  function selectOption(option: ProductCriteriaOptionDto) {
    if (selectedOptionId === option.optionId) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [PRODUCT_CRITERIA_OPTION_FORM_ID],
      targetLabel: t("option.open", { label: option.label }),
      action: () => applySelectedOption(option),
    });
  }

  function applyNewOption() {
    selectedOptionIdRef.current = null;
    setSelectedOptionId(null);
    setForm(emptyProductCriteriaForm());
    setMessage("");
  }

  function newOption() {
    if (
      selectedOptionId === null &&
      unsavedFormSnapshotsEqual(form, emptyProductCriteriaForm())
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [PRODUCT_CRITERIA_OPTION_FORM_ID],
      targetLabel: t("option.newOpen"),
      action: applyNewOption,
    });
  }

  function requestCriteriaReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [
        activeTab === "options"
          ? PRODUCT_CRITERIA_OPTION_FORM_ID
          : PRODUCT_CRITERIA_RELATION_FORM_ID,
      ],
      targetLabel: t("option.reload"),
      action: () => {
        void loadCriteria(true);
      },
    });
  }

  function requestTabChange(value: string) {
    const nextTab = value === "relations" ? "relations" : "options";
    if (nextTab === activeTab) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [
        activeTab === "options"
          ? PRODUCT_CRITERIA_OPTION_FORM_ID
          : PRODUCT_CRITERIA_RELATION_FORM_ID,
      ],
      targetLabel:
        nextTab === "options"
          ? t("option.tabOpen")
          : t("option.relationTabOpen"),
      action: () => setActiveTab(nextTab),
    });
  }

  function requestBootstrapDefaults() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [PRODUCT_CRITERIA_OPTION_FORM_ID],
      targetLabel: t("option.bootstrapOpen"),
      action: () => {
        void bootstrapDefaults();
      },
    });
  }

  async function saveOption() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/product-criteria", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          optionId: selectedOption?.optionId ?? null,
          expectedRevision: selectedOption?.revision ?? null,
          category: form.category,
          optionKey: form.optionKey,
          label: form.label,
          parentKey: canUseProductCriteriaParentKey(form.category)
            ? form.parentKey
            : "",
          sortOrder: form.sortOrder,
          isActive: form.isActive === "1",
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ProductCriteriaApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("option.saveFailed")));
      }

      const refreshDeferred = payload.receipt?.refreshRequired === true;
      const refreshed = payload.data
        ? true
        : refreshDeferred
          ? await loadCriteria(true)
          : false;
      if (payload.data) {
        setCriteria(payload.data);
      }

      if (payload.option) {
        selectedOptionIdRef.current = payload.option.optionId;
        setSelectedOptionId(payload.option.optionId);
        setForm(productCriteriaFormFromOption(payload.option));
      }

      setMessage(
        refreshed
          ? t("option.saved")
          : t("option.refreshRequired", {
              result: t("option.saved"),
            })
      );
      setMessageTone(refreshed ? "success" : "warning");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  async function bootstrapDefaults() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/product-criteria", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "bootstrap" }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ProductCriteriaApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("option.bootstrapFailed")));
      }

      const refreshDeferred = payload.receipt?.refreshRequired === true;
      const refreshed = payload.data
        ? true
        : refreshDeferred
          ? await loadCriteria(true)
          : false;
      if (payload.data) {
        setCriteria(payload.data);
      }
      if (!payload.data) {
        setMessage(
          refreshed
            ? t("option.bootstrapDone")
            : t("option.refreshRequired", {
                result: t("option.bootstrapDone"),
              })
        );
        setMessageTone(refreshed ? "success" : "warning");
        return;
      }
      const currentOptionId = selectedOptionIdRef.current;
      const nextOption =
        payload.data.rawOptions.find(
          (option) => option.optionId === currentOptionId
        ) ?? null;
      if (currentOptionId !== null) {
        selectedOptionIdRef.current = nextOption?.optionId ?? null;
        setSelectedOptionId(nextOption?.optionId ?? null);
        setForm(
          nextOption
            ? productCriteriaFormFromOption(nextOption)
            : emptyProductCriteriaForm()
        );
      }
      setMessage(t("option.bootstrapDone"));
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={requestTabChange}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b bg-background px-5 py-3">
        <TabsList>
          <TabsTrigger value="options">{t("page.optionsTab")}</TabsTrigger>
          <TabsTrigger value="relations">{t("page.relationsTab")}</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="options"
        className="mt-0 min-h-0 flex-1 overflow-hidden"
      >
        <section className="grid h-full min-h-0 grid-cols-[minmax(420px,1fr)_420px] gap-4 p-5">
          <WorkspacePanel>
            <PanelToolbar className="xl:grid-cols-[minmax(240px,1fr)_220px_auto]">
              <SearchInput
                placeholder={t("page.search")}
                value={query}
                onValueChange={setQuery}
              />

              <Select
                value={categoryFilter}
                onValueChange={(value) =>
                  setCategoryFilter(value as ProductCriteriaCategory | "ALL")
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("page.categoryPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("page.allCategories")}</SelectItem>
                  {PRODUCT_CRITERIA_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {categoryLabels[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button variant="outline" onClick={requestCriteriaReload}>
                <RefreshCcw className={cn("size-4", isLoading && "animate-spin")} />
                {t("page.refresh")}
              </Button>
            </PanelToolbar>

            <VirtualizedDataGrid
              rows={filteredOptions}
              columns={optionColumns}
              rowKey={(option) => option.optionId}
              emptyMessage={
                isLoading
                  ? t("page.loading")
                  : t("common.empty")
              }
              selectedRowKey={selectedOptionId}
              onRowClick={selectOption}
              className="rounded-none border-0"
              minWidth="850px"
              rowHeight={48}
            />
          </WorkspacePanel>

          <aside className="min-h-0 overflow-auto rounded-md border bg-popover p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{t("page.editorTitle")}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("page.editorDescription")}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={newOption}>
                <Plus className="size-4" />{t("page.newValue")}
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
              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("option.category")}
                </span>
                <Select
                  value={form.category}
                  disabled={selectedOption !== null}
                  onValueChange={(value) =>
                    updateCategory(value as ProductCriteriaCategory)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("page.categoryPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {PRODUCT_CRITERIA_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {categoryLabels[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              {canUseProductCriteriaParentKey(form.category) ? (
                <InventoryEditField
                  label={t("option.parent")}
                  value={form.parentKey}
                  placeholder={t("page.parentPlaceholder")}
                  readOnly={selectedOption !== null}
                  onChange={(value) => updateForm("parentKey", value)}
                />
              ) : null}
              <InventoryEditField
                label={t("option.key")}
                value={form.optionKey}
                placeholder={t("page.keyPlaceholder")}
                readOnly={selectedOption !== null}
                onChange={(value) => updateForm("optionKey", value)}
              />
              <InventoryEditField
                label={t("option.label")}
                value={form.label}
                placeholder={t("page.labelPlaceholder")}
                onChange={(value) => updateForm("label", value)}
              />
              <InventoryEditField
                label={t("page.sortOrder")}
                value={form.sortOrder}
                placeholder="0"
                onChange={(value) => updateForm("sortOrder", value)}
              />

              <label className="grid gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("option.status")}
                </span>
                <Select
                  value={form.isActive}
                  onValueChange={(value) =>
                    updateForm("isActive", value as "1" | "0")
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("option.status")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t("common.active")}</SelectItem>
                    <SelectItem value="0">{t("common.inactive")}</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              <div className="grid gap-2 pt-2">
                <Button onClick={saveOption} disabled={isSaving}>
                  <Save className="size-4" />
                  {isSaving ? t("common.saving") : t("page.save")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={requestBootstrapDefaults}
                  disabled={isSaving}
                >
                  <Database className="size-4" />
                  {t("page.bootstrap")}
                </Button>
              </div>
            </div>
          </aside>
        </section>
      </TabsContent>

      <TabsContent
        value="relations"
        className="mt-0 min-h-0 flex-1 overflow-hidden"
      >
        <ProductCriteriaRelationEditor
          criteria={criteria}
          onSaved={(data) => setCriteria(data)}
          onRefresh={() => loadCriteria(false)}
        />
      </TabsContent>
    </Tabs>
  );
}
