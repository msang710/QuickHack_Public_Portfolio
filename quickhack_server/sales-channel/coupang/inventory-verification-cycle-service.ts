import { prisma } from "@/quickhack_server/core/prisma";
import {
  failQueuedCoupangInventoryVerificationBatch,
  processCoupangInventoryVerificationBatch,
  queueCoupangInventoryVerificationBatch,
  type InventoryVerificationDependencies,
  type InventoryVerificationRefreshResult,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import { assertWorkerLeaseActive } from "@/quickhack_server/workers/lease-guard";
import type { OwnedWorkerLeaseGuard } from "@/quickhack_server/workers/types";

const COUPANG_CHANNEL = "COUPANG";

export type CoupangMatchingCycleInventoryVerification = Awaited<
  ReturnType<typeof prepareCoupangMatchingCycleInventoryVerification>
>;

function positiveIds(values: Array<number | null | undefined>) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is number =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0
      )
    )
  );
}

function nonEmptyTexts(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0)
    )
  );
}

function outcomeCount(
  results: InventoryVerificationRefreshResult[],
  outcome: InventoryVerificationRefreshResult["outcome"]
) {
  return results.filter((result) => result.outcome === outcome).length;
}

function requireInventoryVerificationExecutionToken(
  workerLease: OwnedWorkerLeaseGuard
) {
  const executionToken = String(workerLease.leaseToken ?? "").trim();

  if (!executionToken) {
    throw Object.assign(
      new Error("Inventory verification requires an owned worker lease token."),
      { code: "WORKER_LEASE_TOKEN_REQUIRED" }
    );
  }

  return executionToken;
}

export async function prepareCoupangMatchingCycleInventoryVerification(input: {
  salesOfferIds: Array<number | null | undefined>;
  externalVendorItemIds?: Array<string | null | undefined>;
  workerLease: OwnedWorkerLeaseGuard;
  dependencies?: InventoryVerificationDependencies;
}) {
  await assertWorkerLeaseActive(input.workerLease);
  const executionToken = requireInventoryVerificationExecutionToken(
    input.workerLease
  );
  const salesOfferIds = positiveIds(input.salesOfferIds);
  const externalVendorItemIds = nonEmptyTexts(
    input.externalVendorItemIds ?? []
  );
  const mappings =
    salesOfferIds.length === 0 && externalVendorItemIds.length === 0
      ? []
      : await prisma.sales_channel_product_mappings.findMany({
          where: {
            channel: COUPANG_CHANNEL,
            mapping_status: "MAPPED",
            OR: [
              ...(salesOfferIds.length > 0
                ? [{ sales_offer_id: { in: salesOfferIds } }]
                : []),
              ...(externalVendorItemIds.length > 0
                ? [
                    {
                      external_vendor_item_id: {
                        in: externalVendorItemIds,
                      },
                    },
                  ]
                : []),
            ],
          },
          orderBy: { mapping_id: "asc" },
          select: { mapping_id: true },
        });
  const mappingIds = positiveIds(mappings.map((mapping) => mapping.mapping_id));
  let queued: Awaited<
    ReturnType<typeof queueCoupangInventoryVerificationBatch>
  >;

  try {
    queued = await queueCoupangInventoryVerificationBatch({
      mappingIds,
      executionToken,
      workerJobId: input.workerLease.workerJobId,
      dependencies: input.dependencies,
    });
    await assertWorkerLeaseActive(input.workerLease);
  } catch (error) {
    await failQueuedCoupangInventoryVerificationBatch({
      mappingIds,
      workerJobId: input.workerLease.workerJobId,
      executionToken,
      error,
    }).catch(() => undefined);

    throw error;
  }

  return {
    affectedSalesOfferCount: salesOfferIds.length,
    affectedVendorItemCount: externalVendorItemIds.length,
    candidateMappingCount: mappingIds.length,
    queuedCount: queued.queuedCount,
    skippedCount: queued.skippedCount,
    projectionFailedCount: queued.failedCount,
    alreadyClaimedCount: queued.alreadyClaimedCount,
    executionToken,
    mappingIds: queued.mappingIds,
  };
}

export async function runCoupangMatchingCycleInventoryVerification(input: {
  cycle: CoupangMatchingCycleInventoryVerification;
  workerLease: OwnedWorkerLeaseGuard;
  dependencies?: InventoryVerificationDependencies;
}) {
  const batch = await processCoupangInventoryVerificationBatch({
    mappingIds: input.cycle.mappingIds,
    workerJobId: input.workerLease.workerJobId,
    executionToken: input.cycle.executionToken,
    signal: input.workerLease.signal,
    dependencies: input.dependencies,
  });

  return {
    affectedSalesOfferCount: input.cycle.affectedSalesOfferCount,
    affectedVendorItemCount: input.cycle.affectedVendorItemCount,
    candidateMappingCount: input.cycle.candidateMappingCount,
    queuedCount: input.cycle.queuedCount,
    requestedCount: batch.requestedCount,
    matchedCount: outcomeCount(batch.results, "MATCHED"),
    mismatchCount: outcomeCount(batch.results, "MISMATCH"),
    checkFailedCount:
      input.cycle.projectionFailedCount +
      outcomeCount(batch.results, "CHECK_FAILED"),
    skippedCount:
      input.cycle.skippedCount + outcomeCount(batch.results, "SKIPPED"),
    alreadyClaimedCount:
      input.cycle.alreadyClaimedCount +
      outcomeCount(batch.results, "ALREADY_CLAIMED"),
    claimLostCount: outcomeCount(batch.results, "CLAIM_LOST"),
    results: batch.results,
  };
}

export async function failCoupangMatchingCycleInventoryVerification(input: {
  cycle: CoupangMatchingCycleInventoryVerification;
  workerLease: OwnedWorkerLeaseGuard;
  error: unknown;
}) {
  return failQueuedCoupangInventoryVerificationBatch({
    mappingIds: input.cycle.mappingIds,
    workerJobId: input.workerLease.workerJobId,
    executionToken: input.cycle.executionToken,
    error: input.error,
  });
}
