// QuickHack note: 비품관리의 재고관리, 소요예측, 재구매 메뉴를 실제 API와 연결합니다.
"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import {
  BadgeDollarSign,
  BarChart3,
  PackageCheck,
  Save,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import {
  FormField as Field,
  FormSection as Section,
} from "@/quickhack_client/components/ui/form-layout";
import { Input } from "@/quickhack_client/components/ui/input";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/quickhack_client/components/ui/tabs";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import {
  SUPPLIES_FORM_IDS,
  createSupplyMovementTargetState,
  prepareSupplyMovementOperation,
  suppliesDraftSnapshotsEqual,
  type PendingSupplyMovementOperation,
  type SupplyMovementDraft,
} from "@/quickhack_client/components/supplies/supplies-draft-state";
import {
  supplyConsumptionRuleFilterDefinitions,
  supplyConsumptionRuleFilterText,
  supplyConsumptionRuleFormForTrigger,
} from "@/quickhack_client/components/supplies/supply-consumption-rule-ui";
import {
  OUTBOUND_SUPPLY_CONSUMPTION_POLICY,
  SUPPLY_CONSUMPTION_TRIGGER,
  SUPPLY_MOVEMENT_TYPE,
  SUPPLY_REORDER_STATUS,
  normalizeSupplyConsumptionQuantity,
} from "@/quickhack_shared/supplies/supplies";
import { cn } from "@/quickhack_shared/core/utils";

type SuppliesMode = "inventory" | "forecast" | "reorder";
type SupplyActionKey =
  | "saveSupply"
  | "recordMovement"
  | "saveConsumptionRule"
  | "calculateForecast"
  | "createReorderSuggestions"
  | "updateReorderRequest";

type SupplyDto = {
  supplyId: number;
  revision: number;
  supplyCode: string;
  supplyName: string;
  category: string;
  baseUnit: string;
  orderUnit: string;
  orderUnitQuantity: number;
  minimumOrderQuantity: number;
  defaultSupplierName: string;
  unitCost: number | null;
  leadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
  lossRatePercent: number;
  safetyStockDays: number;
  targetStockDays: number;
  outboundConsumptionPolicy: string;
  isActive: boolean;
  note: string;
  currentQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  inventoryLocation: string;
  lastCountedAt: string;
  latestForecast: ForecastDto | null;
  rules: RuleDto[];
  openReorders: ReorderDto[];
  createdAt: string;
  updatedAt: string;
};

type RuleDto = {
  ruleId: number;
  revision: number;
  supplyId: number;
  triggerType: string;
  quantityPerUnit: number;
  channel: string;
  model: string;
  saleGrade: string;
  warranty: string;
  inventoryStatus: string;
  isActive: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
};

type RuleTableRow = RuleDto & {
  supplyName: string;
};

type RuleColumnKey = "supply" | "trigger" | "quantity" | "filter" | "status" | "actions";
type ForecastColumnKey =
  | "forecastDate"
  | "supply"
  | "averageDailyUsage"
  | "safetyStock"
  | "reorderPoint"
  | "targetStock"
  | "available"
  | "recommended"
  | "stockout";
type ForecastValidationColumnKey =
  | "forecastDate"
  | "supply"
  | "period"
  | "elapsed"
  | "predicted"
  | "actual"
  | "difference"
  | "errorRate"
  | "status";

type ForecastDto = {
  forecastId: number;
  supplyId: number;
  supplyName: string;
  baseUnit: string;
  orderUnit: string;
  forecastDate: string;
  periodFrom: string;
  periodTo: string;
  lookbackDays: number;
  demandSource: string;
  expectedUsageQuantity: number;
  averageDailyUsage: number;
  usageStddev: number;
  currentQuantity: number;
  availableQuantity: number;
  safetyStockQuantity: number;
  reorderPointQuantity: number;
  targetStockQuantity: number;
  recommendedPurchaseQuantity: number;
  economicOrderQuantity: number | null;
  expectedStockoutDate: string;
  createdAt: string;
};

type ForecastValidationDto = {
  forecastId: number;
  supplyId: number;
  supplyName: string;
  forecastDate: string;
  validationFrom: string;
  validationTo: string;
  elapsedDays: number;
  lookbackDays: number;
  predictedUsageQuantity: number;
  actualUsageQuantity: number;
  differenceQuantity: number;
  errorRatePercent: number | null;
  status: "PENDING" | "NO_USAGE" | "GOOD" | "WARNING" | "HIGH_ERROR";
};

type ReorderDto = {
  reorderRequestId: number;
  revision: number;
  supplyId: number;
  supplyName: string;
  baseUnit: string;
  orderUnit: string;
  forecastId: number | null;
  isForecastOutdated: boolean;
  latestRecommendedQuantity: number | null;
  requestStatus: string;
  recommendedQuantity: number;
  requestedQuantity: number | null;
  orderedQuantity: number | null;
  receivedQuantity: number | null;
  expectedUnitCost: number | null;
  supplierName: string;
  reason: string;
  orderedAt: string;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
};

type MovementDto = {
  movementId: number;
  supplyId: number;
  supplyName: string;
  movementType: string;
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  reason: string;
  createdByDisplayName: string;
  createdAt: string;
};

type SupplyWorkspaceData = {
  supplies: SupplyDto[];
  recentMovements: MovementDto[];
  forecasts: ForecastDto[];
  forecastValidations: ForecastValidationDto[];
  openReorders: ReorderDto[];
  reorderHistory: ReorderDto[];
  reorderHistoryPage: {
    hasMore: boolean;
    nextCursor: string | null;
  };
  summary: {
    supplyCount: number;
    activeSupplyCount: number;
    belowReorderPointCount: number;
    openReorderCount: number;
  };
};

type SuppliesApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  resultCode?: string;
  details?: {
    triggerType?: string;
    unsupportedFilters?: string[];
  };
  data?: SupplyWorkspaceData;
  result?: unknown;
  receipt?: import("@/quickhack_shared/core/mutation-receipt").MutationReceipt<unknown>;
};

type SuppliesTranslator = ReturnType<typeof useTranslations<"supplies">>;

function suppliesApiErrorMessage(
  payload: SuppliesApiResponse,
  t: SuppliesTranslator,
  fallbackMessage: string
) {
  if (payload.code === "UNSUPPORTED_SUPPLY_RULE_FILTER") {
    const trigger = String(payload.details?.triggerType ?? "");
    const filters = (payload.details?.unsupportedFilters ?? []).map((filter) =>
      t(`rule.filterField.${filter}` as "rule.filterField.channel")
    );
    return t("message.unsupportedRuleFilters", {
      trigger: t(`trigger.${trigger}` as "trigger.PURCHASED_DEVICE"),
      filters: filters.join(", "),
    });
  }
  return legacyApiMessage(payload, fallbackMessage);
}

function suppliesApiResultMessage(payload: SuppliesApiResponse, t: SuppliesTranslator) {
  const keyByCode = {
    SUPPLIES_ACTION_COMPLETED: "message.actionComplete",
    SUPPLY_SAVED: "message.supplySaved",
    SUPPLY_MOVEMENT_RECORDED: "message.movementRecorded",
    SUPPLY_CONSUMPTION_RULE_SAVED: "message.consumptionRuleSaved",
    SUPPLY_FORECAST_CALCULATED: "message.forecastCalculated",
    SUPPLY_REORDER_SUGGESTIONS_CREATED: "message.reorderSuggestionsCreated",
    SUPPLY_REORDER_STATUS_UPDATED: "message.reorderStatusUpdated",
  } as const;
  return t(keyByCode[payload.resultCode as keyof typeof keyByCode] ?? "message.actionComplete");
}

