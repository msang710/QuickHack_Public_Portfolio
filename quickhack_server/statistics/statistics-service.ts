// QuickHack note: 대시보드 통계 화면에서 사용할 서버 측 집계 로직입니다.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { DashboardStatisticsData } from "@/quickhack_shared/statistics/statistics";
import { formatKstSqlDateTime } from "@/quickhack_shared/core/time";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { loadInboundReconciliationSnapshot } from "@/quickhack_server/inbound/inbound-reconciliation-service";
import { loadInboundInspectionEvidence } from "@/quickhack_server/inbound/inbound-inspection-evidence-loader";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { parseKstSqlDateTime } from "@/quickhack_shared/core/time";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";

type DashboardDeviceProgress = {
  pgNo: string;
  hasAppearanceToday: boolean;
  hasFunctionToday: boolean;
};

function todayKstDate() {
  return formatKstSqlDateTime().slice(0, 10);
}

function percent(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Math.round((count / total) * 1000) / 10;
}

async function loadDashboardStatisticsData(
  client: Prisma.TransactionClient,
  options: {
    businessDate?: string;
  } = {}
): Promise<DashboardStatisticsData> {
  const today = options.businessDate ?? todayKstDate();
  const dayStart = `${today} 00:00:00`;
  const dayEnd = `${today} 23:59:59`;
  const dayStartDate = parseKstSqlDateTime(dayStart)!;
  const dayEndDate = parseKstSqlDateTime(dayEnd)!;
  const reconciliation = await loadInboundReconciliationSnapshot(client, {
    batchDate: today,
    businessDate: today,
  });
  const currentDevices = reconciliation.batches.flatMap((batch) => batch.devices);
  const inspectionEvidenceByInboundId = await loadInboundInspectionEvidence(
    client,
    currentDevices.map((device) => ({
      pgNo: device.pgNo,
      inboundId: device.inboundId,
    }))
  );
  const progressByPgNo = new Map<string, DashboardDeviceProgress>();

  for (const device of currentDevices) {
    const current = progressByPgNo.get(device.pgNo) ?? {
      pgNo: device.pgNo,
      hasAppearanceToday: false,
      hasFunctionToday: false,
    };

    for (const inspection of inspectionEvidenceByInboundId.get(device.inboundId) ?? []) {
      current.hasAppearanceToday =
        current.hasAppearanceToday ||
        Boolean(
          inspection.inspection_type === INSPECTION_TYPE.appearance &&
            inspection.appearance_checked_at &&
            inspection.appearance_checked_at.getTime() >= dayStartDate.getTime() &&
            inspection.appearance_checked_at.getTime() <= dayEndDate.getTime()
        );
      current.hasFunctionToday =
        current.hasFunctionToday ||
        Boolean(
          inspection.inspection_type === INSPECTION_TYPE.function &&
            inspection.function_checked_at &&
            inspection.function_checked_at.getTime() >= dayStartDate.getTime() &&
            inspection.function_checked_at.getTime() <= dayEndDate.getTime()
        );
    }

    if (current.hasAppearanceToday || current.hasFunctionToday) {
      progressByPgNo.set(device.pgNo, current);
    }
  }

  const batchProgress = reconciliation.batches.map((batch) => {
    const rows = batch.devices
      .map((device) => progressByPgNo.get(device.pgNo))
      .filter((row): row is DashboardDeviceProgress => Boolean(row));
    const denominator = Math.max(batch.expectedQuantity, 1);
    const appearanceCompletedCount = rows.filter(
      (row) => row.hasAppearanceToday
    ).length;
    const functionCompletedCount = rows.filter(
      (row) => row.hasFunctionToday
    ).length;
    const purchasePendingCount =
      batch.statusCounts[INBOUND_STATUS.inspected] ?? 0;

    return {
      inboundBatchId: batch.inboundBatchId,
      batchDate: batch.batchDate,
      batchNo: batch.batchNo,
      expectedQuantity: batch.expectedQuantity,
      linkedQuantity: batch.linkedQuantity,
      inspectedToday: rows.length,
      normalInboundTargetQuantity: batch.normalInboundTargetQuantity,
      supplierReturnQuantity: batch.supplierReturnQuantity,
      arrivalDifference: batch.arrivalDifference,
      shortageQuantity: batch.shortageQuantity,
      excessQuantity: batch.excessQuantity,
      appearanceCompletedCount,
      functionCompletedCount,
      purchasePendingCount,
      appearancePercent: percent(appearanceCompletedCount, denominator),
      functionPercent: percent(functionCompletedCount, denominator),
      purchasePendingPercent: percent(purchasePendingCount, denominator),
    };
  });

  return {
    generatedAt: formatKstSqlDateTime(),
    today,
    summary: {
      batchCount: batchProgress.length,
      expectedQuantity: batchProgress.reduce(
        (sum, batch) => sum + batch.expectedQuantity,
        0
      ),
      linkedQuantity: batchProgress.reduce(
        (sum, batch) => sum + batch.linkedQuantity,
        0
      ),
      inspectedToday: batchProgress.reduce(
        (sum, batch) => sum + batch.inspectedToday,
        0
      ),
      normalInboundTargetQuantity: batchProgress.reduce(
        (sum, batch) => sum + batch.normalInboundTargetQuantity,
        0
      ),
      supplierReturnQuantity: batchProgress.reduce(
        (sum, batch) => sum + batch.supplierReturnQuantity,
        0
      ),
      arrivalDifference: batchProgress.reduce(
        (sum, batch) => sum + batch.arrivalDifference,
        0
      ),
      shortageQuantity: batchProgress.reduce(
        (sum, batch) => sum + batch.shortageQuantity,
        0
      ),
      excessQuantity: batchProgress.reduce(
        (sum, batch) => sum + batch.excessQuantity,
        0
      ),
    },
    batches: batchProgress,
  };
}

export function getDashboardStatisticsData(
  owner: PrismaClient,
  options: {
    businessDate?: string;
  } = {}
): Promise<DashboardStatisticsData> {
  return runConsistentReadSnapshot(
    owner,
    "statistics.dashboard",
    (tx) => loadDashboardStatisticsData(tx, options)
  );
}
