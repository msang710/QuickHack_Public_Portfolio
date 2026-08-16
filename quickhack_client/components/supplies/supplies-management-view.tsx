// QuickHack note: 비품관리의 재고관리, 소요예측, 재구매 메뉴를 실제 API와 연결합니다.
"use client";

import * as React from "react";
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
  OUTBOUND_SUPPLY_CONSUMPTION_POLICY_LABELS,
  SUPPLY_CONSUMPTION_TRIGGER,
  SUPPLY_CONSUMPTION_TRIGGER_LABELS,
  SUPPLY_MOVEMENT_TYPE,
  SUPPLY_MOVEMENT_TYPE_LABELS,
  SUPPLY_REORDER_STATUS,
  SUPPLY_REORDER_STATUS_LABELS,
  normalizeSupplyConsumptionQuantity,
  supplyConsumptionTriggerLabel,
  outboundSupplyConsumptionPolicyLabel,
  supplyMovementTypeLabel,
  supplyReorderStatusLabel,
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
  status: string;
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
  message?: string;
  data?: SupplyWorkspaceData;
  result?: unknown;
  receipt?: import("@/quickhack_shared/core/mutation-receipt").MutationReceipt<unknown>;
};

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

function numberText(value: number | null | undefined, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return value.toLocaleString("ko-KR", {
    maximumFractionDigits: digits,
  });
}

function normalizedRuleQuantityInput(value: string) {
  const normalized = normalizeSupplyConsumptionQuantity(value);
  return normalized === null ? value : String(normalized);
}

function moneyText(value: number | null | undefined) {
  if (typeof value !== "number") {
    return "-";
  }

  return `₩ ${value.toLocaleString("ko-KR")}`;
}

const supplyGridCellClassName = "flex h-full min-w-0 items-center px-3 py-2";
const supplyGridRightCellClassName =
  "flex h-full min-w-0 items-center justify-end px-3 py-2 text-right";

function forecastValidationBadgeVariant(status: string) {
  if (status === "양호" || status === "사용 없음") {
    return "success" as const;
  }

  if (status === "주의" || status === "검증 대기") {
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
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <FeedbackBanner
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        message.includes("못") || message.includes("실패") || message.includes("없")
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "bg-popover",
        className
      )}
    >
      <span className="block truncate">{message}</span>
    </FeedbackBanner>
  );
}

async function fetchSupplies(reorderCursor?: string | null) {
  const query = new URLSearchParams();
  if (reorderCursor) query.set("reorderCursor", reorderCursor);
  const response = await fetch(
    `/api/supplies${query.size > 0 ? `?${query.toString()}` : ""}`,
    { cache: "no-store" }
  );
  const payload = (await response.json()) as SuppliesApiResponse;

  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(payload.message || "비품관리 데이터를 불러오지 못했습니다.");
  }

  return payload.data;
}

async function submitSupplies(method: "POST" | "PATCH", body: Record<string, unknown>) {
  const response = await fetch("/api/supplies", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as SuppliesApiResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "비품관리 작업에 실패했습니다.");
  }

  return payload;
}

