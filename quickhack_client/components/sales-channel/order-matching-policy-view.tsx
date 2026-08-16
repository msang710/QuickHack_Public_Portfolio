// QuickHack note: 주문 매칭 worker의 고정 조건과 판매 오퍼별 운영 정책을 관리합니다.
"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  GripVertical,
  ListChecks,
  LockKeyhole,
  PackageCheck,
  RefreshCcw,
  Save,
  ShieldCheck,
  Store,
  Trash2,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import { Input } from "@/quickhack_client/components/ui/input";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import type {
  OrderMatchingCandidateSortMode,
  OrderMatchingPolicyMutationRequest,
  OrderMatchingPoliciesPayload,
  OrderMatchingPolicyDto,
  OrderMatchingPriorityTierDto,
  OrderMatchingSalesOfferPolicyRow,
} from "@/quickhack_shared/sales-channel/order-matching-policy";
import {
  ORDER_MATCHING_SALE_GRADE_VALUES,
} from "@/quickhack_shared/sales-channel/order-matching-policy";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import { cn } from "@/quickhack_shared/core/utils";

type RuleField = {
  label: string;
  value: string;
  source: string;
  note: string;
};

type PoliciesApiResponse = {
  ok: boolean;
  message?: string;
  data?: OrderMatchingPoliciesPayload;
  item?: unknown;
};

type PolicyDraft = Omit<OrderMatchingPolicyDto, "source" | "updatedAt">;
const ORDER_MATCHING_POLICY_FORM_ID =
  "sales-channel.order-matching-policy";

type MatchingFilterBasis = "SALE_GRADE" | "STOCK_AGE";
type StockAgeDirection = "OLD_FIRST" | "RECENT_FIRST";

const matchingFilterBasisItems: Record<
  MatchingFilterBasis,
  { label: string; value: string }
> = {
  SALE_GRADE: {
    label: "판매 등급 기준",
    value: "정책의 판매등급 우선순위",
  },
  STOCK_AGE: {
    label: "재고 등록 시간 기준",
    value: "재고 등록 시간을 기준으로 선택",
  },
};

function filterOrderForSortMode(
  value: OrderMatchingCandidateSortMode
): MatchingFilterBasis[] {
  if (
    value === "STOCKED_OLD_THEN_SALE_GRADE" ||
    value === "STOCKED_RECENT_THEN_SALE_GRADE"
  ) {
    return ["STOCK_AGE", "SALE_GRADE"];
  }

  return ["SALE_GRADE", "STOCK_AGE"];
}

function stockAgeDirectionForSortMode(
  value: OrderMatchingCandidateSortMode
): StockAgeDirection {
  return value === "SALE_GRADE_THEN_STOCKED_RECENT" ||
    value === "STOCKED_RECENT_THEN_SALE_GRADE"
    ? "RECENT_FIRST"
    : "OLD_FIRST";
}

function sortModeForFilterState(
  order: MatchingFilterBasis[],
  stockAgeDirection: StockAgeDirection
): OrderMatchingCandidateSortMode {
  if (order[0] === "STOCK_AGE") {
    return stockAgeDirection === "RECENT_FIRST"
      ? "STOCKED_RECENT_THEN_SALE_GRADE"
      : "STOCKED_OLD_THEN_SALE_GRADE";
  }

  return stockAgeDirection === "RECENT_FIRST"
    ? "SALE_GRADE_THEN_STOCKED_RECENT"
    : "SALE_GRADE_THEN_STOCKED_OLD";
}

function gradeOrderFromTiers(tiers: OrderMatchingPriorityTierDto[]) {
  const orderedGrades = tiers
    .flatMap((tier) => tier.saleGradeValues)
    .filter((grade) =>
      ORDER_MATCHING_SALE_GRADE_VALUES.some((value) => value === grade)
    );
  const seen = new Set<string>();
  const uniqueOrderedGrades = orderedGrades.filter((grade) => {
    if (seen.has(grade)) {
      return false;
    }

    seen.add(grade);
    return true;
  });
  const missingGrades = ORDER_MATCHING_SALE_GRADE_VALUES.filter(
    (grade) => !seen.has(grade)
  );

  return [...uniqueOrderedGrades, ...missingGrades];
}