type SupplyForm = {
  supplyId: string;
  expectedRevision: string;
  supplyCode: string;
  supplyName: string;
  category: string;
  baseUnit: string;
  orderUnit: string;
  orderUnitQuantity: string;
  minimumOrderQuantity: string;
  defaultSupplierName: string;
  unitCost: string;
  leadTimeDays: string;
  minLeadTimeDays: string;
  maxLeadTimeDays: string;
  lossRatePercent: string;
  safetyStockDays: string;
  targetStockDays: string;
  outboundConsumptionPolicy: string;
  inventoryLocation: string;
  reservedQuantity: string;
  note: string;
  isActive: boolean;
};

type MovementForm = SupplyMovementDraft;

type RuleForm = {
  ruleId: string;
  expectedRevision: string;
  supplyId: string;
  triggerType: string;
  quantityPerUnit: string;
  channel: string;
  model: string;
  saleGrade: string;
  warranty: string;
  inventoryStatus: string;
  note: string;
  isActive: boolean;
};

type ReorderForm = {
  reorderRequestId: string;
  expectedRevision: string;
  requestStatus: string;
  requestedQuantity: string;
  orderedQuantity: string;
  receivedQuantity: string;
  expectedUnitCost: string;
  supplierName: string;
  reason: string;
};

const emptySupplyForm: SupplyForm = {
  supplyId: "",
  expectedRevision: "",
  supplyCode: "",
  supplyName: "",
  category: "",
  baseUnit: "개",
  orderUnit: "",
  orderUnitQuantity: "1",
  minimumOrderQuantity: "0",
  defaultSupplierName: "",
  unitCost: "",
  leadTimeDays: "0",
  minLeadTimeDays: "0",
  maxLeadTimeDays: "0",
  lossRatePercent: "0",
  safetyStockDays: "3",
  targetStockDays: "14",
  outboundConsumptionPolicy:
    OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly,
  inventoryLocation: "",
  reservedQuantity: "0",
  note: "",
  isActive: true,
};

const emptyMovementForm = createSupplyMovementTargetState("").current;

const emptyRuleForm: RuleForm = {
  ruleId: "",
  expectedRevision: "",
  supplyId: "",
  triggerType: SUPPLY_CONSUMPTION_TRIGGER.shipmentCreated,
  quantityPerUnit: "1",
  channel: "",
  model: "",
  saleGrade: "",
  warranty: "",
  inventoryStatus: "",
  note: "",
  isActive: true,
};

const emptyReorderForm: ReorderForm = {
  reorderRequestId: "",
  expectedRevision: "",
  requestStatus: SUPPLY_REORDER_STATUS.requested,
  requestedQuantity: "",
  orderedQuantity: "",
  receivedQuantity: "",
  expectedUnitCost: "",
  supplierName: "",
  reason: "",
};

function numberText(value: number | null | undefined, locale: string, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return value.toLocaleString(locale, {
    maximumFractionDigits: digits,
  });
}

function normalizedRuleQuantityInput(value: string) {
  const normalized = normalizeSupplyConsumptionQuantity(value);
  return normalized === null ? value : String(normalized);
}

const supplyGridCellClassName = "flex h-full min-w-0 items-center px-3 py-2";
const supplyGridRightCellClassName =
  "flex h-full min-w-0 items-center justify-end px-3 py-2 text-right";

function forecastValidationBadgeVariant(status: string) {
  if (status === "GOOD" || status === "NO_USAGE") {
    return "success" as const;
  }

  if (status === "WARNING" || status === "PENDING") {
    return "warning" as const;
  }

  return "danger" as const;
}

function formFromSupply(supply: SupplyDto): SupplyForm {
  return {
    supplyId: String(supply.supplyId),
    expectedRevision: String(supply.revision),
    supplyCode: supply.supplyCode,
    supplyName: supply.supplyName,
    category: supply.category,
    baseUnit: supply.baseUnit,
    orderUnit: supply.orderUnit,
    orderUnitQuantity: String(supply.orderUnitQuantity),
    minimumOrderQuantity: String(supply.minimumOrderQuantity),
    defaultSupplierName: supply.defaultSupplierName,
    unitCost: supply.unitCost === null ? "" : String(supply.unitCost),
    leadTimeDays: String(supply.leadTimeDays),
    minLeadTimeDays: String(supply.minLeadTimeDays),
    maxLeadTimeDays: String(supply.maxLeadTimeDays),
    lossRatePercent: String(supply.lossRatePercent),
    safetyStockDays: String(supply.safetyStockDays),
    targetStockDays: String(supply.targetStockDays),
    outboundConsumptionPolicy: supply.outboundConsumptionPolicy,
    inventoryLocation: supply.inventoryLocation,
    reservedQuantity: String(supply.reservedQuantity),
    note: supply.note,
    isActive: supply.isActive,
  };
}

function ruleFormFromRule(rule: RuleDto): RuleForm {
  return supplyConsumptionRuleFormForTrigger(
    {
      ruleId: String(rule.ruleId),
      expectedRevision: String(rule.revision),
      supplyId: String(rule.supplyId),
      triggerType: rule.triggerType,
      quantityPerUnit: String(rule.quantityPerUnit),
      channel: rule.channel,
      model: rule.model,
      saleGrade: rule.saleGrade,
      warranty: rule.warranty,
      inventoryStatus: rule.inventoryStatus,
      note: rule.note,
      isActive: rule.isActive,
    },
    rule.triggerType
  );
}

function reorderFormFromReorder(reorder: ReorderDto): ReorderForm {
  return {
    reorderRequestId: String(reorder.reorderRequestId),
    expectedRevision: String(reorder.revision),
    requestStatus: reorder.requestStatus,
    requestedQuantity:
      reorder.requestedQuantity === null ? "" : String(reorder.requestedQuantity),
    orderedQuantity:
      reorder.orderedQuantity === null ? "" : String(reorder.orderedQuantity),
    receivedQuantity:
      reorder.receivedQuantity === null ? "" : String(reorder.receivedQuantity),
    expectedUnitCost:
      reorder.expectedUnitCost === null ? "" : String(reorder.expectedUnitCost),
    supplierName: reorder.supplierName,
    reason: reorder.reason,
  };
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex min-h-[72px] items-center gap-3 rounded-md border bg-popover px-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-base font-semibold">{value}</div>
      </div>
    </div>
  );
}

function StatusMessage({
  message,
  tone,
  className,
}: {
  message: string;
  tone: "neutral" | "warning";
  className?: string;
}) {
  return (
    <FeedbackBanner
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "bg-popover",
        className
      )}
    >
      <span className="block truncate">{message}</span>
    </FeedbackBanner>
  );
}

async function fetchSupplies(t: SuppliesTranslator, fallbackMessage: string, reorderCursor?: string | null) {
  const query = new URLSearchParams();
  if (reorderCursor) query.set("reorderCursor", reorderCursor);
  const response = await fetch(
    `/api/supplies${query.size > 0 ? `?${query.toString()}` : ""}`,
    { cache: "no-store" }
  );
  const payload = (await response.json()) as SuppliesApiResponse;

  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(suppliesApiErrorMessage(payload, t, fallbackMessage));
  }

  return payload.data;
}

async function submitSupplies(method: "POST" | "PATCH", body: Record<string, unknown>, t: SuppliesTranslator, fallbackMessage: string) {
  const response = await fetch("/api/supplies", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as SuppliesApiResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(suppliesApiErrorMessage(payload, t, fallbackMessage));
  }

  return payload;
}