export function SuppliesManagementView({ mode }: { mode: SuppliesMode }) {
  const { runGuardedAction } = useUnsavedChanges();
  const [data, setData] = React.useState<SupplyWorkspaceData | null>(null);
  const [message, setMessage] = React.useState("비품관리 데이터를 불러오는 중입니다.");
  const [loading, setLoading] = React.useState(true);
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
      ? `${supplyForm.supplyName || "선택 비품"} 비품 정보`
      : "새 비품 정보",
    enabled: mode === "inventory",
    isDirty: !suppliesDraftSnapshotsEqual(supplyBaseline, supplyForm),
    isBusy: activeAction === "saveSupply",
    discard: discardSupplyForm,
  });
  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.inventoryMovement,
    label: movementSupply
      ? `${movementSupply.supplyName} 수량 기록`
      : "비품 수량 기록",
    enabled: mode === "inventory",
    isDirty: !suppliesDraftSnapshotsEqual(movementBaseline, movementForm),
    isBusy: activeAction === "recordMovement",
    discard: discardMovementForm,
  });
  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.consumptionRule,
    label: ruleForm.ruleId ? "비품 소요 규칙 수정" : "새 비품 소요 규칙",
    enabled: mode === "forecast",
    isDirty: !suppliesDraftSnapshotsEqual(ruleBaseline, ruleForm),
    isBusy: activeAction === "saveConsumptionRule",
    discard: discardRuleForm,
  });
  useUnsavedForm({
    id: SUPPLIES_FORM_IDS.reorderRequest,
    label: reorderForm.reorderRequestId
      ? `재구매 요청 #${reorderForm.reorderRequestId}`
      : "재구매 요청 수정",
    enabled: mode === "reorder",
    isDirty: !suppliesDraftSnapshotsEqual(reorderBaseline, reorderForm),
    isBusy: activeAction === "updateReorderRequest",
    discard: discardReorderForm,
  });

  const reload = React.useCallback(async () => {
    setLoading(true);

    try {
      const nextData = await fetchSupplies();
      setData(nextData);
      setMessage("비품관리 데이터를 불러왔습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

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
      const payload = await submitSupplies(method, body);
      let refreshed = Boolean(payload.data);
      if (payload.data) {
        setData(payload.data);
      } else if (payload.receipt?.refreshRequired) {
        try {
          setData(await fetchSupplies());
          refreshed = true;
        } catch {
          refreshed = false;
        }
      }
      setMessage(
        refreshed
          ? payload.message || "비품관리 작업을 완료했습니다."
          : `${payload.message || "비품관리 작업을 완료했습니다."} 전체 현황은 새로고침해 확인하세요.`
      );
      return true;
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      try {
        setData(await fetchSupplies());
      } catch {
        // Preserve the mutation error; the next explicit reload can retry the read.
      }
      setMessage(failureMessage);
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
      const nextData = await fetchSupplies(cursor);
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
      targetLabel: `${supply.supplyName} 비품 열기`,
      action: () => applySelectedSupply(supply),
    });
  }

  function resetSupplyForm() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [SUPPLIES_FORM_IDS.master],
      targetLabel: "새 비품 입력으로 초기화",
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
        ? `${nextSupply.supplyName} 수량 기록으로 전환`
        : "수량 기록 비품 선택 해제",
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
      targetLabel: "선택한 비품 소요 규칙 열기",
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
      targetLabel: `재구매 요청 #${reorder.reorderRequestId} 열기`,
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
              label="등록 비품"
              value={data?.summary.supplyCount ?? 0}
            />
            <SummaryCard
              icon={PackageCheck}
              label="활성 비품"
              value={data?.summary.activeSupplyCount ?? 0}
            />
            <SummaryCard
              icon={TrendingUp}
              label="재주문점 이하"
              value={data?.summary.belowReorderPointCount ?? 0}
            />
            <SummaryCard
              icon={BadgeDollarSign}
              label="열린 재구매"
              value={data?.summary.openReorderCount ?? 0}
            />
          </div>

          {mode !== "forecast" ? <StatusMessage message={message} /> : null}

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
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid gap-4">
        <Section title="비품 재고 목록">
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[1120px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">코드</th>
                  <th className="px-3 py-2 text-left">비품명</th>
                  <th className="px-3 py-2 text-left">분류</th>
                  <th className="px-3 py-2 text-right">현재</th>
                  <th className="px-3 py-2 text-right">예약</th>
                  <th className="px-3 py-2 text-right">사용가능</th>
                  <th className="px-3 py-2 text-left">위치</th>
                  <th className="px-3 py-2 text-left">출고 차감 시점</th>
                  <th className="px-3 py-2 text-left">상태</th>
                  <th className="px-3 py-2 text-left">작업</th>
                </tr>
              </thead>
              <tbody>
                {supplies.map((supply) => (
                  <tr key={supply.supplyId} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{supply.supplyCode}</td>
                    <td className="px-3 py-2 font-medium">{supply.supplyName}</td>
                    <td className="px-3 py-2">{supply.category || "-"}</td>
                    <td className="px-3 py-2 text-right">{numberText(supply.currentQuantity)}</td>
                    <td className="px-3 py-2 text-right">{numberText(supply.reservedQuantity)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{numberText(supply.availableQuantity)}</td>
                    <td className="px-3 py-2">{supply.inventoryLocation || "-"}</td>
                    <td className="px-3 py-2 text-xs">
                      {outboundSupplyConsumptionPolicyLabel(
                        supply.outboundConsumptionPolicy
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={supply.isActive ? "success" : "neutral"}>
                        {supply.isActive ? "사용" : "비활성"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => selectSupply(supply)}
                      >
                        선택
                      </Button>
                    </td>
                  </tr>
                ))}
                {supplies.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={10}>
                      등록된 비품이 없습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="최근 수량 이력">
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[840px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">일시</th>
                  <th className="px-3 py-2 text-left">비품</th>
                  <th className="px-3 py-2 text-left">유형</th>
                  <th className="px-3 py-2 text-right">수량</th>
                  <th className="px-3 py-2 text-right">변경 전</th>
                  <th className="px-3 py-2 text-right">변경 후</th>
                  <th className="px-3 py-2 text-left">사유</th>
                  <th className="px-3 py-2 text-left">작업자</th>
                </tr>
              </thead>
              <tbody>
                {recentMovements.map((movement) => (
                  <tr key={movement.movementId} className="border-t">
                    <td className="px-3 py-2">{movement.createdAt}</td>
                    <td className="px-3 py-2">{movement.supplyName}</td>
                    <td className="px-3 py-2">{supplyMovementTypeLabel(movement.movementType)}</td>
                    <td className="px-3 py-2 text-right">{numberText(movement.quantity)}</td>
                    <td className="px-3 py-2 text-right">{numberText(movement.beforeQuantity)}</td>
                    <td className="px-3 py-2 text-right">{numberText(movement.afterQuantity)}</td>
                    <td className="px-3 py-2">{movement.reason || "-"}</td>
                    <td className="px-3 py-2">{movement.createdByDisplayName || "-"}</td>
                  </tr>
                ))}
                {recentMovements.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={8}>
                      최근 수량 이력이 없습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="grid gap-4">
        <Section title={supplyForm.supplyId ? "비품 수정" : "비품 등록"}>
          <fieldset disabled={supplyBusy} className="grid min-w-0 gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="비품 코드">
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
              <Field label="분류">
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
            <Field label="비품명">
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
            <Field label="출고 차감 시점">
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
                  {Object.entries(
                    OUTBOUND_SUPPLY_CONSUMPTION_POLICY_LABELS
                  ).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="기본단위">
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
              <Field label="주문단위">
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
              <Field label="주문단위 수량">
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
              <Field label="최소 리드타임">
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
              <Field label="최대 리드타임">
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
              <Field label="불량소모율(%)">
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
              <Field label="목표 재고일수">
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
              <Field label="매입처">
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
              <Field label="위치">
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
              <Field label="단가">
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
              <Field label="최소주문 수량">
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
              <Field label="예약 수량">
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
            <Field label="메모">
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
              사용 중인 비품
            </label>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={resetSupplyForm}
              >
                입력 초기화
              </Button>
              <Button onClick={saveSupply} disabled={saving}>
                <Save className="size-4" />
                저장
              </Button>
            </div>
          </fieldset>
        </Section>

        <Section title="수량 기록">
          <fieldset disabled={movementBusy} className="grid min-w-0 gap-3">
            <Field label="비품">
              <Select
                value={movementForm.supplyId || "NONE"}
                onValueChange={selectMovementSupply}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">비품 선택</SelectItem>
                  {supplies.map((supply) => (
                    <SelectItem key={supply.supplyId} value={String(supply.supplyId)}>
                      {supply.supplyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="유형">
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
                    {Object.entries(SUPPLY_MOVEMENT_TYPE_LABELS).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={movementForm.movementType === SUPPLY_MOVEMENT_TYPE.adjustment ? "조정 후 수량" : "수량"}>
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
            <Field label="사유">
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
              수량 기록 저장
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
  saving: boolean;
  ruleBusy: boolean;
  setRuleForm: React.Dispatch<React.SetStateAction<RuleForm>>;
  setLookbackDays: React.Dispatch<React.SetStateAction<string>>;
  selectRule: (rule: RuleDto) => void;
  saveRule: () => void;
  calculateForecast: () => void;
}) {
  const [activeTab, setActiveTab] = React.useState("rules");
  const supportedRuleFilters = supplyConsumptionRuleFilterDefinitions(
    ruleForm.triggerType
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
        label: "비품",
        width: "minmax(180px, 1.2fr)",
        cellClassName: supplyGridCellClassName,
        text: (rule) => rule.supplyName,
        render: (rule) => <span className="truncate">{rule.supplyName}</span>,
      },
      {
        key: "trigger",
        label: "기준",
        width: "180px",
        cellClassName: supplyGridCellClassName,
        text: (rule) => supplyConsumptionTriggerLabel(rule.triggerType),
        render: (rule) => (
          <span className="truncate">
            {supplyConsumptionTriggerLabel(rule.triggerType)}
          </span>
        ),
      },
      {
        key: "quantity",
        label: "소요량",
        width: "100px",
        cellClassName: supplyGridRightCellClassName,
        text: (rule) => rule.quantityPerUnit,
        sortValue: (rule) => rule.quantityPerUnit,
        render: (rule) => <span>{numberText(rule.quantityPerUnit)}</span>,
      },
      {
        key: "filter",
        label: "필터",
        width: "minmax(220px, 1fr)",
        cellClassName: supplyGridCellClassName,
        text: supplyConsumptionRuleFilterText,
        render: (rule) => (
          <span className="truncate">
            {supplyConsumptionRuleFilterText(rule) || "-"}
          </span>
        ),
      },
      {
        key: "status",
        label: "상태",
        width: "100px",
        cellClassName: supplyGridCellClassName,
        text: (rule) => (rule.isActive ? "사용" : "비활성"),
        render: (rule) => (
          <Badge variant={rule.isActive ? "success" : "neutral"}>
            {rule.isActive ? "사용" : "비활성"}
          </Badge>
        ),
      },
      {
        key: "actions",
        label: "작업",
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
            수정
          </Button>
        ),
      },
    ],
    [selectRule]
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
            <TabsTrigger value="rules">소요 규칙</TabsTrigger>
            <TabsTrigger value="forecasts">예측 결과</TabsTrigger>
            <TabsTrigger value="validations">예측 검증</TabsTrigger>
          </TabsList>
          <StatusMessage
            message={message}
            className="flex h-9 min-w-0 flex-1 items-center py-0 text-xs"
          />
        </div>

        <TabsContent value="rules" className="m-0">
          <div className="grid items-start gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div className="grid gap-4">
              <Section title="예측 계산">
                <div className="grid gap-3">
                  <Field label="조회 기준 기간">
                    <Input
                      type="number"
                      value={lookbackDays}
                      onChange={(event) => setLookbackDays(event.target.value)}
                    />
                  </Field>
                  <Button onClick={calculateForecast} disabled={saving}>
                    <BarChart3 className="size-4" />
                    소요예측 계산
                  </Button>
                </div>
              </Section>

              <Section title={ruleForm.ruleId ? "소요 규칙 수정" : "소요 규칙 등록"}>
                <fieldset disabled={ruleBusy} className="grid min-w-0 gap-3">
                  <Field label="비품">
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
                        <SelectItem value="NONE">비품 선택</SelectItem>
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
                    <Field label="계산 기준">
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
                          {Object.entries(SUPPLY_CONSUMPTION_TRIGGER_LABELS).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="1건당 소요량">
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
                        <Field key={definition.key} label={definition.formLabel}>
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
                      이 계산 기준은 별도 상품 필터 없이 전체 건을 집계합니다.
                    </p>
                  )}
                  <Field label="메모">
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
                    규칙 저장
                  </Button>
                </fieldset>
              </Section>
            </div>

            <Section title="등록된 소요 규칙" className="min-h-[624px]">
              <VirtualizedDataGrid
                rows={ruleRows}
                columns={ruleColumns}
                rowKey={(rule) => rule.ruleId}
                emptyMessage="등록된 소요 규칙이 없습니다."
                className="min-h-0"
                minWidth="880px"
                rowHeight={48}
              />
            </Section>
          </div>
        </TabsContent>

        <TabsContent value="forecasts" className="m-0">
          <ForecastTable forecasts={forecasts} title="소요예측 결과" />
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
  const columns = React.useMemo<DataGridColumn<ForecastColumnKey, ForecastDto>[]>(
    () => [
      {
        key: "forecastDate",
        label: "계산일",
        width: "120px",
        cellClassName: supplyGridCellClassName,
        text: (forecast) => forecast.forecastDate,
        render: (forecast) => <span>{forecast.forecastDate}</span>,
      },
      {
        key: "supply",
        label: "비품",
        width: "minmax(180px, 1.2fr)",
        cellClassName: supplyGridCellClassName,
        text: (forecast) => forecast.supplyName,
        render: (forecast) => (
          <span className="truncate font-medium">{forecast.supplyName}</span>
        ),
      },
      {
        key: "averageDailyUsage",
        label: "일평균",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.averageDailyUsage,
        sortValue: (forecast) => forecast.averageDailyUsage,
        render: (forecast) => (
          <span>{numberText(forecast.averageDailyUsage, 2)}</span>
        ),
      },
      {
        key: "safetyStock",
        label: "안전재고",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.safetyStockQuantity,
        sortValue: (forecast) => forecast.safetyStockQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.safetyStockQuantity, 1)}</span>
        ),
      },
      {
        key: "reorderPoint",
        label: "재주문점",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.reorderPointQuantity,
        sortValue: (forecast) => forecast.reorderPointQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.reorderPointQuantity, 1)}</span>
        ),
      },
      {
        key: "targetStock",
        label: "목표재고",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.targetStockQuantity,
        sortValue: (forecast) => forecast.targetStockQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.targetStockQuantity, 1)}</span>
        ),
      },
      {
        key: "available",
        label: "사용가능",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.availableQuantity,
        sortValue: (forecast) => forecast.availableQuantity,
        render: (forecast) => (
          <span>{numberText(forecast.availableQuantity)}</span>
        ),
      },
      {
        key: "recommended",
        label: "권장구매",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (forecast) => forecast.recommendedPurchaseQuantity,
        sortValue: (forecast) => forecast.recommendedPurchaseQuantity,
        render: (forecast) => (
          <span className="font-semibold">
            {numberText(forecast.recommendedPurchaseQuantity)}
          </span>
        ),
      },
      {
        key: "stockout",
        label: "재고소진 예상",
        width: "150px",
        cellClassName: supplyGridCellClassName,
        text: (forecast) => forecast.expectedStockoutDate || "-",
        render: (forecast) => (
          <span className="truncate">{forecast.expectedStockoutDate || "-"}</span>
        ),
      },
    ],
    []
  );

  return (
    <Section title={title}>
      <VirtualizedDataGrid
        rows={forecasts}
        columns={columns}
        rowKey={(forecast) => forecast.forecastId}
        emptyMessage="계산된 소요예측이 없습니다."
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
  const columns = React.useMemo<
    DataGridColumn<ForecastValidationColumnKey, ForecastValidationDto>[]
  >(
    () => [
      {
        key: "forecastDate",
        label: "계산일",
        width: "120px",
        cellClassName: supplyGridCellClassName,
        text: (validation) => validation.forecastDate,
        render: (validation) => <span>{validation.forecastDate}</span>,
      },
      {
        key: "supply",
        label: "비품",
        width: "minmax(180px, 1.2fr)",
        cellClassName: supplyGridCellClassName,
        text: (validation) => validation.supplyName,
        render: (validation) => (
          <span className="truncate font-medium">{validation.supplyName}</span>
        ),
      },
      {
        key: "period",
        label: "검증 기간",
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
        label: "경과",
        width: "120px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.elapsedDays,
        sortValue: (validation) => validation.elapsedDays,
        render: (validation) => (
          <span>
            {validation.elapsedDays} / {validation.lookbackDays}일
          </span>
        ),
      },
      {
        key: "predicted",
        label: "예측 소요",
        width: "120px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.predictedUsageQuantity,
        sortValue: (validation) => validation.predictedUsageQuantity,
        render: (validation) => (
          <span>{numberText(validation.predictedUsageQuantity, 1)}</span>
        ),
      },
      {
        key: "actual",
        label: "실제 소요",
        width: "120px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.actualUsageQuantity,
        sortValue: (validation) => validation.actualUsageQuantity,
        render: (validation) => (
          <span>{numberText(validation.actualUsageQuantity, 1)}</span>
        ),
      },
      {
        key: "difference",
        label: "차이",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.differenceQuantity,
        sortValue: (validation) => validation.differenceQuantity,
        render: (validation) => (
          <span>{numberText(validation.differenceQuantity, 1)}</span>
        ),
      },
      {
        key: "errorRate",
        label: "오차율",
        width: "110px",
        cellClassName: supplyGridRightCellClassName,
        text: (validation) => validation.errorRatePercent ?? "",
        sortValue: (validation) => validation.errorRatePercent ?? -1,
        render: (validation) => (
          <span>
            {validation.errorRatePercent === null
              ? "-"
              : `${numberText(validation.errorRatePercent, 1)}%`}
          </span>
        ),
      },
      {
        key: "status",
        label: "판정",
        width: "110px",
        cellClassName: supplyGridCellClassName,
        text: (validation) => validation.status,
        render: (validation) => (
          <Badge variant={forecastValidationBadgeVariant(validation.status)}>
            {validation.status}
          </Badge>
        ),
      },
    ],
    []
  );

  return (
    <Section title="예측 검증">
      <VirtualizedDataGrid
        rows={validations}
        columns={columns}
        rowKey={(validation) => validation.forecastId}
        emptyMessage="검증할 소요예측 기록이 없습니다."
        className="h-[560px]"
        minWidth="1240px"
        rowHeight={48}
      />
      <p className="text-xs text-muted-foreground">
        계산일 이후 실제 소모 이력이 쌓이면 예측 소요와 실제 소요를 비교합니다.
        오늘 계산한 예측은 하루 이상 지나야 검증할 수 있습니다.
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
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid gap-4">
        <Section
          title="재구매 요청 목록"
          action={
            <Button onClick={createReorderSuggestions} disabled={saving}>
              <BadgeDollarSign className="size-4" />
              추천 생성
            </Button>
          }
        >
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">비품</th>
                  <th className="px-3 py-2 text-left">상태</th>
                  <th className="px-3 py-2 text-right">권장</th>
                  <th className="px-3 py-2 text-right">요청</th>
                  <th className="px-3 py-2 text-right">주문</th>
                  <th className="px-3 py-2 text-right">입고</th>
                  <th className="px-3 py-2 text-left">거래처</th>
                  <th className="px-3 py-2 text-left">작업</th>
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
                          {supplyReorderStatusLabel(reorder.requestStatus)}
                        </Badge>
                        {reorder.isForecastOutdated ? (
                          <Badge variant="danger">예측 갱신 필요</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div>{numberText(reorder.recommendedQuantity)}</div>
                      {reorder.isForecastOutdated ? (
                        <div className="text-xs text-muted-foreground">
                          최신 권장: {numberText(reorder.latestRecommendedQuantity)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{numberText(reorder.requestedQuantity)}</td>
                    <td className="px-3 py-2 text-right">{numberText(reorder.orderedQuantity)}</td>
                    <td className="px-3 py-2 text-right">{numberText(reorder.receivedQuantity)}</td>
                    <td className="px-3 py-2">{reorder.supplierName || "-"}</td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => selectReorder(reorder)}
                      >
                        선택
                      </Button>
                    </td>
                  </tr>
                ))}
                {reorders.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={8}>
                      재구매 요청이 없습니다.
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
                {reorderHistoryLoading ? "불러오는 중" : "완료 이력 더 보기"}
              </Button>
            </div>
          ) : null}
        </Section>

        <ForecastTable
          forecasts={forecasts.filter(
            (forecast) => forecast.recommendedPurchaseQuantity > 0
          )}
          title="권장 구매 대상"
        />
      </div>

      <Section title="재구매 상태 수정">
        <fieldset disabled={reorderBusy} className="grid min-w-0 gap-3">
          <Field label="재구매 요청">
            <Input value={reorderForm.reorderRequestId} readOnly />
          </Field>
          <Field label="상태">
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
                {Object.entries(SUPPLY_REORDER_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="요청 수량">
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
            <Field label="주문 수량">
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
            <Field label="입고 수량">
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
            <Field label="예상 단가">
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
          <Field label="거래처">
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
          <Field label="사유 / 메모">
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
            상태를 입고 완료로 저장하고 입고 수량이 있으면 비품 재고가 자동 증가합니다.
          </div>
          <Button
            onClick={updateReorder}
            disabled={saving || !reorderForm.reorderRequestId}
          >
            <Save className="size-4" />
            상태 저장
          </Button>
        </fieldset>
      </Section>
    </div>
  );
}