const orderItemRules: RuleField[] = [
  {
    label: "취소 여부",
    value: "취소되지 않은 주문 아이템",
    source: "order_matching_work_queue.canceled != 1",
    note: "취소된 주문 아이템은 자동 매칭 대상에서 제외합니다.",
  },
  {
    label: "매칭 가능 수량",
    value: "matchable_quantity > 0",
    source: "order_matching_work_queue.matchable_quantity",
    note: "실제로 출고 가능한 수량이 남아 있는 아이템만 처리합니다.",
  },
  {
    label: "상품 매핑 상태",
    value: "MAPPED",
    source: "order_matching_work_queue.mapping_status",
    note: "채널 상품이 QuickHack 판매 오퍼에 연결되어 있어야 합니다.",
  },
  {
    label: "판매 오퍼",
    value: "sales_offer_id 필수",
    source: "order_matching_work_queue.sales_offer_id",
    note: "기종, 옵션 조건과 보증그룹이 확정된 주문만 자동 매칭합니다.",
  },
];

const inventoryCandidateRules: RuleField[] = [
  {
    label: "재고 상태",
    value: "판매가능 재고",
    source: "inventory.inventory_status = SELLABLE",
    note: "매입 확정 후 판매 가능한 재고만 예약 후보로 사용합니다.",
  },
  {
    label: "출고 이력",
    value: "활성 매칭 없음",
    source: "match_worker_allocation active none",
    note: "이미 주문 매칭 흐름에 들어간 PG는 후보에서 제외합니다.",
  },
  {
    label: "기존 주문 매칭",
    value: "활성 매칭 없음",
    source: "MATCHED / INVOICE_ISSUED 없음",
    note: "다른 주문에 묶인 PG가 중복 예약되지 않도록 막습니다.",
  },
];

const matchingBasisRules: RuleField[] = [
  {
    label: "기종",
    value: "model",
    source: "sales_offers.model_option_id",
    note: "판매 오퍼의 기종과 실제 재고 SKU 기종이 일치해야 합니다.",
  },
  {
    label: "용량",
    value: "storage",
    source: "sales_offers.storage_match_mode / storage_option_id",
    note: "판매 오퍼의 용량 조건을 재고 후보 조회에 적용합니다.",
  },
  {
    label: "보증그룹",
    value: "warrantyGroup",
    source: "sales_offers.warranty_group_option_id",
    note: "보증그룹에 따라 판매등급 우선순위를 적용합니다.",
  },
];

const workerFields: RuleField[] = [
  {
    label: "worker",
    value: "Order inventory matching",
    source: "quickhack_server/workers/registry.ts",
    note: "판매 채널 주문을 통합해 재고 매칭을 실행하는 worker입니다.",
  },
  {
    label: "기본 실행 주기",
    value: "120초",
    source: "defaultIntervalSeconds",
    note: "시스템 상태 메뉴에서 스케줄을 켜고 끌 수 있습니다.",
  },
  {
    label: "1회 처리량",
    value: "최대 100개 주문 아이템",
    source: "matchOrderInventory({ limit: 100 })",
    note: "worker 1회 실행 기준 처리량입니다.",
  },
];

function rowKey(row: OrderMatchingSalesOfferPolicyRow) {
  return String(row.salesOfferId);
}

function policyDraft(policy: OrderMatchingPolicyDto): PolicyDraft {
  return {
    ...policy,
    tiers: policy.tiers.map((tier) => ({
      ...tier,
      saleGradeValues: [...tier.saleGradeValues],
    })),
  };
}

