import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  createStatisticsSnapshotFixture,
  statisticsSnapshotFixtureMarker,
} from "../../support/statistics-snapshot-fixtures.ts";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-statistics-snapshot-dispatcher-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const domains = ["PURCHASE", "INVENTORY", "SALES", "RETURNS"];
let prisma;

async function createCompleteBatch(store, input) {
  const contract = {
    dataCutoffDate: input.dataCutoffDate,
    periodFrom: input.periodFrom,
    periodTo: input.dataCutoffDate,
    dayCount: 90,
    calculationVersion:
      input.calculationVersion ?? "statistics-daily-v3",
  };
  const batch = await store.createStatisticsSnapshotBatch(
    prisma,
    contract
  );
  const items = new Map();

  for (const [index, domain] of domains.entries()) {
    const item = await store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: batch.snapshot_batch_id,
      domain,
      data: createStatisticsSnapshotFixture(
        domain,
        contract,
        input.marker + index
      ),
    });
    items.set(domain, item);
  }

  if (input.malformedDomain) {
    const item = items.get(input.malformedDomain);
    const envelope = JSON.parse(item.payload_text);
    envelope.data = createStatisticsSnapshotFixture(
      "PURCHASE",
      contract,
      input.marker + 99
    );
    envelope.data.calculation.mode = "SNAPSHOT";
    const payloadText = JSON.stringify(envelope);
    await prisma.statistics_snapshot_items.update({
      where: {
        snapshot_item_id: item.snapshot_item_id,
      },
      data: {
        payload_text: payloadText,
        payload_hash: createHash("sha256")
          .update(payloadText, "utf8")
          .digest("hex"),
        payload_size_bytes: Buffer.byteLength(payloadText, "utf8"),
        generated_at: envelope.data.generatedAt,
      },
    });
  }

  if (input.tamperDomain) {
    const item = items.get(input.tamperDomain);
    await prisma.statistics_snapshot_items.update({
      where: {
        snapshot_item_id: item.snapshot_item_id,
      },
      data: {
        payload_hash: "0".repeat(64),
      },
    });
  }

  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: batch.snapshot_batch_id,
  });

  return batch;
}

