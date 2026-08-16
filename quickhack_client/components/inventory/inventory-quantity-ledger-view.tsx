"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import {
  InventoryQuantityDetailSheet,
  type InventoryQuantityDetailSelection,
} from "@/quickhack_client/components/inventory/inventory-quantity-detail-sheet";
import {
  InboundReconciliationDetailSheet,
  type InboundReconciliationDetailSelection,
} from "@/quickhack_client/components/inventory/inbound-reconciliation-detail-sheet";
import { InventoryQuantityMatrixTable } from "@/quickhack_client/components/inventory/inventory-quantity-matrix-table";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  INVENTORY_QUANTITY_MATRIX_PRESETS,
  buildInventoryQuantityModelGroups,
  filterInventoryQuantityModelGroups,
  type InventoryQuantityMatrixPreset,
} from "@/quickhack_shared/inventory/inventory-quantity-matrix-view";
import type {
  InventoryLedgerAvailability,
  InventoryQuantityMatrixPayload,
} from "@/quickhack_shared/inventory/inventory-quantity";
import { cn } from "@/quickhack_shared/core/utils";

type MatrixApiResponse = {
  ok: boolean;
  message?: string;
  data?: InventoryQuantityMatrixPayload;
};

const PRESET_ORDER: readonly InventoryQuantityMatrixPreset[] = [
  "SUMMARY",
  "OUTBOUND",
  "EXCEPTIONS",
  "ALL",
];

function quantityText(value: number | null) {
  return value === null ? "–" : value.toLocaleString("ko-KR");
}

function SummaryCard({
  label,
  value,
  description,
}: {
  label: string;
  value: number | null;
  description: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-popover px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">
        {quantityText(value)}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {description}
      </div>
    </div>
  );
}

function AvailabilityBanner({
  availability,
}: {
  availability: InventoryLedgerAvailability;
}) {
  if (availability === "READY") {
    return null;
  }

  if (availability === "EMPTY") {
    return (
      <FeedbackBanner tone="info">
        등록된 재고가 없습니다. 재고가 생성되면 기종별 수불 현황이 이
        화면에 표시됩니다.
      </FeedbackBanner>
    );
  }

  return (
    <FeedbackBanner tone="danger">
      재고 원장과 실제 재고 사이에 일부 불일치가 발견되었습니다. 원장
      기반 수량은 확정 전까지 –로 표시하며, 매입 전 수량과 입고 대조
      지표는 계속 제공합니다.
    </FeedbackBanner>
  );
}

function ReconciliationMetricButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${label} ${quantityText(value)} 상세 보기`}
      onClick={onClick}
    >
      <span>{label}</span>
      <strong className="tabular-nums">{quantityText(value)}</strong>
    </button>
  );
}

export function InventoryQuantityLedgerView({
  onOpenInventoryEdit,
}: {
  onOpenInventoryEdit: (pgNo: string) => void;
}) {
  const [data, setData] =
    React.useState<InventoryQuantityMatrixPayload | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [preset, setPreset] =
    React.useState<InventoryQuantityMatrixPreset>("SUMMARY");
  const [search, setSearch] = React.useState("");
  const [expandedGroupKeys, setExpandedGroupKeys] = React.useState<
    Set<string>
  >(() => new Set());
  const [selection, setSelection] =
    React.useState<InventoryQuantityDetailSelection | null>(null);
  const [reconciliationSelection, setReconciliationSelection] =
    React.useState<InboundReconciliationDetailSelection | null>(null);
  const requestSequenceRef = React.useRef(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        "/api/inventory/quantity-ledger?format=matrix",
        {
          cache: "no-store",
          signal: controller.signal,
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | MatrixApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.data) {
        throw new Error(
          payload?.message || "재고 수불 현황을 불러오지 못했습니다."
        );
      }

      if (requestSequenceRef.current !== requestSequence) {
        return;
      }

      setData(payload.data);
    } catch (caught) {
      if (
        controller.signal.aborted ||
        requestSequenceRef.current !== requestSequence
      ) {
        return;
      }

      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => void load());

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [load]);

  const groups = React.useMemo(
    () => buildInventoryQuantityModelGroups(data?.rows ?? []),
    [data?.rows]
  );
  const filtered = React.useMemo(
    () => filterInventoryQuantityModelGroups(groups, search),
    [groups, search]
  );
  const autoExpandedGroupKeys = React.useMemo(
    () => new Set(filtered.autoExpandedGroupKeys),
    [filtered.autoExpandedGroupKeys]
  );
  const presetDefinition = INVENTORY_QUANTITY_MATRIX_PRESETS[preset];

  const toggleGroup = React.useCallback((groupKey: string) => {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);

      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }

      return next;
    });
  }, []);

  return (
    <WorkspacePageFrame className="gap-3 px-5 py-4">
      <div className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-4">
        <SummaryCard
          label="판매가능"
          value={data?.summary.sellableQuantity ?? null}
          description="즉시 판매 가능한 재고"
        />
        <SummaryCard
          label="오늘 주문 전체 수량"
          value={data?.summary.todayOrderQuantity ?? null}
          description="주문확인 + 포장중 + 포장완료 + 배송지시"
        />
        <SummaryCard
          label="매입 전"
          value={data?.summary.prePurchaseQuantity ?? null}
          description="검수 중 + 검수 완료"
        />
        <SummaryCard
          label="총합계"
          value={data?.summary.primaryTotalQuantity ?? null}
          description="판매가능 + 오늘 주문 + 매입 전"
        />
      </div>

      {data ? (
        <AvailabilityBanner availability={data.availability} />
      ) : null}

      {error ? (
        <FeedbackBanner tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {error}
              {data
                ? " 이전에 불러온 현황은 그대로 유지합니다."
                : ""}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              다시 시도
            </Button>
          </div>
        </FeedbackBanner>
      ) : null}

      {data ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-muted/25 px-3 py-2 text-xs">
          <span className="font-semibold">
            입고 대조 · {data.reconciliation.businessDate}
          </span>
          <ReconciliationMetricButton
            label="미지정 PG"
            value={data.reconciliation.unassignedPgQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "UNASSIGNED",
              })
            }
          />
          <ReconciliationMetricButton
            label="불일치 차수"
            value={data.reconciliation.mismatchedBatchQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "MISMATCHED",
              })
            }
          />
          <ReconciliationMetricButton
            label="부족"
            value={data.reconciliation.shortageQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "SHORTAGE",
              })
            }
          />
          <ReconciliationMetricButton
            label="초과"
            value={data.reconciliation.excessQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "EXCESS",
              })
            }
          />
          <span className="text-muted-foreground">
            숫자를 누르면 현재 상세를 다시 조회합니다.
          </span>
        </div>
      ) : null}

      <div className="flex shrink-0 flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div
          className="inline-flex w-fit rounded-md border bg-muted/35 p-1"
          aria-label="재고 수불 현황 열 구성"
        >
          {PRESET_ORDER.map((presetKey) => {
            const definition =
              INVENTORY_QUANTITY_MATRIX_PRESETS[presetKey];

            return (
              <button
                key={presetKey}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  preset === presetKey
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={preset === presetKey}
                title={definition.description}
                onClick={() => setPreset(presetKey)}
              >
                {definition.label}
              </button>
            );
          })}
        </div>
        <div className="flex w-full gap-2 xl:w-auto">
          <SearchInput
            value={search}
            onValueChange={setSearch}
            label="재고 수불 현황 검색"
            placeholder="기종, SKU, 용량, 색상, 등급, 매입 전 PG 검색"
            wrapperClassName="min-w-0 flex-1 xl:w-[410px]"
          />
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            새로고침
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
          <span>
            기종 {filtered.groups.length.toLocaleString("ko-KR")}개 · 구성{" "}
            {filtered.groups
              .reduce((sum, group) => sum + group.rows.length, 0)
              .toLocaleString("ko-KR")}개
          </span>
          <span>{presetDefinition.description}</span>
        </div>
        <InventoryQuantityMatrixTable
          groups={filtered.groups}
          columns={presetDefinition.columns}
          presetLabel={presetDefinition.label}
          expandedGroupKeys={expandedGroupKeys}
          autoExpandedGroupKeys={autoExpandedGroupKeys}
          onToggleGroup={toggleGroup}
          onSelect={setSelection}
          emptyMessage={
            loading && !data
              ? "재고 수불 현황을 불러오는 중입니다."
              : search.trim()
                ? "검색 조건에 맞는 재고 구성이 없습니다."
                : "표시할 재고 구성이 없습니다."
          }
        />
      </div>

      <InventoryQuantityDetailSheet
        selection={selection}
        onOpenChange={(open) => {
          if (!open) {
            setSelection(null);
          }
        }}
      />
      <InboundReconciliationDetailSheet
        selection={reconciliationSelection}
        onOpenChange={(open) => {
          if (!open) {
            setReconciliationSelection(null);
          }
        }}
        onOpenInventoryEdit={onOpenInventoryEdit}
      />
    </WorkspacePageFrame>
  );
}
