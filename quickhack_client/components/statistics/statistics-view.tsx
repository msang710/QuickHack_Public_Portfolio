// QuickHack note: 통계별 서버 aggregate 패널과 공통 기간 영역을 연결하는 화면입니다.
"use client";
import { InventoryStatisticsPanel } from "@/quickhack_client/components/statistics/inventory-statistics-panel";
import { PurchaseStatisticsPanel } from "@/quickhack_client/components/statistics/purchase-statistics-panel";
import { ReturnsStatisticsPanel } from "@/quickhack_client/components/statistics/returns-statistics-panel";
import { SalesStatisticsPanel } from "@/quickhack_client/components/statistics/sales-statistics-panel";
import { StatisticsPeriodToolbar } from "@/quickhack_client/components/statistics/statistics-period-toolbar";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  statisticsPeriodSelectionKey,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

export type StatisticsMode = "purchase" | "inventory" | "sales" | "returns";

export function StatisticsView({
  mode,
  periodSelection,
  onPeriodSelectionChange,
}: {
  mode: StatisticsMode;
  periodSelection: StatisticsPeriodSelection;
  onPeriodSelectionChange: (
    selection: StatisticsPeriodSelection
  ) => void;
}) {
  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="mb-4 shrink-0">
        <StatisticsPeriodToolbar
          key={statisticsPeriodSelectionKey(periodSelection)}
          selection={periodSelection}
          onSelectionChange={onPeriodSelectionChange}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-8">
        {mode === "purchase" ? (
          <PurchaseStatisticsPanel
            periodSelection={periodSelection}
          />
        ) : null}

        {mode === "inventory" ? (
          <InventoryStatisticsPanel
            periodSelection={periodSelection}
          />
        ) : null}

        {mode === "sales" ? (
          <SalesStatisticsPanel
            periodSelection={periodSelection}
          />
        ) : null}

        {mode === "returns" ? (
          <ReturnsStatisticsPanel
            periodSelection={periodSelection}
          />
        ) : null}
      </div>
    </WorkspacePageFrame>
  );
}