export function SuppliesManagementView({ mode }: { mode: SuppliesMode }) {
  const t = useTranslations("supplies");
  const { runGuardedAction } = useUnsavedChanges();
  const [data, setData] = React.useState<SupplyWorkspaceData | null>(null);
  const [message, setMessage] = React.useState(() => t("message.loading"));
  const [messageTone, setMessageTone] = React.useState<"neutral" | "warning">("neutral");
  const [activeAction, setActiveAction] =
    React.useState<SupplyActionKey | null>(null);
  const [supplyForm, setSupplyForm] =
    React.useState<SupplyForm>(emptySupplyForm);
  const [supplyBaseline, setSupplyBaseline] =
    React.useState<SupplyForm>(emptySupplyForm);
  const [movementForm, setMovementForm] =
    React.useState<MovementForm>(emptyMovementForm);
  const [movementBaseline, setMovementBaseline] =
    React.useState<MovementForm>(emptyMovementForm);
  const pendingMovementOperation =
    React.useRef<PendingSupplyMovementOperation | null>(null);
  const [ruleForm, setRuleForm] = React.useState<RuleForm>(emptyRuleForm);
  const [ruleBaseline, setRuleBaseline] =
    React.useState<RuleForm>(emptyRuleForm);
  const [reorderForm, setReorderForm] =
    React.useState<ReorderForm>(emptyReorderForm);
  const [reorderBaseline, setReorderBaseline] =
    React.useState<ReorderForm>(emptyReorderForm);
  const [lookbackDays, setLookbackDays] = React.useState("30");
  const [reorderHistoryLoading, setReorderHistoryLoading] = React.useState(false);

  const supplies = data?.supplies ?? [];
  const forecasts = data?.forecasts ?? [];
  const forecastValidations = data?.forecastValidations ?? [];
  const reorders = [
    ...(data?.openReorders ?? []),
    ...(data?.reorderHistory ?? []),
  ];
  const saving = activeAction !== null;
  const movementSupply = supplies.find(
    (supply) => String(supply.supplyId) === movementForm.supplyId
  );

  const discardSupplyForm = React.useCallback(() => {
    setSupplyForm({ ...supplyBaseline });
  }, [supplyBaseline]);
  const discardMovementForm = React.useCallback(() => {
    setMovementForm({ ...movementBaseline });
  }, [movementBaseline]);
  const discardRuleForm = React.useCallback(() => {
    setRuleForm({ ...ruleBaseline });
  }, [ruleBaseline]);
  const discardReorderForm = React.useCallback(() => {
    setReorderForm({ ...reorderBaseline });
  }, [reorderBaseline]);

  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.master,
    label: supplyForm.supplyId
      ? t("unsaved.supplyTarget", { name: supplyForm.supplyName || t("unsaved.selectedSupply") })
      : t("unsaved.supplyNew"),
    enabled: mode === "inventory",
    isDirty: !suppliesDraftSnapshotsEqual(supplyBaseline, supplyForm),
    isBusy: activeAction === "saveSupply",
    discard: discardSupplyForm,
  });
  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.inventoryMovement,
    label: movementSupply
      ? t("unsaved.movementTarget", { name: movementSupply.supplyName })
      : t("unsaved.movement"),
    enabled: mode === "inventory",
    isDirty: !suppliesDraftSnapshotsEqual(movementBaseline, movementForm),
    isBusy: activeAction === "recordMovement",
    discard: discardMovementForm,
  });
  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.consumptionRule,
    label: ruleForm.ruleId ? t("unsaved.ruleEdit") : t("unsaved.ruleNew"),
    enabled: mode === "forecast",
    isDirty: !suppliesDraftSnapshotsEqual(ruleBaseline, ruleForm),
    isBusy: activeAction === "saveConsumptionRule",
    discard: discardRuleForm,
  });
  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.reorderRequest,
    label: reorderForm.reorderRequestId
      ? t("unsaved.reorderTarget", { id: reorderForm.reorderRequestId })
      : t("unsaved.reorderEdit"),
    enabled: mode === "reorder",
    isDirty: !suppliesDraftSnapshotsEqual(reorderBaseline, reorderForm),
    isBusy: activeAction === "updateReorderRequest",
    discard: discardReorderForm,
  });

  const reload = React.useCallback(async () => {
    try {
      const nextData = await fetchSupplies(t, t("message.loadFailed"));
      setData(nextData);
      setMessage(t("message.loaded"));
      setMessageTone("neutral");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void reload();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [reload]);

  async function runAction(
    actionKey: SupplyActionKey,
    method: "POST" | "PATCH",
    body: Record<string, unknown>
  ) {
    if (activeAction !== null) {
      return false;
    }

    setActiveAction(actionKey);

    try {
      const payload = await submitSupplies(method, body, t, t("message.actionFailed"));
      let refreshed = Boolean(payload.data);
      if (payload.data) {
        setData(payload.data);
      } else if (payload.receipt?.refreshRequired) {
        try {
          setData(await fetchSupplies(t, t("message.loadFailed")));
          refreshed = true;
        } catch {
          refreshed = false;
        }
      }
      const resultMessage = suppliesApiResultMessage(payload, t);
      setMessage(
        refreshed
          ? resultMessage
          : t("message.actionCompleteRefresh", { message: resultMessage })
      );
      setMessageTone(refreshed ? "neutral" : "warning");
      return true;
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      try {
        setData(await fetchSupplies(t, t("message.loadFailed")));
      } catch {
        // Preserve the mutation error; the next explicit reload can retry the read.
      }
      setMessage(failureMessage);
      setMessageTone("warning");
      return false;
    } finally {
      setActiveAction(null);
    }
  }

  async function saveSupply() {
    const ok = await runAction(
      "saveSupply",
      supplyForm.supplyId ? "PATCH" : "POST",
      {
        action: "saveSupply",
        ...supplyForm,
      }
    );

    if (ok) {
      const nextForm = { ...emptySupplyForm };
      setSupplyForm(nextForm);
      setSupplyBaseline(nextForm);
    }
  }

  async function recordMovement() {
    const retainedSupplyId = movementForm.supplyId;
    const operation = prepareSupplyMovementOperation(
      movementForm,
      pendingMovementOperation.current,
      () => window.crypto.randomUUID()
    );
    pendingMovementOperation.current = operation;
    const ok = await runAction("recordMovement", "POST", {
      action: "recordMovement",
      ...movementForm,
      idempotencyKey: operation.operationId,
    });

    if (ok) {
      pendingMovementOperation.current = null;
      applyMovementSupplyTarget(retainedSupplyId);
    }
  }

  async function saveRule() {
    const retainedSupplyId = ruleForm.supplyId;
    const quantityPerUnit = normalizedRuleQuantityInput(
      ruleForm.quantityPerUnit
    );
    setRuleForm((current) => ({ ...current, quantityPerUnit }));
    const ok = await runAction("saveConsumptionRule", "POST", {
      action: "saveConsumptionRule",
      ...ruleForm,
      quantityPerUnit,
    });

    if (ok) {
      const nextForm = {
        ...emptyRuleForm,
        supplyId: retainedSupplyId,
      };
      setRuleForm(nextForm);
      setRuleBaseline(nextForm);
    }
  }

  async function calculateForecast() {
    await runAction("calculateForecast", "POST", {
      action: "calculateForecast",
      lookbackDays,
    });
  }

  async function createReorderSuggestions() {
    await runAction("createReorderSuggestions", "POST", {
      action: "createReorderSuggestions",
    });
  }

  async function loadMoreReorderHistory() {
    const cursor = data?.reorderHistoryPage.nextCursor;
    if (!cursor || reorderHistoryLoading) return;
    setReorderHistoryLoading(true);
    try {
      const nextData = await fetchSupplies(t, t("message.loadFailed"), cursor);
      setData((current) => {
        if (!current) return nextData;
        const historyById = new Map(
          current.reorderHistory.map((reorder) => [reorder.reorderRequestId, reorder])
        );
        for (const reorder of nextData.reorderHistory) {
          historyById.set(reorder.reorderRequestId, reorder);
        }
        return {
          ...nextData,
          reorderHistory: [...historyById.values()],
        };
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setReorderHistoryLoading(false);
    }
  }

  async function updateReorder() {
    const ok = await runAction("updateReorderRequest", "PATCH", {
      action: "updateReorderRequest",
      ...reorderForm,
      expectedRequestStatus: reorderBaseline.requestStatus,
    });

    if (ok) {
      const nextForm = { ...emptyReorderForm };
      setReorderForm(nextForm);
      setReorderBaseline(nextForm);
    }
  }

  function applyMovementSupplyTarget(supplyId: string) {
    const nextState = createSupplyMovementTargetState(supplyId);
    setMovementForm(nextState.current);
    setMovementBaseline(nextState.baseline);
  }

  function applySelectedSupply(supply: SupplyDto) {
    const nextSupplyForm = formFromSupply(supply);
    setSupplyForm(nextSupplyForm);
    setSupplyBaseline(nextSupplyForm);
    applyMovementSupplyTarget(String(supply.supplyId));
  }

  function selectSupply(supply: SupplyDto) {
    runGuardedAction({
      intent: "internal-change",
      formIds: [
        SUPPLIES_FORM_IDS.master,
        SUPPLIES_FORM_IDS.inventoryMovement,
      ],
      targetLabel: t("unsaved.openSupply", { name: supply.supplyName }),
      action: () => applySelectedSupply(supply),
    });
  }

  function resetSupplyForm() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SUPPLIES_FORM_IDS.master],
      targetLabel: t("unsaved.resetSupply"),
      action: () => {
        const nextForm = { ...emptySupplyForm };
        setSupplyForm(nextForm);
        setSupplyBaseline(nextForm);
      },
    });
  }

  function selectMovementSupply(supplyId: string) {
    const nextState = createSupplyMovementTargetState(supplyId);
    const nextSupplyId = nextState.current.supplyId;

    if (nextSupplyId === movementForm.supplyId) {
      return;
    }

    const nextSupply = supplies.find(
      (supply) => String(supply.supplyId) === nextSupplyId
    );

    runGuardedAction({
      intent: "internal-change",
      formIds: [SUPPLIES_FORM_IDS.inventoryMovement],
      targetLabel: nextSupply
        ? t("unsaved.switchMovement", { name: nextSupply.supplyName })
        : t("unsaved.clearMovement"),
      action: () => {
        setMovementForm(nextState.current);
        setMovementBaseline(nextState.baseline);
      },
    });
  }

  function selectRule(rule: RuleDto) {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SUPPLIES_FORM_IDS.consumptionRule],
      targetLabel: t("unsaved.openRule"),
      action: () => {
        const nextForm = ruleFormFromRule(rule);
        setRuleForm(nextForm);
        setRuleBaseline(nextForm);
      },
    });
  }

  function selectReorder(reorder: ReorderDto) {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SUPPLIES_FORM_IDS.reorderRequest],
      targetLabel: t("unsaved.openReorder", { id: String(reorder.reorderRequestId) }),
      action: () => {
        const nextForm = reorderFormFromReorder(reorder);
        setReorderForm(nextForm);
        setReorderBaseline(nextForm);
      },
    });
  }

  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="min-h-0 flex-1 overflow-auto pb-8">
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              icon={PackageCheck}
              label={t("summary.registered")}
              value={data?.summary.supplyCount ?? 0}
            />
            <SummaryCard
              icon={PackageCheck}
              label={t("summary.active")}
              value={data?.summary.activeSupplyCount ?? 0}
            />
            <SummaryCard
              icon={TrendingUp}
              label={t("summary.belowReorder")}
              value={data?.summary.belowReorderPointCount ?? 0}
            />
            <SummaryCard
              icon={BadgeDollarSign}
              label={t("summary.openReorders")}
              value={data?.summary.openReorderCount ?? 0}
            />
          </div>

          {mode !== "forecast" ? <StatusMessage message={message} tone={messageTone} /> : null}

          {mode === "inventory" ? (
            <InventoryMode
              supplies={supplies}
              recentMovements={data?.recentMovements ?? []}
              supplyForm={supplyForm}
              movementForm={movementForm}
              saving={saving}
              supplyBusy={activeAction === "saveSupply"}
              movementBusy={activeAction === "recordMovement"}
              setSupplyForm={setSupplyForm}
              setMovementForm={setMovementForm}
              selectSupply={selectSupply}
              selectMovementSupply={selectMovementSupply}
              resetSupplyForm={resetSupplyForm}
              saveSupply={saveSupply}
              recordMovement={recordMovement}
            />
          ) : null}

          {mode === "forecast" ? (
            <ForecastMode
              supplies={supplies}
              forecasts={forecasts}
              forecastValidations={forecastValidations}
              ruleForm={ruleForm}
              lookbackDays={lookbackDays}
              message={message}
              messageTone={messageTone}
              saving={saving}
              ruleBusy={activeAction === "saveConsumptionRule"}
              setRuleForm={setRuleForm}
              setLookbackDays={setLookbackDays}
              selectRule={selectRule}
              saveRule={saveRule}
              calculateForecast={calculateForecast}
            />
          ) : null}

          {mode === "reorder" ? (
            <ReorderMode
              forecasts={forecasts}
              reorders={reorders}
              reorderForm={reorderForm}
              saving={saving}
              reorderBusy={activeAction === "updateReorderRequest"}
              setReorderForm={setReorderForm}
              selectReorder={selectReorder}
              updateReorder={updateReorder}
              createReorderSuggestions={createReorderSuggestions}
              reorderHistoryPage={data?.reorderHistoryPage ?? {
                hasMore: false,
                nextCursor: null,
              }}
              reorderHistoryLoading={reorderHistoryLoading}
              loadMoreReorderHistory={loadMoreReorderHistory}
            />
          ) : null}
        </div>
      </div>
    </WorkspacePageFrame>
  );
}