function liveCalculator(data, calls) {
  return async () => {
    calls.count += 1;
    return data;
  };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const dispatcher = await import(
    "@/quickhack_server/statistics/statistics-read-dispatcher"
  );
  const store = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );
  const { resolveClosedStatisticsPeriod } = await import(
    "@/quickhack_shared/statistics/statistics-period"
  );

  const currentPeriod = resolveClosedStatisticsPeriod({
    now: new Date("2026-07-30T01:00:00.000Z"),
  });
  const currentContract = {
    dataCutoffDate: "2026-07-29",
    periodFrom: "2026-05-01",
    periodTo: "2026-07-29",
    dayCount: 90,
    calculationVersion: "statistics-daily-v3",
  };
  const liveData = createStatisticsSnapshotFixture(
    "SALES",
    currentContract,
    900
  );

  const missingCalls = { count: 0 };
  const missing = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "SALES",
    period: currentPeriod,
    calculateLive: liveCalculator(liveData, missingCalls),
  });
  assert.equal(missing.delivery.status, "LIVE_FALLBACK");
  assert.equal(missing.delivery.fallbackReason, "NOT_FOUND");
  assert.equal(missing.data.calculation.mode, "LIVE");
  assert.equal(missingCalls.count, 1);

  const customPeriod = resolveClosedStatisticsPeriod({
    now: new Date("2026-07-30T01:00:00.000Z"),
    fromDate: "2026-07-01",
    toDate: "2026-07-15",
  });
  const customCalls = { count: 0 };
  const custom = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "SALES",
    period: customPeriod,
    calculateLive: liveCalculator(liveData, customCalls),
  });
  assert.equal(custom.delivery.status, "LIVE_CUSTOM_PERIOD");
  assert.equal(customCalls.count, 1);

  const currentBatch = await createCompleteBatch(store, {
    dataCutoffDate: "2026-07-29",
    periodFrom: "2026-05-01",
    marker: 10,
  });
  const snapshotCalls = { count: 0 };
  const snapshotStartedAt = performance.now();
  const current = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "SALES",
    period: currentPeriod,
    calculateLive: liveCalculator(liveData, snapshotCalls),
  });
  const snapshotReadDurationMs = performance.now() - snapshotStartedAt;
  assert.equal(current.delivery.status, "SNAPSHOT_CURRENT");
  assert.equal(current.delivery.snapshotCutoffLagDays, 0);
  assert.equal(current.snapshotBatchId, currentBatch.snapshot_batch_id);
  assert.equal(current.data.calculation.mode, "SNAPSHOT");
  assert.equal(
    statisticsSnapshotFixtureMarker("SALES", current.data),
    12
  );
  assert.equal(snapshotCalls.count, 0);

  const purchaseCalls = { count: 0 };
  const purchase = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "PURCHASE",
    period: currentPeriod,
    calculateLive: liveCalculator(liveData, purchaseCalls),
  });
  assert.equal(
    statisticsSnapshotFixtureMarker("PURCHASE", purchase.data),
    10
  );
  assert.equal(purchaseCalls.count, 0);

  const racingBatch = await store.createStatisticsSnapshotBatch(prisma, {
    dataCutoffDate: "2026-07-29",
    periodFrom: "2026-05-01",
    periodTo: "2026-07-29",
    dayCount: 90,
    calculationVersion: "statistics-daily-v3",
  });
  for (const [index, domain] of domains.entries()) {
    await store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: racingBatch.snapshot_batch_id,
      domain,
      data: createStatisticsSnapshotFixture(
        domain,
        currentContract,
        20 + index
      ),
    });
  }

  let replacementCompleted = false;
  const racingClient = new Proxy(prisma, {
    get(target, property) {
      if (property !== "statistics_snapshot_batches") {
        return Reflect.get(target, property, target);
      }

      return new Proxy(target.statistics_snapshot_batches, {
        get(delegate, method) {
          if (method !== "findFirst") {
            return Reflect.get(delegate, method, delegate);
          }

          return async (args) => {
            const selected = await target.statistics_snapshot_batches.findFirst(
              args
            );
            if (!replacementCompleted) {
              replacementCompleted = true;
              await store.completeStatisticsSnapshotBatch(target, {
                snapshotBatchId: racingBatch.snapshot_batch_id,
              });
            }
            return selected;
          };
        },
      });
    },
  });
  const racingCalls = { count: 0 };
  const racingRead = await dispatcher.dispatchStatisticsRead(racingClient, {
    domain: "SALES",
    period: currentPeriod,
    calculateLive: liveCalculator(liveData, racingCalls),
  });
  const [supersededSelectedBatch, promotedReplacementBatch] =
    await Promise.all([
      prisma.statistics_snapshot_batches.findUniqueOrThrow({
        where: {
          snapshot_batch_id: currentBatch.snapshot_batch_id,
        },
      }),
      prisma.statistics_snapshot_batches.findUniqueOrThrow({
        where: {
          snapshot_batch_id: racingBatch.snapshot_batch_id,
        },
      }),
    ]);
  assert.equal(replacementCompleted, true);
  assert.equal(supersededSelectedBatch.status, "SUPERSEDED");
  assert.equal(promotedReplacementBatch.status, "COMPLETE");
  assert.equal(racingRead.delivery.status, "SNAPSHOT_CURRENT");
  assert.equal(racingRead.snapshotBatchId, currentBatch.snapshot_batch_id);
  assert.equal(
    statisticsSnapshotFixtureMarker("SALES", racingRead.data),
    12
  );
  assert.equal(racingCalls.count, 0);

  const nextPeriod = resolveClosedStatisticsPeriod({
    now: new Date("2026-07-31T01:00:00.000Z"),
  });
  await createCompleteBatch(store, {
    dataCutoffDate: "2026-07-30",
    periodFrom: "2026-05-02",
    calculationVersion: "statistics-daily-v2",
    marker: 30,
  });
  const delayedCalls = { count: 0 };
  const delayed = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "RETURNS",
    period: nextPeriod,
    calculateLive: liveCalculator(liveData, delayedCalls),
  });
  assert.equal(delayed.delivery.status, "SNAPSHOT_DELAYED");
  assert.equal(delayed.delivery.snapshotCutoffDate, "2026-07-29");
  assert.equal(delayed.delivery.snapshotCutoffLagDays, 1);
  assert.equal(
    statisticsSnapshotFixtureMarker("RETURNS", delayed.data),
    23
  );
  assert.equal(delayedCalls.count, 0);

  const twoDaysLaterPeriod = resolveClosedStatisticsPeriod({
    now: new Date("2026-08-01T01:00:00.000Z"),
  });
  const tooOldCalls = { count: 0 };
  const tooOld = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "INVENTORY",
    period: twoDaysLaterPeriod,
    calculateLive: liveCalculator(liveData, tooOldCalls),
  });
  assert.equal(tooOld.delivery.status, "LIVE_FALLBACK");
  assert.equal(tooOld.delivery.fallbackReason, "TOO_OLD");
  assert.equal(tooOld.snapshotCutoffLagDays, 2);
  assert.equal(tooOldCalls.count, 1);

  const invalidBatch = await createCompleteBatch(store, {
    dataCutoffDate: "2026-07-31",
    periodFrom: "2026-05-03",
    marker: 50,
    tamperDomain: "SALES",
  });
  const invalidCalls = { count: 0 };
  const invalid = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "SALES",
    period: twoDaysLaterPeriod,
    calculateLive: liveCalculator(liveData, invalidCalls),
  });
  assert.equal(invalid.delivery.status, "LIVE_FALLBACK");
  assert.equal(invalid.delivery.fallbackReason, "INVALID");
  assert.equal(invalid.snapshotBatchId, invalidBatch.snapshot_batch_id);
  assert.equal(invalidCalls.count, 1);

  const malformedBatch = await createCompleteBatch(store, {
    dataCutoffDate: "2026-07-31",
    periodFrom: "2026-05-03",
    marker: 70,
    malformedDomain: "SALES",
  });
  const malformedCalls = { count: 0 };
  const malformed = await dispatcher.dispatchStatisticsRead(prisma, {
    domain: "SALES",
    period: twoDaysLaterPeriod,
    calculateLive: liveCalculator(liveData, malformedCalls),
  });
  assert.equal(malformed.delivery.status, "LIVE_FALLBACK");
  assert.equal(malformed.delivery.fallbackReason, "INVALID");
  assert.equal(malformed.snapshotBatchId, malformedBatch.snapshot_batch_id);
  assert.equal(malformedCalls.count, 1);

  await assert.rejects(
    dispatcher.dispatchStatisticsRead(prisma, {
      domain: "SALES",
      period: twoDaysLaterPeriod,
      calculateLive: async () => {
        throw new Error("LIVE_FALLBACK_FAILED");
      },
    }),
    /LIVE_FALLBACK_FAILED/
  );

  const calculationScopeSource = readFileSync(
    path.join(
      process.cwd(),
      "quickhack_client/components/statistics/statistics-calculation-scope.tsx"
    ),
    "utf8"
  );
  for (const text of [
    "기본 기준보다",
    "저장 통계가 아직 없어",
    "저장 통계가 2일 이상 오래되어",
    "저장 통계를 안전하게 확인할 수 없어",
    "실시간 대체 계산",
  ]) {
    assert.ok(
      calculationScopeSource.includes(text),
      `The shared calculation scope must explain: ${text}`
    );
  }

  for (const apiPath of [
    "quickhack_server/api/statistics/purchases.ts",
    "quickhack_server/api/statistics/inventory.ts",
    "quickhack_server/api/statistics/sales.ts",
    "quickhack_server/api/statistics/returns.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), apiPath), "utf8");
    assert.ok(
      source.includes("dispatchStatisticsRead"),
      `${apiPath} must use the common statistics dispatcher.`
    );
    assert.equal(
      source.includes(
        'setOperationTraceField("statistics.calculation_mode", "LIVE")'
      ),
      false,
      `${apiPath} must trace the actual calculation mode.`
    );
  }

  console.log(
    "Statistics snapshot current, one-day delay, custom LIVE, safe fallback, v2 exclusion, and shared UI contracts verified."
  );
  console.log(
    JSON.stringify({
      snapshotReadDurationMs: Math.round(snapshotReadDurationMs * 10) / 10,
      snapshotLiveCallbackCount: snapshotCalls.count,
    })
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