function offerSearchText(row: OrderMatchingSalesOfferPolicyRow) {
  return [
    row.offerCode,
    row.model,
    row.requiredStorage,
    row.requiredColor,
    row.requiredWarrantyLabel,
    row.requiredWarrantyGroup,
    row.channelNames.join(" "),
    row.policy.source,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function FieldGroup({
  icon: Icon,
  title,
  description,
  fields,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  fields: RuleField[];
}) {
  return (
    <section className="overflow-hidden rounded-md border bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Badge variant="neutral" className="shrink-0">
          수정 불가
        </Badge>
      </div>

      <div className="grid divide-y">
        {fields.map((field) => (
          <div
            key={field.label}
            className="grid gap-2 px-4 py-3 xl:grid-cols-[160px_minmax(220px,1fr)_minmax(260px,1fr)] xl:items-center"
          >
            <div className="text-xs font-medium text-muted-foreground">
              {field.label}
            </div>
            <Input
              readOnly
              value={field.value}
              aria-readonly="true"
              className="cursor-default bg-muted/40 font-medium"
            />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-foreground">
                {field.source}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {field.note}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReadOnlyStep({
  index,
  title,
  text,
  tone = "neutral",
}: {
  index: number;
  title: string;
  text: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <div className="flex gap-3 rounded-md border bg-background px-3 py-3">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
          tone === "success"
            ? "bg-emerald-100 text-emerald-700"
            : tone === "warning"
              ? "bg-amber-100 text-amber-700"
              : "bg-secondary text-primary"
        )}
      >
        {index}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{text}</div>
      </div>
    </div>
  );
}

function CheckboxLine({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 rounded border-input"
      />
      <span>{label}</span>
    </label>
  );
}

function FilterOrderEditor({
  value,
  tiers,
  onChange,
  onTiersChange,
}: {
  value: OrderMatchingCandidateSortMode;
  onChange: (value: OrderMatchingCandidateSortMode) => void;
  tiers: OrderMatchingPriorityTierDto[];
  onTiersChange: (tiers: OrderMatchingPriorityTierDto[]) => void;
}) {
  const order = filterOrderForSortMode(value);
  const stockAgeDirection = stockAgeDirectionForSortMode(value);
  const [draggedItem, setDraggedItem] =
    React.useState<MatchingFilterBasis | null>(null);

  function moveItem(targetItem: MatchingFilterBasis) {
    if (!draggedItem || draggedItem === targetItem) {
      setDraggedItem(null);
      return;
    }

    const nextOrder = order.filter((item) => item !== draggedItem);
    const targetIndex = nextOrder.indexOf(targetItem);

    nextOrder.splice(targetIndex, 0, draggedItem);
    onChange(sortModeForFilterState(nextOrder, stockAgeDirection));
    setDraggedItem(null);
  }

  function updateStockAgeDirection(nextDirection: StockAgeDirection) {
    onChange(sortModeForFilterState(order, nextDirection));
  }

  return (
    <section className="grid gap-3 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">후보 필터 순서</h3>
        <Badge variant="neutral">위에서 아래 순서</Badge>
      </div>
      <div className="grid gap-2">
        {order.map((item, index) => {
          const meta = matchingFilterBasisItems[item];

          return (
            <div
              key={item}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveItem(item)}
              onDragEnd={() => setDraggedItem(null)}
              className={cn(
                "grid min-h-20 gap-3 rounded-md border bg-card px-3 py-3",
                draggedItem === item && "border-primary bg-secondary"
              )}
            >
              <div
                draggable
                role="button"
                tabIndex={0}
                onDragStart={(event) => {
                  setDraggedItem(item);
                  event.dataTransfer.effectAllowed = "move";
                }}
                className="flex cursor-grab items-center gap-3 active:cursor-grabbing"
              >
                <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-semibold text-primary">
                  {index + 1}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{meta.label}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {meta.value}
                  </div>
                </div>
              </div>
              {item === "SALE_GRADE" ? (
                <div className="border-t pt-3">
                  <TierEditor tiers={tiers} onChange={onTiersChange} />
                </div>
              ) : null}
              {item === "STOCK_AGE" ? (
                <div className="border-t pt-3">
                  <label className="grid max-w-sm gap-1.5 text-xs text-muted-foreground">
                    재고 선택 방향
                    <Select
                      value={stockAgeDirection}
                      onValueChange={(nextValue) =>
                        updateStockAgeDirection(nextValue as StockAgeDirection)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RECENT_FIRST">
                          최근 재고부터 선택
                        </SelectItem>
                        <SelectItem value="OLD_FIRST">
                          오래된 재고부터 선택
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SalesOfferPolicyList({
  rows,
  selectedKey,
  onSelect,
}: {
  rows: OrderMatchingSalesOfferPolicyRow[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="min-h-0 overflow-auto border-t">
      {rows.length === 0 ? (
        <div className="grid min-h-40 place-items-center px-4 text-sm text-muted-foreground">
          표시할 판매 오퍼가 없습니다.
        </div>
      ) : (
        <div className="grid divide-y">
          {rows.map((row) => {
            const key = rowKey(row);
            const selected = key === selectedKey;

            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(key)}
                className={cn(
                  "grid gap-1 px-4 py-3 text-left hover:bg-secondary/60",
                  selected && "bg-secondary"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">
                    {row.offerCode}
                  </span>
                  <Badge
                    variant={!row.isActive ? "warning" : row.policy.source === "SAVED" ? "success" : "neutral"}
                  >
                    {!row.isActive
                      ? "중지"
                      : row.policy.source === "SAVED"
                        ? "개별"
                        : "기본"}
                  </Badge>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {row.model} / {row.requiredStorage || "전체 용량"} /{" "}
                  {row.requiredColor || "전체 색상"} / {row.requiredWarrantyLabel || "-"}
                </div>
                <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>채널매핑 {row.mappedVendorItemCount.toLocaleString("ko-KR")}</span>
                  <span>/</span>
                  <span>주문 {row.orderItemCount.toLocaleString("ko-KR")}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TierEditor({
  tiers,
  onChange,
}: {
  tiers: OrderMatchingPriorityTierDto[];
  onChange: (tiers: OrderMatchingPriorityTierDto[]) => void;
}) {
  const selectedGrades = React.useMemo(
    () =>
      new Set(
        tiers
          .filter((tier) => tier.isEnabled)
          .flatMap((tier) => tier.saleGradeValues)
          .filter((grade) =>
            ORDER_MATCHING_SALE_GRADE_VALUES.some((value) => value === grade)
          )
      ),
    [tiers]
  );
  const tierByGrade = React.useMemo(() => {
    const map = new Map<string, OrderMatchingPriorityTierDto>();

    for (const tier of tiers) {
      for (const grade of tier.saleGradeValues) {
        if (!map.has(grade)) {
          map.set(grade, tier);
        }
      }
    }

    return map;
  }, [tiers]);
  const gradeOrder = React.useMemo(() => gradeOrderFromTiers(tiers), [tiers]);
  const [draggedGrade, setDraggedGrade] = React.useState<string | null>(null);

  function applyGradeSelection(nextOrder: string[], nextSelected: Set<string>) {
    const selectedOrder = nextOrder.filter((grade) => nextSelected.has(grade));

    if (selectedOrder.length === 0) {
      return;
    }

    onChange(
      selectedOrder.map((grade, index) => {
        const previous = tierByGrade.get(grade);

        return {
          tierId: previous?.tierId,
          priorityOrder: index + 1,
          saleGradeValues: [grade],
          isEnabled: true,
        };
      })
    );
  }

  function toggleGrade(grade: string) {
    const nextSelected = new Set(selectedGrades);

    if (nextSelected.has(grade)) {
      if (nextSelected.size <= 1) {
        return;
      }

      nextSelected.delete(grade);
    } else {
      nextSelected.add(grade);
    }

    applyGradeSelection(gradeOrder, nextSelected);
  }

  function moveGrade(targetGrade: string) {
    if (!draggedGrade || draggedGrade === targetGrade) {
      setDraggedGrade(null);
      return;
    }

    const nextOrder = gradeOrder.filter((grade) => grade !== draggedGrade);
    const targetIndex = nextOrder.indexOf(targetGrade);

    nextOrder.splice(targetIndex, 0, draggedGrade);
    applyGradeSelection(nextOrder, selectedGrades);
    setDraggedGrade(null);
  }

  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-sm font-semibold">판매등급 후보 우선순위</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          등급 버튼을 선택하면 후보에 포함되고, 드래그하면 선택된 등급의 순서가 바뀝니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {gradeOrder.map((grade, index) => {
          const selected = selectedGrades.has(grade);
          const selectedIndex = gradeOrder
            .filter((item) => selectedGrades.has(item))
            .indexOf(grade);

          return (
            <React.Fragment key={grade}>
              <button
                type="button"
                draggable
                aria-pressed={selected}
                onClick={() => toggleGrade(grade)}
                onDragStart={(event) => {
                  setDraggedGrade(grade);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveGrade(grade)}
                onDragEnd={() => setDraggedGrade(null)}
                className={cn(
                  "grid h-14 min-w-20 cursor-grab place-items-center rounded-md border px-3 text-sm font-semibold transition-colors active:cursor-grabbing",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background text-muted-foreground hover:bg-secondary",
                  draggedGrade === grade && "ring-2 ring-primary"
                )}
              >
                <span>{grade}</span>
                <span className="text-[11px] font-medium">
                  {selected ? `${selectedIndex + 1}순위` : "제외"}
                </span>
              </button>
              {index < gradeOrder.length - 1 ? (
                <span className="text-sm text-muted-foreground">{">"}</span>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function PolicyEditor({
  row,
  draft,
  isSaving,
  onDraftChange,
  onSave,
  onReset,
}: {
  row: OrderMatchingSalesOfferPolicyRow | null;
  draft: PolicyDraft | null;
  isSaving: boolean;
  onDraftChange: (draft: PolicyDraft) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!row || !draft) {
    return (
      <div className="grid min-h-[480px] place-items-center rounded-md border bg-card text-sm text-muted-foreground">
        판매 오퍼를 선택하세요.
      </div>
    );
  }

  function update<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) {
    onDraftChange({ ...draft, [key]: value } as PolicyDraft);
  }

  return (
    <div className="grid gap-4 rounded-md border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">
              {row.offerCode}
            </h2>
            <Badge variant={row.policy.source === "SAVED" ? "success" : "neutral"}>
              {row.policy.source === "SAVED" ? "개별 정책" : "기본 정책"}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {row.model} / {row.requiredStorage || "전체 용량"} /{" "}
            {row.requiredColor || "전체 색상"} / {row.requiredWarrantyLabel || "-"}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={isSaving || row.policy.source !== "SAVED"}
          >
            <Trash2 className="size-4" />
            기본값
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={isSaving}>
            <Save className={cn("size-4", isSaving && "animate-pulse")} />
            저장
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-md border bg-background p-3 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">판매 오퍼</div>
          <div className="mt-1 truncate text-sm font-medium">
            {row.offerCode}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">기종</div>
          <div className="mt-1 truncate text-sm font-medium">
            {row.model || "-"}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">보증그룹</div>
          <div className="mt-1 truncate text-sm font-medium">
            {row.requiredWarrantyLabel || "-"}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">채널 매핑 / 주문</div>
          <div className="mt-1 truncate text-sm font-medium">
            {row.mappedVendorItemCount.toLocaleString("ko-KR")} /{" "}
            {row.orderItemCount.toLocaleString("ko-KR")}건
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          정책 이름
          <Input
            value={draft.policyName ?? ""}
            onChange={(event) => update("policyName", event.target.value || null)}
            placeholder="예: S24 2년보증 A 우선"
          />
        </label>
        <div className="grid gap-2 rounded-md border bg-background px-3 py-2">
          <CheckboxLine
            checked={draft.autoMatchEnabled}
            label="이 판매 오퍼 자동 매칭 사용"
            onChange={(checked) => update("autoMatchEnabled", checked)}
          />
          <CheckboxLine
            checked={draft.gradeFallbackEnabled}
            label="다음 등급까지 자동 탐색"
            onChange={(checked) => update("gradeFallbackEnabled", checked)}
          />
        </div>
      </div>

      <FilterOrderEditor
        value={draft.candidateSortMode}
        onChange={(value) => update("candidateSortMode", value)}
        tiers={draft.tiers}
        onTiersChange={(tiers) =>
          update(
            "tiers",
            tiers.map((tier, index) => ({
              ...tier,
              priorityOrder: index + 1,
            }))
          )
        }
      />

    </div>
  );
}

export function OrderMatchingPolicyView() {
  const { runGuardedAction } = useUnsavedChanges();
  const [rows, setRows] = React.useState<OrderMatchingSalesOfferPolicyRow[]>([]);
  const [query, setQuery] = React.useState("");
  const [selectedKey, setSelectedKey] = React.useState("");
  const [draft, setDraft] = React.useState<PolicyDraft | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<"neutral" | "success" | "danger">("neutral");

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRows = React.useMemo(
    () =>
      normalizedQuery
        ? rows.filter((row) => offerSearchText(row).includes(normalizedQuery))
        : rows,
    [normalizedQuery, rows]
  );
  const selectedRow =
    rows.find((row) => rowKey(row) === selectedKey) ??
    filteredRows[0] ??
    rows[0] ??
    null;
  const policyBaseline = React.useMemo(
    () => (selectedRow ? policyDraft(selectedRow.policy) : null),
    [selectedRow]
  );
  const discardPolicyDraft = React.useCallback(() => {
    setDraft(policyBaseline ? policyDraft(selectedRow!.policy) : null);
    setMessage("");
  }, [policyBaseline, selectedRow]);

  useUnsavedForm({
    id: ORDER_MATCHING_POLICY_FORM_ID,
    label: selectedRow
      ? `${selectedRow.offerCode} 주문 매칭 정책`
      : "주문 매칭 정책",
    enabled: selectedRow !== null && draft !== null,
    isDirty:
      draft !== null &&
      policyBaseline !== null &&
      !unsavedFormSnapshotsEqual(policyBaseline, draft),
    isBusy: isSaving,
    discard: discardPolicyDraft,
  });
  const savedPolicyCount = rows.filter((row) => row.policy.source === "SAVED").length;

  const loadPolicies = React.useCallback(async (preferredKey?: string) => {
    setIsLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/admin/order-matching-policies", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | PoliciesApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.data) {
        throw new Error(payload?.message || "주문 매칭 정책을 불러오지 못했습니다.");
      }

      const nextSelectedRow =
        payload.data.rows.find((row) => rowKey(row) === preferredKey) ??
        payload.data.rows[0] ??
        null;
      setRows(payload.data.rows);
      setSelectedKey(nextSelectedRow ? rowKey(nextSelectedRow) : "");
      setDraft(nextSelectedRow ? policyDraft(nextSelectedRow.policy) : null);
      setMessage(`판매 오퍼 정책 ${payload.data.rows.length.toLocaleString("ko-KR")}건을 불러왔습니다.`);
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("danger");
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => void loadPolicies());
  }, [loadPolicies]);

  async function postPolicy(body: OrderMatchingPolicyMutationRequest) {
    const response = await fetch("/api/admin/order-matching-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | PoliciesApiResponse
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || "주문 매칭 정책 저장에 실패했습니다.");
    }

    return payload;
  }

  async function savePolicy() {
    if (!selectedRow || !draft) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      await postPolicy({
        action: "saveSalesOfferPolicy",
        salesOfferId: selectedRow.salesOfferId,
        expectedPolicyId: selectedRow.policy.policyId,
        expectedVersion: selectedRow.policy.version,
        policyName: draft.policyName,
        autoMatchEnabled: draft.autoMatchEnabled,
        candidateSortMode: draft.candidateSortMode,
        gradeFallbackEnabled: draft.gradeFallbackEnabled,
        tiers: draft.tiers.map((tier, index) => ({
          ...tier,
          priorityOrder: index + 1,
        })),
      });
      setMessage("판매 오퍼 주문 매칭 정책을 저장했습니다.");
      setMessageTone("success");
      await loadPolicies(selectedKey);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("danger");
    } finally {
      setIsSaving(false);
    }
  }

  async function resetPolicy() {
    if (
      !selectedRow ||
      selectedRow.policy.source !== "SAVED" ||
      selectedRow.policy.policyId === null
    ) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      await postPolicy({
        action: "resetSalesOfferPolicy",
        salesOfferId: selectedRow.salesOfferId,
        expectedPolicyId: selectedRow.policy.policyId,
        expectedVersion: selectedRow.policy.version,
      });
      setMessage("판매 오퍼 정책을 기본값으로 되돌렸습니다.");
      setMessageTone("success");
      await loadPolicies(selectedKey);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("danger");
    } finally {
      setIsSaving(false);
    }
  }

  function selectPolicy(nextKey: string) {
    if (selectedRow && rowKey(selectedRow) === nextKey) {
      return;
    }

    const nextRow = rows.find((row) => rowKey(row) === nextKey) ?? null;
    if (!nextRow) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ORDER_MATCHING_POLICY_FORM_ID],
      targetLabel: `${nextRow.offerCode} 주문 매칭 정책 열기`,
      action: () => {
        setSelectedKey(nextKey);
        setDraft(policyDraft(nextRow.policy));
      },
    });
  }

  function requestPolicyReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [ORDER_MATCHING_POLICY_FORM_ID],
      targetLabel: "주문 매칭 정책 새로고침",
      action: () => {
        void loadPolicies(selectedKey);
      },
    });
  }

  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="min-h-0 flex-1 overflow-auto pb-8">
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            {workerFields.map((field) => (
              <div
                key={field.label}
                className="rounded-md border bg-card px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">{field.label}</div>
                  <LockKeyhole className="size-4 text-muted-foreground" />
                </div>
                <div className="mt-2 text-lg font-semibold">{field.value}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {field.note}
                </div>
              </div>
            ))}
          </div>

          <section className="overflow-hidden rounded-md border bg-card">
            <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                  <ListChecks className="size-4" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">판매 오퍼별 우선순위 정책</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    QuickHack 판매상품 조합마다 후보 재고 탐색 순서를 지정합니다.
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="neutral">
                  개별 {savedPolicyCount.toLocaleString("ko-KR")}건
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={requestPolicyReload}
                  disabled={isLoading || isSaving}
                >
                  <RefreshCcw
                    className={cn("size-4", isLoading && "animate-spin")}
                  />
                  새로고침
                </Button>
              </div>
            </div>

            {message ? (
              <div
                className={cn(
                  "mx-4 mt-4 rounded-md border px-3 py-2 text-sm",
                  messageTone === "success" &&
                    "border-emerald-200 bg-emerald-50 text-emerald-800",
                  messageTone === "danger" &&
                    "border-red-200 bg-red-50 text-red-700",
                  messageTone === "neutral" && "bg-background text-muted-foreground"
                )}
              >
                {message}
              </div>
            ) : null}

            <div className="grid min-h-[620px] xl:grid-cols-[420px_minmax(0,1fr)]">
              <div className="flex min-h-0 flex-col border-r">
                <div className="grid gap-3 p-4">
                  <SearchInput
                    value={query}
                    onValueChange={setQuery}
                    placeholder="오퍼 코드, 기종, 용량, 색상 검색"
                  />
                  <div className="grid grid-cols-3 overflow-hidden rounded-md border bg-background text-center">
                    <div className="border-r px-2 py-2">
                      <div className="text-xs text-muted-foreground">전체</div>
                      <div className="font-semibold tabular-nums">{rows.length}</div>
                    </div>
                    <div className="border-r px-2 py-2">
                      <div className="text-xs text-muted-foreground">개별</div>
                      <div className="font-semibold tabular-nums">
                        {savedPolicyCount}
                      </div>
                    </div>
                    <div className="px-2 py-2">
                      <div className="text-xs text-muted-foreground">검색</div>
                      <div className="font-semibold tabular-nums">
                        {filteredRows.length}
                      </div>
                    </div>
                  </div>
                </div>
                <SalesOfferPolicyList
                  rows={filteredRows}
                  selectedKey={selectedRow ? rowKey(selectedRow) : ""}
                  onSelect={selectPolicy}
                />
              </div>

              <div className="min-h-0 overflow-auto p-4">
                {isLoading ? (
                  <div className="grid min-h-[480px] place-items-center rounded-md border bg-background text-sm text-muted-foreground">
                    판매 오퍼 정책을 불러오는 중입니다.
                  </div>
                ) : (
                  <PolicyEditor
                    row={selectedRow}
                    draft={draft}
                    isSaving={isSaving}
                    onDraftChange={setDraft}
                    onSave={() => void savePolicy()}
                    onReset={() => void resetPolicy()}
                  />
                )}
              </div>
            </div>
          </section>

          <FieldGroup
            icon={ClipboardList}
            title="주문 아이템 고정 조건"
            description="자동 매칭 worker가 주문 아이템을 처리 대상으로 삼기 전에 반드시 확인하는 조건입니다."
            fields={orderItemRules}
          />

          <FieldGroup
            icon={PackageCheck}
            title="후보 재고 고정 조건"
            description="실제 PG 재고가 주문에 예약되기 전에 반드시 만족해야 하는 조건입니다."
            fields={inventoryCandidateRules}
          />

          <FieldGroup
            icon={Store}
            title="판매상품 조합 기준"
            description="채널 상품 매핑에서 넘어온 값과 QuickHack 판매상품 조합을 기준으로 후보 재고를 좁힙니다."
            fields={matchingBasisRules}
          />

          <section className="rounded-md border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">자동 매칭 처리 순서</h2>
              </div>
              <Badge variant="success">현재 코드 기준</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <ReadOnlyStep
                index={1}
                title="주문 대상 확인"
                text="취소, 수량, 상품 매핑, 판매상품 조합 조건을 먼저 확인합니다."
              />
              <ReadOnlyStep
                index={2}
                title="후보 재고 조회"
                text="판매가능 재고 중 출고나 활성 매칭이 없는 PG만 가져옵니다."
              />
              <ReadOnlyStep
                index={3}
                title="PG 예약"
                text="선택된 PG의 재고 상태를 예약으로 바꾸고 매칭 이력을 남깁니다."
                tone="success"
              />
              <ReadOnlyStep
                index={4}
                title="주문 상태 갱신"
                text="아이템, 배송 단위, 주문 전체의 매칭 상태를 다시 계산합니다."
              />
            </div>
          </section>

          <section className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                판매 오퍼별 정책은 후보 탐색 우선순위만 조정합니다. 취소 주문 제외,
                판매가능 재고만 사용, 이미 출고/매칭된 PG 제외 같은 안전 조건은
                운영 화면에서 수정할 수 없습니다.
              </p>
            </div>
          </section>

          <section className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <p>
                지금 단계에서는 정책 저장 구조와 UI를 먼저 잡았습니다. 실제 자동
                매칭 worker가 이 판매 오퍼 정책을 읽어 후보 조회에 적용하는 부분은
                다음 단계에서 연결합니다.
              </p>
            </div>
          </section>
        </div>
      </div>
    </WorkspacePageFrame>
  );
}
