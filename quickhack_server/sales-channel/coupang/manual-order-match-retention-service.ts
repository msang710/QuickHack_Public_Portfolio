import { prisma } from "@/quickhack_server/core/prisma";
import {
  MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY,
  MANUAL_ORDER_MATCH_RETENTION_MAX_BATCHES,
  manualOrderMatchRetentionCutoffs,
} from "@/quickhack_server/sales-channel/coupang/manual-order-match-retention-policy.mjs";

type RetentionContext = {
  assertLeaseActive: () => Promise<void>;
  updateProgress: (current: number, total?: number | null) => Promise<void>;
};

type RetentionCategory = "INTENT_EXPIRY" | "RECEIPT" | "INTENT_LEASE";

function emptyDeletedCounts(): Record<"RECEIPT" | "INTENT_LEASE", number> {
  return { RECEIPT: 0, INTENT_LEASE: 0 };
}

async function databaseClockNow() {
  const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS now
  `;
  if (!row?.now) {
    throw new Error("PostgreSQL clock을 확인하지 못했습니다.");
  }
  return row.now;
}

async function expiredActiveIntentIds(referenceDate: Date, take: number) {
  return (
    await prisma.manual_order_match_intent_leases.findMany({
      where: {
        lease_status: "ACTIVE",
        expires_at: { lte: referenceDate },
      },
      orderBy: [{ expires_at: "asc" }, { lease_id: "asc" }],
      take,
      select: { lease_id: true },
    })
  ).map((row) => row.lease_id);
}

async function expireInactiveIntents(ids: string[], referenceDate: Date) {
  if (ids.length === 0) return 0;
  return (
    await prisma.manual_order_match_intent_leases.updateMany({
    where: {
      lease_id: { in: ids },
      lease_status: "ACTIVE",
      expires_at: { lte: referenceDate },
    },
    data: {
      lease_status: "EXPIRED",
      released_at: referenceDate,
    },
    })
  ).count;
}

async function receiptCandidateIds(cutoff: Date, take: number) {
  return (
    await prisma.manual_order_match_selection_receipts.findMany({
      where: {
        OR: [
          { expires_at: { lt: cutoff } },
          { consumed_at: { lt: cutoff } },
        ],
      },
      orderBy: [{ expires_at: "asc" }, { receipt_id: "asc" }],
      take,
      select: { receipt_id: true },
    })
  ).map((row) => row.receipt_id);
}

async function intentCandidateIds(cutoff: Date, take: number) {
  return (
    await prisma.manual_order_match_intent_leases.findMany({
      where: {
        lease_status: { in: ["RELEASED", "EXPIRED"] },
        released_at: { lt: cutoff },
      },
      orderBy: [{ released_at: "asc" }, { lease_id: "asc" }],
      take,
      select: { lease_id: true },
    })
  ).map((row) => row.lease_id);
}

async function candidateIds(
  category: RetentionCategory,
  cutoffs: ReturnType<typeof manualOrderMatchRetentionCutoffs> & {
    reference: Date;
  },
  take: number
) {
  if (category === "INTENT_EXPIRY") {
    return expiredActiveIntentIds(cutoffs.reference, take);
  }
  return category === "RECEIPT"
    ? receiptCandidateIds(cutoffs.receipt, take)
    : intentCandidateIds(cutoffs.intent, take);
}

async function deleteCandidateIds(category: RetentionCategory, ids: string[]) {
  if (ids.length === 0) return 0;
  return category === "RECEIPT"
    ? (
        await prisma.manual_order_match_selection_receipts.deleteMany({
          where: { receipt_id: { in: ids } },
        })
      ).count
    : (
        await prisma.manual_order_match_intent_leases.deleteMany({
          where: {
            lease_id: { in: ids },
            lease_status: { in: ["RELEASED", "EXPIRED"] },
          },
        })
      ).count;
}

export async function runManualOrderMatchRetention(input: {
  context: RetentionContext;
  referenceDate?: Date;
  batchSize?: number;
  maxBatches?: number;
}) {
  const referenceDate = input.referenceDate ?? (await databaseClockNow());
  const cutoffs = {
    ...manualOrderMatchRetentionCutoffs(referenceDate),
    reference: referenceDate,
  };
  const batchSize = Math.max(
    1,
    Math.min(
      MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY.maxBatchSize,
      Math.trunc(
        input.batchSize ??
          MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY.maxBatchSize
      )
    )
  );
  const maxBatches = Math.max(
    1,
    Math.trunc(
      input.maxBatches ?? MANUAL_ORDER_MATCH_RETENTION_MAX_BATCHES
    )
  );
  const categories: RetentionCategory[] = [
    "INTENT_EXPIRY",
    "RECEIPT",
    "INTENT_LEASE",
  ];
  const exhausted = new Set<RetentionCategory>();
  const deletedByCategory = emptyDeletedCounts();
  let deletedCount = 0;
  let expiredIntentCount = 0;
  let batchCount = 0;

  while (batchCount < maxBatches && exhausted.size < categories.length) {
    for (const category of categories) {
      if (batchCount >= maxBatches || exhausted.has(category)) continue;
      await input.context.assertLeaseActive();
      const ids = await candidateIds(category, cutoffs, batchSize);
      if (ids.length === 0) {
        exhausted.add(category);
        continue;
      }
      const changed =
        category === "INTENT_EXPIRY"
          ? await expireInactiveIntents(ids, referenceDate)
          : await deleteCandidateIds(category, ids);
      if (category === "INTENT_EXPIRY") {
        expiredIntentCount += changed;
      } else {
        deletedByCategory[category] += changed;
        deletedCount += changed;
      }
      batchCount += 1;
      await input.context.updateProgress(
        deletedCount + expiredIntentCount,
        batchSize * maxBatches
      );
      if (ids.length < batchSize) exhausted.add(category);
    }
  }

  const backlogCategories: RetentionCategory[] = [];
  for (const category of categories) {
    if ((await candidateIds(category, cutoffs, 1)).length > 0) {
      backlogCategories.push(category);
    }
  }
  const backlog = backlogCategories.length > 0;
  const summaryText = backlog
    ? `수동 매칭 lease ${expiredIntentCount}건 만료, 임시 데이터 ${deletedCount}건 정리, 잔여 분류 ${backlogCategories.length}개`
    : `수동 매칭 lease ${expiredIntentCount}건 만료, 임시 데이터 ${deletedCount}건 정리, 잔여 backlog 없음`;

  return {
    summaryText,
    processedCount: deletedCount,
    deletedCount,
    expiredIntentCount,
    batchCount,
    warningCount: backlogCategories.length,
    backlog,
    backlogCategories,
    deletedByCategory,
    cutoffs,
  };
}
