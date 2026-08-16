import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { SUPPLY_REORDER_STATUS } from "../../../quickhack_shared/supplies/supplies.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-reorder-concurrency-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
const dateOnly = (value) => new Date(`${value}T00:00:00.000Z`);
const kstDateTime = (value) => new Date(`${value.replace(" ", "T")}+09:00`);

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    createSuggestedReordersFromForecasts,
    getSupplyWorkspaceData,
    updateSupplyReorderRequest,
  } = await import("@/quickhack_server/supplies/supplies-service");

  const userRow = await prisma.users.create({
    data: {
      username: "supply-reorder-concurrency-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply reorder concurrency test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  let forecastSequence = 0;

  async function createSupply(code) {
    return prisma.supplies.create({
      data: {
        supply_code: code,
        supply_name: code,
        default_supplier_name: `${code} supplier`,
        unit_cost: 1_000,
        updated_by_user_id: user.userId,
      },
    });
  }

  async function createForecast(
    supplyId,
    recommendedQuantity,
    forecastDate = "2026-08-03",
    createdAtOverride = null
  ) {
    forecastSequence += 1;
    const createdAtText =
      createdAtOverride ??
      `2026-08-03 09:00:${String(forecastSequence).padStart(2, "0")}`;

    return prisma.supply_forecast_snapshots.create({
      data: {
        supply_id: supplyId,
        forecast_date: dateOnly(forecastDate),
        period_from: kstDateTime("2026-07-04 00:00:00"),
        period_to: kstDateTime("2026-08-03 00:00:00"),
        lookback_days: 30,
        demand_source: "NO_USAGE",
        expected_usage_quantity: recommendedQuantity,
        average_daily_usage: 1,
        current_quantity: 0,
        available_quantity: 0,
        safety_stock_quantity: 1,
        reorder_point_quantity: 2,
        target_stock_quantity: recommendedQuantity,
        recommended_purchase_quantity: recommendedQuantity,
        created_by_user_id: user.userId,
        created_at: kstDateTime(createdAtText),
      },
    });
  }

  function createBeforeTransactionMutationClient(mutation) {
    let mutationCount = 0;
    const client = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") {
          return Reflect.get(target, property, target);
        }

        return async (...args) => {
          mutationCount += 1;
          assert.equal(
            mutationCount,
            1,
            "The reorder suggestion flow started more than one transaction."
          );
          await mutation();
          return target.$transaction(...args);
        };
      },
    });

    return {
      client,
      assertMutationApplied() {
        assert.equal(
          mutationCount,
          1,
          "The before-transaction mutation was not applied."
        );
      },
    };
  }

  const indexRows = await prisma.$queryRawUnsafe(`
    SELECT indexname AS name, indexdef
    FROM pg_catalog.pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'supply_reorder_requests'
  `);
  const openIndex = indexRows.find(
    (row) => row.name === "uq_supply_reorder_requests_open_supply_id"
  );
  assert.ok(openIndex, "The open reorder uniqueness migration was not applied.");
  assert.match(String(openIndex.indexdef), /CREATE UNIQUE INDEX/i);
  assert.match(String(openIndex.indexdef), /WHERE/i);

  const latestPositiveSupply = await createSupply("REORDER_LATEST_POSITIVE");
  await createForecast(latestPositiveSupply.supply_id, 0, "2026-07-30");
  const latestPositiveForecast = await createForecast(
    latestPositiveSupply.supply_id,
    4,
    "2026-07-30"
  );
  const latestPositiveResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-07-30" },
    user
  );
  assert.deepEqual(latestPositiveResult, {
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
  });
  const latestPositiveRequest =
    await prisma.supply_reorder_requests.findFirstOrThrow({
      where: { supply_id: latestPositiveSupply.supply_id },
    });
  assert.equal(
    latestPositiveRequest.forecast_id,
    latestPositiveForecast.forecast_id
  );

  const dateScopedSupply = await createSupply("REORDER_DATE_SCOPED");
  const historicalPositiveForecast = await createForecast(
    dateScopedSupply.supply_id,
    3,
    "2026-07-31"
  );
  await createForecast(dateScopedSupply.supply_id, 0, "2026-08-01");
  const dateScopedResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-07-31" },
    user
  );
  assert.deepEqual(dateScopedResult, {
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
  });
  const dateScopedRequest =
    await prisma.supply_reorder_requests.findFirstOrThrow({
      where: { supply_id: dateScopedSupply.supply_id },
    });
  assert.equal(
    dateScopedRequest.forecast_id,
    historicalPositiveForecast.forecast_id
  );

  const latestZeroSupply = await createSupply("REORDER_LATEST_ZERO");
  await createForecast(latestZeroSupply.supply_id, 5, "2026-08-01");
  await createForecast(latestZeroSupply.supply_id, 0, "2026-08-01");
  const latestZeroResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-01" },
    user
  );
  assert.deepEqual(latestZeroResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });
  assert.equal(
    await prisma.supply_reorder_requests.count({
      where: { supply_id: latestZeroSupply.supply_id },
    }),
    0,
    "An older positive forecast created a suggestion after the latest forecast reached zero."
  );

  const tiedForecastSupply = await createSupply("REORDER_TIED_FORECAST");
  const tiedCreatedAt = "2026-08-02 10:00:00";
  await createForecast(
    tiedForecastSupply.supply_id,
    8,
    "2026-08-02",
    tiedCreatedAt
  );
  await createForecast(
    tiedForecastSupply.supply_id,
    0,
    "2026-08-02",
    tiedCreatedAt
  );
  const tiedForecastResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-02" },
    user
  );
  assert.deepEqual(tiedForecastResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });

  const zeroRaceSupply = await createSupply("REORDER_ZERO_BEFORE_TRANSACTION");
  await createForecast(zeroRaceSupply.supply_id, 8, "2026-08-08");
  const zeroRaceClient = createBeforeTransactionMutationClient(() =>
    createForecast(zeroRaceSupply.supply_id, 0, "2026-08-08")
  );
  const zeroRaceResult = await createSuggestedReordersFromForecasts(
    zeroRaceClient.client,
    { forecastDate: "2026-08-08" },
    user
  );
  zeroRaceClient.assertMutationApplied();
  assert.deepEqual(zeroRaceResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });
  assert.equal(
    await prisma.supply_reorder_requests.count({
      where: { supply_id: zeroRaceSupply.supply_id },
    }),
    0,
    "A zero forecast committed before the transaction still produced a stale suggestion."
  );

  const inactiveRaceSupply = await createSupply(
    "REORDER_INACTIVE_BEFORE_TRANSACTION"
  );
  await createForecast(inactiveRaceSupply.supply_id, 9, "2026-08-09");
  const inactiveRaceClient = createBeforeTransactionMutationClient(() =>
    prisma.supplies.update({
      where: { supply_id: inactiveRaceSupply.supply_id },
      data: { is_active: 0 },
    })
  );
  const inactiveRaceResult = await createSuggestedReordersFromForecasts(
    inactiveRaceClient.client,
    { forecastDate: "2026-08-09" },
    user
  );
  inactiveRaceClient.assertMutationApplied();
  assert.deepEqual(inactiveRaceResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });
  assert.equal(
    await prisma.supply_reorder_requests.count({
      where: { supply_id: inactiveRaceSupply.supply_id },
    }),
    0,
    "A supply deactivated before the transaction still received a suggestion."
  );

  const refreshRaceSupply = await createSupply(
    "REORDER_REFRESH_BEFORE_TRANSACTION"
  );
  const refreshRaceOriginalForecast = await createForecast(
    refreshRaceSupply.supply_id,
    4,
    "2026-08-10"
  );
  await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-10" },
    user
  );
  const refreshRaceSuggestion =
    await prisma.supply_reorder_requests.findFirstOrThrow({
      where: { supply_id: refreshRaceSupply.supply_id },
    });
  const refreshRaceManualUpdatedAt = "2026-08-10 12:34:56";
  await prisma.supply_reorder_requests.update({
    where: {
      reorder_request_id: refreshRaceSuggestion.reorder_request_id,
    },
    data: {
      requested_quantity: 11,
      supplier_name: "race manual supplier",
      reason: "race manual review",
      updated_at: kstDateTime(refreshRaceManualUpdatedAt),
    },
  });
  await createForecast(refreshRaceSupply.supply_id, 12, "2026-08-10");
  const refreshRaceClient = createBeforeTransactionMutationClient(() =>
    createForecast(refreshRaceSupply.supply_id, 0, "2026-08-10")
  );
  const refreshRaceResult = await createSuggestedReordersFromForecasts(
    refreshRaceClient.client,
    { forecastDate: "2026-08-10" },
    user
  );
  refreshRaceClient.assertMutationApplied();
  assert.deepEqual(refreshRaceResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });
  const unchangedRefreshRaceSuggestion =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: {
        reorder_request_id: refreshRaceSuggestion.reorder_request_id,
      },
    });
  assert.equal(
    unchangedRefreshRaceSuggestion.forecast_id,
    refreshRaceOriginalForecast.forecast_id
  );
  assert.equal(unchangedRefreshRaceSuggestion.requested_quantity, 11);
  assert.equal(
    unchangedRefreshRaceSuggestion.supplier_name,
    "race manual supplier"
  );
  assert.equal(unchangedRefreshRaceSuggestion.reason, "race manual review");
  assert.equal(
    unchangedRefreshRaceSuggestion.updated_at.getTime(),
    kstDateTime(refreshRaceManualUpdatedAt).getTime()
  );

  const preservedSuggestionSupply = await createSupply(
    "REORDER_PRESERVE_STALE_SUGGESTION"
  );
  const preservedSuggestionForecast = await createForecast(
    preservedSuggestionSupply.supply_id,
    6,
    "2026-08-06"
  );
  await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-06" },
    user
  );
  const preservedSuggestion =
    await prisma.supply_reorder_requests.findFirstOrThrow({
      where: { supply_id: preservedSuggestionSupply.supply_id },
    });
  const manualUpdatedAt = "2026-08-06 12:34:56";
  await prisma.supply_reorder_requests.update({
    where: { reorder_request_id: preservedSuggestion.reorder_request_id },
    data: {
      requested_quantity: 7,
      supplier_name: "manual supplier",
      reason: "manual review",
      updated_at: kstDateTime(manualUpdatedAt),
    },
  });
  await createForecast(
    preservedSuggestionSupply.supply_id,
    0,
    "2026-08-06"
  );
  const preserveStaleResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-06" },
    user
  );
  assert.deepEqual(preserveStaleResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });
  const unchangedStaleSuggestion =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: {
        reorder_request_id: preservedSuggestion.reorder_request_id,
      },
    });
  assert.equal(
    unchangedStaleSuggestion.forecast_id,
    preservedSuggestionForecast.forecast_id
  );
  assert.equal(unchangedStaleSuggestion.requested_quantity, 7);
  assert.equal(unchangedStaleSuggestion.supplier_name, "manual supplier");
  assert.equal(unchangedStaleSuggestion.reason, "manual review");
  assert.equal(
    unchangedStaleSuggestion.updated_at.getTime(),
    kstDateTime(manualUpdatedAt).getTime()
  );

  const staleWorkspace = await getSupplyWorkspaceData(prisma);
  const staleSuggestionDto = staleWorkspace.openReorders.find(
    (reorder) =>
      reorder.reorderRequestId === preservedSuggestion.reorder_request_id
  );
  assert.equal(staleSuggestionDto?.isForecastOutdated, true);
  assert.equal(staleSuggestionDto?.latestRecommendedQuantity, 0);

  await prisma.supply_reorder_requests.update({
    where: { reorder_request_id: preservedSuggestion.reorder_request_id },
    data: { request_status: SUPPLY_REORDER_STATUS.requested },
  });
  const requestedWorkspace = await getSupplyWorkspaceData(prisma);
  const requestedSuggestionDto = requestedWorkspace.openReorders.find(
    (reorder) =>
      reorder.reorderRequestId === preservedSuggestion.reorder_request_id
  );
  assert.equal(requestedSuggestionDto?.isForecastOutdated, false);
  assert.equal(requestedSuggestionDto?.latestRecommendedQuantity, 0);

  const refreshSupply = await createSupply("REORDER_REFRESH");
  const firstForecast = await createForecast(refreshSupply.supply_id, 5);
  const firstResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-03" },
    user
  );
  assert.deepEqual(firstResult, {
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
  });

  const firstRequest = await prisma.supply_reorder_requests.findFirstOrThrow({
    where: { supply_id: refreshSupply.supply_id },
  });
  assert.equal(firstRequest.forecast_id, firstForecast.forecast_id);

  const refreshedForecast = await createForecast(refreshSupply.supply_id, 9);
  const refreshResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-03" },
    user
  );
  assert.deepEqual(refreshResult, {
    createdCount: 0,
    updatedCount: 1,
    skippedCount: 0,
  });

  const refreshedRequest = await prisma.supply_reorder_requests.findFirstOrThrow({
    where: { supply_id: refreshSupply.supply_id },
  });
  assert.equal(refreshedRequest.reorder_request_id, firstRequest.reorder_request_id);
  assert.equal(refreshedRequest.forecast_id, refreshedForecast.forecast_id);
  assert.equal(refreshedRequest.recommended_quantity, 9);
  assert.equal(refreshedRequest.requested_quantity, 9);

  await prisma.supply_reorder_requests.update({
    where: { reorder_request_id: refreshedRequest.reorder_request_id },
    data: { request_status: SUPPLY_REORDER_STATUS.requested },
  });
  await createForecast(refreshSupply.supply_id, 12);
  const preservedResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-03" },
    user
  );
  assert.deepEqual(preservedResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 1,
  });

  const preservedRequest = await prisma.supply_reorder_requests.findUniqueOrThrow({
    where: { reorder_request_id: refreshedRequest.reorder_request_id },
  });
  assert.equal(preservedRequest.request_status, SUPPLY_REORDER_STATUS.requested);
  assert.equal(preservedRequest.forecast_id, refreshedForecast.forecast_id);
  assert.equal(preservedRequest.requested_quantity, 9);

  const concurrentSupply = await createSupply("REORDER_CONCURRENT");
  await createForecast(concurrentSupply.supply_id, 7);
  const concurrentResults = await Promise.all([
    createSuggestedReordersFromForecasts(
      prisma,
      { forecastDate: "2026-08-03" },
      user
    ),
    createSuggestedReordersFromForecasts(
      prisma,
      { forecastDate: "2026-08-03" },
      user
    ),
  ]);
  assert.equal(
    concurrentResults.reduce((sum, result) => sum + result.createdCount, 0),
    1,
    "Concurrent suggestion generation created an unexpected number of rows."
  );

  const concurrentOpenRequests = await prisma.supply_reorder_requests.findMany({
    where: {
      supply_id: concurrentSupply.supply_id,
      request_status: {
        in: [
          SUPPLY_REORDER_STATUS.suggested,
          SUPPLY_REORDER_STATUS.requested,
          SUPPLY_REORDER_STATUS.approved,
          SUPPLY_REORDER_STATUS.ordered,
        ],
      },
    },
  });
  assert.equal(concurrentOpenRequests.length, 1);

  await assert.rejects(
    prisma.supply_reorder_requests.create({
      data: {
        supply_id: concurrentSupply.supply_id,
        request_status: SUPPLY_REORDER_STATUS.approved,
        recommended_quantity: 1,
      },
    }),
    (error) => error?.code === "P2002"
  );

  const transitionSupply = await createSupply("REORDER_TRANSITION");
  const existingOpenRequest = await prisma.supply_reorder_requests.create({
    data: {
      supply_id: transitionSupply.supply_id,
      request_status: SUPPLY_REORDER_STATUS.suggested,
      recommended_quantity: 3,
      requested_quantity: 3,
      created_by_user_id: user.userId,
    },
  });
  const cancelledRequest = await prisma.supply_reorder_requests.create({
    data: {
      supply_id: transitionSupply.supply_id,
      request_status: SUPPLY_REORDER_STATUS.cancelled,
      recommended_quantity: 4,
      requested_quantity: 4,
      created_by_user_id: user.userId,
    },
  });

  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      {
        reorderRequestId: cancelledRequest.reorder_request_id,
        requestStatus: SUPPLY_REORDER_STATUS.requested,
        expectedRequestStatus: SUPPLY_REORDER_STATUS.cancelled,
        expectedRevision: cancelledRequest.revision,
        requestedQuantity: 4,
        orderedQuantity: "",
        receivedQuantity: "",
        expectedUnitCost: "",
        supplierName: "",
        reason: "",
      },
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_OPEN_CONFLICT"
  );

  const unchangedCancelledRequest =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: { reorder_request_id: cancelledRequest.reorder_request_id },
    });
  assert.equal(
    unchangedCancelledRequest.request_status,
    SUPPLY_REORDER_STATUS.cancelled
  );

  await prisma.supply_reorder_requests.update({
    where: { reorder_request_id: existingOpenRequest.reorder_request_id },
    data: { request_status: SUPPLY_REORDER_STATUS.cancelled },
  });
  await prisma.supply_reorder_requests.create({
    data: {
      supply_id: transitionSupply.supply_id,
      request_status: SUPPLY_REORDER_STATUS.requested,
      recommended_quantity: 6,
      requested_quantity: 6,
      created_by_user_id: user.userId,
    },
  });

  const inactiveNewSupply = await createSupply("REORDER_INACTIVE_NEW");
  await createForecast(inactiveNewSupply.supply_id, 11, "2026-08-04");
  await prisma.supplies.update({
    where: { supply_id: inactiveNewSupply.supply_id },
    data: { is_active: 0 },
  });

  const inactiveNewResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-04" },
    user
  );
  assert.deepEqual(inactiveNewResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });
  assert.equal(
    await prisma.supply_reorder_requests.count({
      where: { supply_id: inactiveNewSupply.supply_id },
    }),
    0,
    "An inactive supply received a new reorder suggestion."
  );

  const inactiveRefreshSupply = await createSupply("REORDER_INACTIVE_REFRESH");
  const inactiveRefreshForecast = await createForecast(
    inactiveRefreshSupply.supply_id,
    5,
    "2026-08-05"
  );
  const inactiveRefreshCreateResult =
    await createSuggestedReordersFromForecasts(
      prisma,
      { forecastDate: "2026-08-05" },
      user
    );
  assert.deepEqual(inactiveRefreshCreateResult, {
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
  });

  const inactiveRefreshRequest =
    await prisma.supply_reorder_requests.findFirstOrThrow({
      where: { supply_id: inactiveRefreshSupply.supply_id },
    });
  await createForecast(inactiveRefreshSupply.supply_id, 13, "2026-08-05");
  await prisma.supplies.update({
    where: { supply_id: inactiveRefreshSupply.supply_id },
    data: { is_active: 0 },
  });

  const inactiveRefreshResult = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-05" },
    user
  );
  assert.deepEqual(inactiveRefreshResult, {
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
  });

  const unchangedInactiveSuggestion =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: {
        reorder_request_id: inactiveRefreshRequest.reorder_request_id,
      },
    });
  assert.equal(
    unchangedInactiveSuggestion.forecast_id,
    inactiveRefreshForecast.forecast_id
  );
  assert.equal(unchangedInactiveSuggestion.requested_quantity, 5);

  await prisma.supply_reorder_requests.update({
    where: {
      reorder_request_id: inactiveRefreshRequest.reorder_request_id,
    },
    data: { request_status: SUPPLY_REORDER_STATUS.requested },
  });
  await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-05" },
    user
  );
  const preservedInactiveRequest =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: {
        reorder_request_id: inactiveRefreshRequest.reorder_request_id,
      },
    });
  assert.equal(
    preservedInactiveRequest.request_status,
    SUPPLY_REORDER_STATUS.requested,
    "An in-progress reorder was automatically cancelled for an inactive supply."
  );
  assert.equal(preservedInactiveRequest.requested_quantity, 5);

  console.log(
    "Supply reorder open-request uniqueness and inactive-supply guards verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