function InventoryMode({
  supplies,
  recentMovements,
  supplyForm,
  movementForm,
  saving,
  supplyBusy,
  movementBusy,
  setSupplyForm,
  setMovementForm,
  selectSupply,
  selectMovementSupply,
  resetSupplyForm,
  saveSupply,
  recordMovement,
}: {
  supplies: SupplyDto[];
  recentMovements: MovementDto[];
  supplyForm: SupplyForm;
  movementForm: MovementForm;
  saving: boolean;
  supplyBusy: boolean;
  movementBusy: boolean;
  setSupplyForm: React.Dispatch<React.SetStateAction<SupplyForm>>;
  setMovementForm: React.Dispatch<React.SetStateAction<MovementForm>>;
  selectSupply: (supply: SupplyDto) => void;
  selectMovementSupply: (supplyId: string) => void;
  resetSupplyForm: () => void;
  saveSupply: () => void;
  recordMovement: () => void;
}) {
  const t = useTranslations("supplies");
  const locale = useLocale();

  function policyLabel(value: string) {
    return value === OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly
      ? t("policy.confirmedOnly")
      : t("policy.prepackAllowed");
  }

  function movementTypeLabel(value: string) {
    if (value === SUPPLY_MOVEMENT_TYPE.consumed) return t("movement.type.consumed");
    if (value === SUPPLY_MOVEMENT_TYPE.adjustment) return t("movement.type.adjustment");
    if (value === SUPPLY_MOVEMENT_TYPE.returned) return t("movement.type.returned");
    if (value === SUPPLY_MOVEMENT_TYPE.discarded) return t("movement.type.discarded");
    return t("movement.type.inbound");
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid gap-4">
        <Section title={t("inventory.title")}>
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[1120px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{t("table.code")}</th>
                  <th className="px-3 py-2 text-left">{t("table.name")}</th>
                  <th className="px-3 py-2 text-left">{t("table.category")}</th>
                  <th className="px-3 py-2 text-right">{t("table.current")}</th>
                  <th className="px-3 py-2 text-right">{t("table.reserved")}</th>
                  <th className="px-3 py-2 text-right">{t("table.available")}</th>
                  <th className="px-3 py-2 text-left">{t("table.location")}</th>
                  <th className="px-3 py-2 text-left">{t("table.policy")}</th>
                  <th className="px-3 py-2 text-left">{t("table.status")}</th>
                  <th className="px-3 py-2 text-left">{t("table.action")}</th>
                </tr>
              </thead>
              <tbody>
                {supplies.map((supply) => (
                  <tr key={supply.supplyId} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{supply.supplyCode}</td>
                    <td className="px-3 py-2 font-medium">{supply.supplyName}</td>
                    <td className="px-3 py-2">{supply.category || "-"}</td>
                    <td className="px-3 py-2 text-right">{numberText(supply.currentQuantity, locale)}</td>
                    <td className="px-3 py-2 text-right">{numberText(supply.reservedQuantity, locale)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{numberText(supply.availableQuantity, locale)}</td>
                    <td className="px-3 py-2">{supply.inventoryLocation || "-"}</td>
                    <td className="px-3 py-2 text-xs">
                      {policyLabel(supply.outboundConsumptionPolicy)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={supply.isActive ? "success" : "neutral"}>
                        {supply.isActive ? t("inventory.active") : t("inventory.inactive")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => selectSupply(supply)}
                      >
                        {t("actions.select")}
                      </Button>
                    </td>
                  </tr>
                ))}
                {supplies.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={10}>
                      {t("inventory.empty")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title={t("movement.title")}>
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[840px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{t("table.date")}</th>
                  <th className="px-3 py-2 text-left">{t("table.supply")}</th>
                  <th className="px-3 py-2 text-left">{t("table.type")}</th>
                  <th className="px-3 py-2 text-right">{t("table.quantity")}</th>
                  <th className="px-3 py-2 text-right">{t("table.before")}</th>
                  <th className="px-3 py-2 text-right">{t("table.after")}</th>
                  <th className="px-3 py-2 text-left">{t("table.reason")}</th>
                  <th className="px-3 py-2 text-left">{t("table.operator")}</th>
                </tr>
              </thead>
              <tbody>
                {recentMovements.map((movement) => (
                  <tr key={movement.movementId} className="border-t">
                    <td className="px-3 py-2">{movement.createdAt}</td>
                    <td className="px-3 py-2">{movement.supplyName}</td>
                    <td className="px-3 py-2">{movementTypeLabel(movement.movementType)}</td>
                    <td className="px-3 py-2 text-right">{numberText(movement.quantity, locale)}</td>
                    <td className="px-3 py-2 text-right">{numberText(movement.beforeQuantity, locale)}</td>
                    <td className="px-3 py-2 text-right">{numberText(movement.afterQuantity, locale)}</td>
                    <td className="px-3 py-2">{movement.reason || "-"}</td>
                    <td className="px-3 py-2">{movement.createdByDisplayName || "-"}</td>
                  </tr>
                ))}
                {recentMovements.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={8}>
                      {t("movement.empty")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="grid gap-4">
        <Section title={supplyForm.supplyId ? t("form.editTitle") : t("form.newTitle")}>
          <fieldset disabled={supplyBusy} className="grid min-w-0 gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("form.code")}>
                <Input
                  value={supplyForm.supplyCode}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      supplyCode: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
              <Field label={t("form.category")}>
                <Input
                  value={supplyForm.category}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      category: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
            </div>
            <Field label={t("form.name")}>
              <Input
                value={supplyForm.supplyName}
                onChange={(event) =>
                  setSupplyForm((current) => ({
                    ...current,
                    supplyName: event.target.value,
                  }))
                }
                autoComplete="off"
              />
            </Field>
            <Field label={t("form.consumptionPolicy")}>
              <Select
                value={supplyForm.outboundConsumptionPolicy}
                onValueChange={(value) =>
                  setSupplyForm((current) => ({
                    ...current,
                    outboundConsumptionPolicy: value,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(OUTBOUND_SUPPLY_CONSUMPTION_POLICY).map((value) => (
                    <SelectItem key={value} value={value}>
                      {policyLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label={t("form.baseUnit")}>
                <Input
                  value={supplyForm.baseUnit}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      baseUnit: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
              <Field label={t("form.orderUnit")}>
                <Input
                  value={supplyForm.orderUnit}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      orderUnit: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
              <Field label={t("form.orderUnitQuantity")}>
                <Input
                  type="number"
                  value={supplyForm.orderUnitQuantity}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      orderUnitQuantity: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("form.minLeadTime")}>
                <Input
                  type="number"
                  value={supplyForm.minLeadTimeDays}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      minLeadTimeDays: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("form.maxLeadTime")}>
                <Input
                  type="number"
                  value={supplyForm.maxLeadTimeDays}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      maxLeadTimeDays: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("form.lossRate")}>
                <Input
                  type="number"
                  value={supplyForm.lossRatePercent}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      lossRatePercent: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("form.targetStockDays")}>
                <Input
                  type="number"
                  value={supplyForm.targetStockDays}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      targetStockDays: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("form.defaultSupplier")}>
                <Input
                  value={supplyForm.defaultSupplierName}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      defaultSupplierName: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
              <Field label={t("form.inventoryLocation")}>
                <Input
                  value={supplyForm.inventoryLocation}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      inventoryLocation: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label={t("form.unitCost")}>
                <Input
                  type="number"
                  value={supplyForm.unitCost}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      unitCost: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("form.minimumOrderQuantity")}>
                <Input
                  type="number"
                  value={supplyForm.minimumOrderQuantity}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      minimumOrderQuantity: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("form.reservedQuantity")}>
                <Input
                  type="number"
                  value={supplyForm.reservedQuantity}
                  onChange={(event) =>
                    setSupplyForm((current) => ({
                      ...current,
                      reservedQuantity: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <Field label={t("form.memo")}>
              <Input
                value={supplyForm.note}
                onChange={(event) =>
                  setSupplyForm((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
                autoComplete="off"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={supplyForm.isActive}
                onChange={(event) =>
                  setSupplyForm((current) => ({
                    ...current,
                    isActive: event.target.checked,
                  }))
                }
              />
              {t("form.active")}
            </label>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={resetSupplyForm}
              >
                {t("actions.reset")}
              </Button>
              <Button onClick={saveSupply} disabled={saving}>
                <Save className="size-4" />
                {t("actions.save")}
              </Button>
            </div>
          </fieldset>
        </Section>

        <Section title={t("movement.formTitle")}>
          <fieldset disabled={movementBusy} className="grid min-w-0 gap-3">
            <Field label={t("table.supply")}>
              <Select
                value={movementForm.supplyId || "NONE"}
                onValueChange={selectMovementSupply}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">{t("movement.selectSupply")}</SelectItem>
                  {supplies.map((supply) => (
                    <SelectItem key={supply.supplyId} value={String(supply.supplyId)}>
                      {supply.supplyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("table.type")}>
                <Select
                  value={movementForm.movementType}
                  onValueChange={(value) =>
                    setMovementForm((current) => ({
                      ...current,
                      movementType: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SUPPLY_MOVEMENT_TYPE).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {movementTypeLabel(value)}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={movementForm.movementType === SUPPLY_MOVEMENT_TYPE.adjustment ? t("table.after") : t("table.quantity")}>
                <Input
                  type="number"
                  min={
                    movementForm.movementType === SUPPLY_MOVEMENT_TYPE.adjustment
                      ? 0
                      : 1
                  }
                  step={1}
                  value={movementForm.quantity}
                  onChange={(event) =>
                    setMovementForm((current) => ({
                      ...current,
                      quantity: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <Field label={t("table.reason")}>
              <Input
                value={movementForm.reason}
                onChange={(event) =>
                  setMovementForm((current) => ({
                    ...current,
                    reason: event.target.value,
                  }))
                }
                autoComplete="off"
              />
            </Field>
            <Button onClick={recordMovement} disabled={saving}>
              {t("movement.save")}
            </Button>
          </fieldset>
        </Section>
      </div>

    </div>
  );
}

function ForecastMode({
  supplies,
  forecasts,
  forecastValidations,
  ruleForm,
  lookbackDays,
  message,
  messageTone,
  saving,
  ruleBusy,
  setRuleForm,
  setLookbackDays,
  selectRule,
  saveRule,
  calculateForecast,
}: {
  supplies: SupplyDto[];
  forecasts: ForecastDto[];
  forecastValidations: ForecastValidationDto[];
  ruleForm: RuleForm;
  lookbackDays: string;
  message: string;
  messageTone: "neutral" | "warning";
  saving: boolean;
  ruleBusy: boolean;
  setRuleForm: React.Dispatch<React.SetStateAction<RuleForm>>;
  setLookbackDays: React.Dispatch<React.SetStateAction<string>>;
  selectRule: (rule: RuleDto) => void;
  saveRule: () => void;
  calculateForecast: () => void;
}) {
  const t = useTranslations("supplies");
  const locale = useLocale();
  const [activeTab, setActiveTab] = React.useState("rules");
  const triggerLabels: Record<string, string> = React.useMemo(
    () => ({
      PURCHASED_DEVICE: t("trigger.PURCHASED_DEVICE"),
      SHIPMENT_CREATED: t("trigger.SHIPMENT_CREATED"),
      ORDER_ITEM: t("trigger.ORDER_ITEM"),
      PACKING_COMPLETED: t("trigger.PACKING_COMPLETED"),
      RETURN_RECEIVED: t("trigger.RETURN_RECEIVED"),
    }),
    [t]
  );
  const supportedRuleFilters = supplyConsumptionRuleFilterDefinitions(
    ruleForm.triggerType
  );
  const ruleFilterText = React.useCallback(
    (rule: RuleTableRow) =>
      supplyConsumptionRuleFilterText(rule, (key) =>
        t(`rule.filterField.${key}`)
      ),
    [t]
  );
  const ruleRows = React.useMemo(
    () =>
      supplies.flatMap((supply) =>
        supply.rules.map((rule) => ({
          ...rule,
          supplyName: supply.supplyName,
        }))
      ),
    [supplies]
  );
  const ruleColumns = React.useMemo<DataGridColumn<RuleColumnKey, RuleTableRow>[]>(
    () => [
      {
        key: "supply",
        label: t("table.supply"),
        width: "minmax(180px, 1.2fr)",
        cellClassName: supplyGridCellClassName,
        text: (rule) => rule.supplyName,
        render: (rule) => <span className="truncate">{rule.supplyName}</span>,
      },
      {
        key: "trigger",
        label: t("rule.trigger"),
        width: "180px",
        cellClassName: supplyGridCellClassName,
        text: (rule) => triggerLabels[rule.triggerType] ?? rule.triggerType,
        render: (rule) => (
          <span className="truncate">
            {triggerLabels[rule.triggerType] ?? rule.triggerType}
          </span>
        ),
      },
      {
        key: "quantity",
        label: t("rule.quantity"),
        width: "100px",
        cellClassName: supplyGridRightCellClassName,
        text: (rule) => rule.quantityPerUnit,
        sortValue: (rule) => rule.quantityPerUnit,
        render: (rule) => <span>{numberText(rule.quantityPerUnit, locale)}</span>,
      },
      {
        key: "filter",
        label: t("rule.filter"),
        width: "minmax(220px, 1fr)",
        cellClassName: supplyGridCellClassName,
        text: ruleFilterText,
        render: (rule) => (
          <span className="truncate">
            {ruleFilterText(rule) || "-"}
          </span>
        ),
      },
      {
        key: "status",
        label: t("rule.status"),
        width: "100px",
        cellClassName: supplyGridCellClassName,
        text: (rule) => (rule.isActive ? t("rule.active") : t("rule.inactive")),
        render: (rule) => (
          <Badge variant={rule.isActive ? "success" : "neutral"}>
            {rule.isActive ? t("rule.active") : t("rule.inactive")}
          </Badge>
        ),
      },
      {
        key: "actions",
        label: t("table.action"),
        width: "100px",
        cellClassName: "flex h-full min-w-0 items-center justify-center px-3 py-2",
        sortable: false,
        filterable: false,
        render: (rule) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() => selectRule(rule)}
          >
            {t("rule.edit")}
          </Button>
        ),
      },
    ],
    [locale, ruleFilterText, selectRule, t, triggerLabels]
  );

  return (
    <div className="grid gap-4">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="grid min-h-0 gap-4"
      >
        <div className="flex min-w-0 items-center gap-3">
          <TabsList className="w-fit shrink-0">
            <TabsTrigger value="rules">{t("tabs.rules")}</TabsTrigger>
            <TabsTrigger value="forecasts">{t("tabs.forecast")}</TabsTrigger>
            <TabsTrigger value="validations">{t("tabs.validation")}</TabsTrigger>
          </TabsList>
          <StatusMessage
            message={message}
            tone={messageTone}
            className="flex h-9 min-w-0 flex-1 items-center py-0 text-xs"
          />
        </div>

        <TabsContent value="rules" className="m-0">
          <div className="grid items-start gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div className="grid gap-4">
              <Section title={t("forecast.calculation")}>
                <div className="grid gap-3">
                  <Field label={t("forecast.lookback")}>
                    <Input
                      type="number"
                      value={lookbackDays}
                      onChange={(event) => setLookbackDays(event.target.value)}
                    />
                  </Field>
                  <Button onClick={calculateForecast} disabled={saving}>
                    <BarChart3 className="size-4" />
                    {t("forecast.calculate")}
                  </Button>
                </div>
              </Section>

              <Section title={ruleForm.ruleId ? t("rule.editTitle") : t("rule.newTitle")}>
                <fieldset disabled={ruleBusy} className="grid min-w-0 gap-3">
                  <Field label={t("table.supply")}>
                    <Select
                      value={ruleForm.supplyId || "NONE"}
                      onValueChange={(value) =>
                        setRuleForm((current) => ({
                          ...current,
                          supplyId: value === "NONE" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">{t("rule.selectSupply")}</SelectItem>
                        {supplies.map((supply) => (
                          <SelectItem
                            key={supply.supplyId}
                            value={String(supply.supplyId)}
                          >
                            {supply.supplyName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t("rule.calculationBasis")}>
                      <Select
                        value={ruleForm.triggerType}
                        onValueChange={(value) =>
                          setRuleForm((current) =>
                            supplyConsumptionRuleFormForTrigger(current, value)
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(SUPPLY_CONSUMPTION_TRIGGER).map(
                            (value) => (
                              <SelectItem key={value} value={value}>
                                {t(`trigger.${value}`)}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t("rule.quantityPerUnit")}>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={ruleForm.quantityPerUnit}
                        onChange={(event) =>
                          setRuleForm((current) => ({
                            ...current,
                            quantityPerUnit: event.target.value,
                          }))
                        }
                        onBlur={() =>
                          setRuleForm((current) => ({
                            ...current,
                            quantityPerUnit: normalizedRuleQuantityInput(
                              current.quantityPerUnit
                            ),
                          }))
                        }
                      />
                    </Field>
                  </div>
                  {supportedRuleFilters.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {supportedRuleFilters.map((definition) => (
                        <Field
                          key={definition.key}
                          label={t(`rule.filterForm.${definition.key}`)}
                        >
                          <Input
                            value={ruleForm[definition.key]}
                            onChange={(event) =>
                              setRuleForm((current) => ({
                                ...current,
                                [definition.key]: event.target.value,
                              }))
                            }
                            autoComplete="off"
                          />
                        </Field>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("rule.allItems")}
                    </p>
                  )}
                  <Field label={t("rule.memo")}>
                    <Input
                      value={ruleForm.note}
                      onChange={(event) =>
                        setRuleForm((current) => ({
                          ...current,
                          note: event.target.value,
                        }))
                      }
                      autoComplete="off"
                    />
                  </Field>
                  <Button onClick={saveRule} disabled={saving}>
                    <Save className="size-4" />
                    {t("rule.save")}
                  </Button>
                </fieldset>
              </Section>
            </div>

            <Section title={t("rule.registered")} className="min-h-[624px]">
              <VirtualizedDataGrid
                rows={ruleRows}
                columns={ruleColumns}
                rowKey={(rule) => rule.ruleId}
                emptyMessage={t("rule.empty")}
                className="min-h-0"
                minWidth="880px"
                rowHeight={48}
              />
            </Section>
          </div>
        </TabsContent>

        <TabsContent value="forecasts" className="m-0">
          <ForecastTable forecasts={forecasts} title={t("forecast.result")} />
        </TabsContent>

        <TabsContent value="validations" className="m-0">
          <ForecastValidationTable validations={forecastValidations} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ForecastTable({
  forecasts,
  title,
}: {
  forecasts: ForecastDto[];
  title: string;
}) {
  const t = useTranslations("supplies");
  const locale = useLocale();
  const columns = React.useMemo<DataGridColumn<ForecastColumnKey, ForecastDto>[]>(
    () => [
      {
        key: "forecastDate",
        label: t("forecast.date"),
        width: "120px",
        cellClassName: supplyGridCellClassName,
        text: (forecast) => forecast.forecastDate,
        render: (forecast) => <span>{forecast.forecastDate}</span>,
      },
      {
        key: "supply",
        label: t("table.supply"),
        width: "minmax(180px, 1.2fr)",
        cellClassName: supplyGridCellClassName,
        text: (forecast) => forecast.supplyName,
        render: (forecast) => (
          <span className="truncate font-medium">{forecast.supplyName}</span>
        ),
      },
      {
        key: "averageDailyUsage",
        label: t("forecast.averageDaily"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.averageDailyUsage,
        sortValue: (forecast) => forecast.averageDailyUsage,
        render: (forecast) => (
          <span>{numberText(forecast.averageDailyUsage, locale, 2)}</span>
        ),
      },
      {
        key: "safetyStock",
        label: t("forecast.safetyStock"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.safetyStockQuantity,
        sortValue: (forecast) => forecast.safetyStockQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.safetyStockQuantity, locale, 1)}</span>
        ),
      },
      {
        key: "reorderPoint",
        label: t("forecast.reorderPoint"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.reorderPointQuantity,
        sortValue: (forecast) => forecast.reorderPointQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.reorderPointQuantity, locale, 1)}</span>
        ),
      },
      {
        key: "targetStock",
        label: t("forecast.targetStock"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.targetStockQuantity,
        sortValue: (forecast) => forecast.targetStockQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.targetStockQuantity, locale, 1)}</span>
        ),
      },
      {
        key: "available",
        label: t("table.available"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.availableQuantity,
        sortValue: (forecast) => forecast.availableQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.availableQuantity, locale)}</span>
        ),
      },
      {
        key: "recommended",
        label: t("forecast.recommended"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.recommendedPurchaseQuantity,
        sortValue: (forecast) => forecast.recommendedPurchaseQuantity,
        render: (forecast) => (
          <span className="font-semibold">
            {numberText(forecast.recommendedPurchaseQuantity, locale)}
          </span>
        ),
      },
      {
        key: "stockout",
        label: t("forecast.stockout"),
        width: "150px",
        cellClassName: supplyGridCellClassName,
        text: (forecast) => forecast.expectedStockoutDate || "-",
        render: (forecast) => (
          <span className="truncate">{forecast.expectedStockoutDate || "-"}</span>
        ),
      },
    ],
    [locale, t]
  );

  return (
    <Section title={title}>
      <VirtualizedDataGrid
        rows={forecasts}
        columns={columns}
        rowKey={(forecast) => forecast.forecastId}
        emptyMessage={t("forecast.empty")}
        className="h-[560px]"
        minWidth="1120px"
        rowHeight={48}
      />
    </Section>
  );
}

function ForecastValidationTable({
  validations,
}: {
  validations: ForecastValidationDto[];
}) {
  const t = useTranslations("supplies");
  const locale = useLocale();
  const columns = React.useMemo<
    DataGridColumn<ForecastValidationColumnKey, ForecastValidationDto>[]
  >(
    () => [
      {
        key: "forecastDate",
        label: t("forecast.date"),
        width: "120px",
        cellClassName: supplyGridCellClassName,
        text: (validation) => validation.forecastDate,
        render: (validation) => <span>{validation.forecastDate}</span>,
      },
      {
        key: "supply",
        label: t("table.supply"),
        width: "minmax(180px, 1.2fr)",
        cellClassName: supplyGridCellClassName,
        text: (validation) => validation.supplyName,
        render: (validation) => (
          <span className="truncate font-medium">{validation.supplyName}</span>
        ),
      },
      {
        key: "period",
        label: t("forecast.validationPeriod"),
        width: "210px",
        cellClassName: supplyGridCellClassName,
        text: (validation) =>
          `${validation.validationFrom.slice(0, 10)} ~ ${validation.validationTo.slice(0, 10)}`,
        render: (validation) => (
          <span className="truncate">
            {validation.validationFrom.slice(0, 10)} ~{" "}
            {validation.validationTo.slice(0, 10)}
          </span>
        ),
      },
      {
        key: "elapsed",
        label: t("forecast.elapsed"),
        width: "120px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.elapsedDays,
        sortValue: (validation) => validation.elapsedDays,
        render: (validation) => (
          <span>
            {t("forecast.days", { elapsed: validation.elapsedDays, lookback: validation.lookbackDays })}
          </span>
        ),
      },
      {
        key: "predicted",
        label: t("forecast.predicted"),
        width: "120px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.predictedUsageQuantity,
        sortValue: (validation) => validation.predictedUsageQuantity,
        render: (validation) => (
          <span>{numberText(validation.predictedUsageQuantity, locale, 1)}</span>
        ),
      },
      {
        key: "actual",
        label: t("forecast.actual"),
        width: "120px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.actualUsageQuantity,
        sortValue: (validation) => validation.actualUsageQuantity,
        render: (validation) => (
          <span>{numberText(validation.actualUsageQuantity, locale, 1)}</span>
        ),
      },
      {
        key: "difference",
        label: t("forecast.difference"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.differenceQuantity,
        sortValue: (validation) => validation.differenceQuantity,
        render: (validation) => (
          <span>{numberText(validation.differenceQuantity, locale, 1)}</span>
        ),
      },
      {
        key: "errorRate",
        label: t("forecast.errorRate"),
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.errorRatePercent ?? "",
        sortValue: (validation) => validation.errorRatePercent ?? -1,
        render: (validation) => (
          <span>
            {validation.errorRatePercent === null
              ? "-"
              : `${numberText(validation.errorRatePercent, locale, 1)}%`}
          </span>
        ),
      },
      {
        key: "status",
        label: t("forecast.validationStatus"),
        width: "110px",
        cellClassName: supplyGridCellClassName,
        text: (validation) => t(`validationState.${validation.status}`),
        render: (validation) => (
          <Badge variant={forecastValidationBadgeVariant(validation.status)}>
            {t(`validationState.${validation.status}`)}
          </Badge>
        ),
      },
    ],
    [locale, t]
  );

  return (
    <Section title={t("forecast.validation")}>
      <VirtualizedDataGrid
        rows={validations}
        columns={columns}
        rowKey={(validation) => validation.forecastId}
        emptyMessage={t("forecast.validationEmpty")}
        className="h-[560px]"
        minWidth="1240px"
        rowHeight={48}
      />
      <p className="text-xs text-muted-foreground">
        {t("forecast.validationHint")}
      </p>
    </Section>
  );
}

function ReorderMode({
  forecasts,
  reorders,
  reorderForm,
  saving,
  reorderBusy,
  setReorderForm,
  selectReorder,
  updateReorder,
  createReorderSuggestions,
  reorderHistoryPage,
  reorderHistoryLoading,
  loadMoreReorderHistory,
}: {
  forecasts: ForecastDto[];
  reorders: ReorderDto[];
  reorderForm: ReorderForm;
  saving: boolean;
  reorderBusy: boolean;
  setReorderForm: React.Dispatch<React.SetStateAction<ReorderForm>>;
  selectReorder: (reorder: ReorderDto) => void;
  updateReorder: () => void;
  createReorderSuggestions: () => void;
  reorderHistoryPage: { hasMore: boolean; nextCursor: string | null };
  reorderHistoryLoading: boolean;
  loadMoreReorderHistory: () => void;
}) {
  const t = useTranslations("supplies");
  const locale = useLocale();

  function reorderStatusLabel(value: string) {
    if (value === SUPPLY_REORDER_STATUS.requested) return t("reorder.statusValue.requested");
    if (value === SUPPLY_REORDER_STATUS.approved) return t("reorder.statusValue.approved");
    if (value === SUPPLY_REORDER_STATUS.ordered) return t("reorder.statusValue.ordered");
    if (value === SUPPLY_REORDER_STATUS.received) return t("reorder.statusValue.received");
    if (value === SUPPLY_REORDER_STATUS.cancelled) return t("reorder.statusValue.cancelled");
    return t("reorder.statusValue.suggested");
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid gap-4">
        <Section
          title={t("reorder.listTitle")}
          action={
            <Button onClick={createReorderSuggestions} disabled={saving}>
              <BadgeDollarSign className="size-4" />
              {t("reorder.createSuggestions")}
            </Button>
          }
        >
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{t("table.supply")}</th>
                  <th className="px-3 py-2 text-left">{t("reorder.status")}</th>
                  <th className="px-3 py-2 text-right">{t("reorder.recommended")}</th>
                  <th className="px-3 py-2 text-right">{t("reorder.request")}</th>
                  <th className="px-3 py-2 text-right">{t("reorder.ordered")}</th>
                  <th className="px-3 py-2 text-right">{t("reorder.received")}</th>
                  <th className="px-3 py-2 text-left">{t("reorder.supplier")}</th>
                  <th className="px-3 py-2 text-left">{t("reorder.action")}</th>
                </tr>
              </thead>
              <tbody>
                {reorders.map((reorder) => (
                  <tr key={reorder.reorderRequestId} className="border-t">
                    <td className="px-3 py-2 font-medium">{reorder.supplyName}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          variant={
                            reorder.requestStatus === SUPPLY_REORDER_STATUS.received
                              ? "success"
                              : reorder.requestStatus === SUPPLY_REORDER_STATUS.cancelled
                                ? "neutral"
                                : "warning"
                          }
                        >
                          {reorderStatusLabel(reorder.requestStatus)}
                        </Badge>
                        {reorder.isForecastOutdated ? (
                          <Badge variant="danger">{t("reorder.forecastOutdated")}</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div>{numberText(reorder.recommendedQuantity, locale)}</div>
                      {reorder.isForecastOutdated ? (
                        <div className="text-xs text-muted-foreground">
                          {t("reorder.latestRecommended", { quantity: numberText(reorder.latestRecommendedQuantity, locale) })}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{numberText(reorder.requestedQuantity, locale)}</td>
                    <td className="px-3 py-2 text-right">{numberText(reorder.orderedQuantity, locale)}</td>
                    <td className="px-3 py-2 text-right">{numberText(reorder.receivedQuantity, locale)}</td>
                    <td className="px-3 py-2">{reorder.supplierName || "-"}</td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => selectReorder(reorder)}
                      >
                        {t("reorder.select")}
                      </Button>
                    </td>
                  </tr>
                ))}
                {reorders.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={8}>
                      {t("reorder.empty")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {reorderHistoryPage.hasMore ? (
            <div className="flex justify-center pt-3">
              <Button
                variant="outline"
                onClick={loadMoreReorderHistory}
                disabled={reorderHistoryLoading}
              >
                {reorderHistoryLoading ? t("reorder.loading") : t("reorder.historyMore")}
              </Button>
            </div>
          ) : null}
        </Section>

        <ForecastTable
          forecasts={forecasts.filter(
            (forecast) => forecast.recommendedPurchaseQuantity > 0
          )}
          title={t("reorder.recommendedTargets")}
        />
      </div>

      <Section title={t("reorder.editTitle")}>
        <fieldset disabled={reorderBusy} className="grid min-w-0 gap-3">
          <Field label={t("reorder.requestId")}>
            <Input value={reorderForm.reorderRequestId} readOnly />
          </Field>
          <Field label={t("reorder.status")}>
            <Select
              value={reorderForm.requestStatus}
              onValueChange={(value) =>
                setReorderForm((current) => ({
                  ...current,
                  requestStatus: value,
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(SUPPLY_REORDER_STATUS).map((value) => (
                  <SelectItem key={value} value={value}>
                    {reorderStatusLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("reorder.requestedQuantity")}>
              <Input
                type="number"
                value={reorderForm.requestedQuantity}
                onChange={(event) =>
                  setReorderForm((current) => ({
                    ...current,
                    requestedQuantity: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label={t("reorder.orderedQuantity")}>
              <Input
                type="number"
                value={reorderForm.orderedQuantity}
                onChange={(event) =>
                  setReorderForm((current) => ({
                    ...current,
                    orderedQuantity: event.target.value,
                  }))
                }
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("reorder.receivedQuantity")}>
              <Input
                type="number"
                value={reorderForm.receivedQuantity}
                onChange={(event) =>
                  setReorderForm((current) => ({
                    ...current,
                    receivedQuantity: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label={t("reorder.expectedUnitCost")}>
              <Input
                type="number"
                value={reorderForm.expectedUnitCost}
                onChange={(event) =>
                  setReorderForm((current) => ({
                    ...current,
                    expectedUnitCost: event.target.value,
                  }))
                }
              />
            </Field>
          </div>
          <Field label={t("reorder.supplier")}>
            <Input
              value={reorderForm.supplierName}
              onChange={(event) =>
                setReorderForm((current) => ({
                  ...current,
                  supplierName: event.target.value,
                }))
              }
              autoComplete="off"
            />
          </Field>
          <Field label={t("reorder.reason")}>
            <Input
              value={reorderForm.reason}
              onChange={(event) =>
                setReorderForm((current) => ({
                  ...current,
                  reason: event.target.value,
                }))
              }
              autoComplete="off"
            />
          </Field>
          <div className="text-xs text-muted-foreground">
            {t("reorder.saveHint")}
          </div>
          <Button
            onClick={updateReorder}
            disabled={saving || !reorderForm.reorderRequestId}
          >
            <Save className="size-4" />
            {t("reorder.save")}
          </Button>
        </fieldset>
      </Section>
    </div>
  );
}
