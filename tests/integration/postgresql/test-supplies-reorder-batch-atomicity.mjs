import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { SUPPLY_REORDER_STATUS } from "../../../quickhack_shared/supplies/supplies.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-reorder-batch-atomicity-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function kstDateTime(value) {
  return new Date(`${String(value).replace(" ", "T")}+09:00`);
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { createSuggestedReordersFromForecasts } = await import(
    "@/quickhack_server/supplies/supplies-service"
  );

  const userRow = await prisma.users.create({
    data: {
      username: "supply-reorder-batch-atomicity-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply reorder batch atomicity test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function createSupply(code, unitCost) {
    return prisma.supplies.create({
      data: {
        supply_code: code,
        supply_name: code,
        unit_cost: unitCost,
        default_supplier_name: `${code} supplier`,
        updated_by_user_id: user.userId,
      },
    });
  }

  async function createForecast(
    supplyId,
    recommendedQuantity,
    createdAt
  ) {
    return prisma.supply_forecast_snapshots.create({
      data: {
        supply_id: supplyId,
        forecast_date: new Date("2026-08-07T00:00:00.000Z"),
        period_from: kstDateTime("2026-08-06 00:00:00"),
        period_to: kstDateTime("2026-08-07 00:00:00"),
        lookback_days: 1,
        demand_source: "BUSINESS_RULE",
        expected_usage_quantity: recommendedQuantity,
        average_daily_usage: recommendedQuantity,
        usage_stddev: 0,
        current_quantity: 0,
        available_quantity: 0,
        safety_stock_quantity: 0,
        reorder_point_quantity: recommendedQuantity,
        target_stock_quantity: recommendedQuantity,
        recommended_purchase_quantity: recommendedQuantity,
        created_by_user_id: user.userId,
        created_at: kstDateTime(createdAt),
      },
    });
  }

  const refreshSupply = await createSupply("BATCH_REFRESH", 800);
  const createSupplyRow = await createSupply("BATCH_CREATE", 900);
  const failSupply = await createSupply("BATCH_FAIL", 1_000);
  const originalForecast = await createForecast(
    refreshSupply.supply_id,
    3,
    "2026-08-07 09:00:00"
  );
  const originalUpdatedAt = kstDateTime("2026-08-07 09:30:00");
  const existingSuggestion = await prisma.supply_reorder_requests.create({
    data: {
      supply_id: refreshSupply.supply_id,
      forecast_id: originalForecast.forecast_id,
      request_status: SUPPLY_REORDER_STATUS.suggested,
      recommended_quantity: 3,
      requested_quantity: 7,
      expected_unit_cost: 750,
      supplier_name: "manual supplier",
      reason: "manual review",
      created_by_user_id: user.userId,
      created_at: kstDateTime("2026-08-07 09:00:00"),
      updated_at: originalUpdatedAt,
    },
  });

  const refreshedForecast = await createForecast(
    refreshSupply.supply_id,
    8,
    "2026-08-07 12:00:03"
  );
  await createForecast(
    createSupplyRow.supply_id,
    4,
    "2026-08-07 12:00:02"
  );
  await createForecast(
    failSupply.supply_id,
    5,
    "2026-08-07 12:00:01"
  );

  async function currentExistingSuggestion() {
    return prisma.supply_reorder_requests.findUniqueOrThrow({
      where: {
        reorder_request_id: existingSuggestion.reorder_request_id,
      },
    });
  }

  async function assertOriginalSuggestionPreserved() {
    const row = await currentExistingSuggestion();
    assert.equal(row.forecast_id, originalForecast.forecast_id);
    assert.equal(row.recommended_quantity, 3);
    assert.equal(row.requested_quantity, 7);
    assert.equal(row.expected_unit_cost, 750);
    assert.equal(row.supplier_name, "manual supplier");
    assert.equal(row.reason, "manual review");
    assert.equal(row.updated_at.getTime(), originalUpdatedAt.getTime());
  }

  async function assertNoNewSuggestions() {
    assert.equal(
      await prisma.supply_reorder_requests.count({
        where: {
          supply_id: {
            in: [createSupplyRow.supply_id, failSupply.supply_id],
          },
        },
      }),
      0
    );
  }

  async function successLogCount() {
    return prisma.employee_activity_logs.count({
      where: {
        action_type: "SUPPLY_REORDER_SUGGESTIONS_CREATE",
        result: "SUCCESS",
      },
    });
  }

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_reorder_suggestion_insert_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.supply_id = ${failSupply.supply_id} THEN
        RAISE EXCEPTION 'forced reorder suggestion insert failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_reorder_suggestion_insert
    BEFORE INSERT ON supply_reorder_requests
    FOR EACH ROW
    EXECUTE FUNCTION fail_reorder_suggestion_insert_fn()
  `);

  await assert.rejects(() =>
    createSuggestedReordersFromForecasts(
      prisma,
      { forecastDate: "2026-08-07" },
      user
    )
  );
  await assertOriginalSuggestionPreserved();
  await assertNoNewSuggestions();
  assert.equal(await successLogCount(), 0);

  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_reorder_suggestion_insert ON supply_reorder_requests"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION fail_reorder_suggestion_insert_fn()"
  );
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_reorder_suggestion_success_audit_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = 'SUPPLY_REORDER_SUGGESTIONS_CREATE' THEN
        RAISE EXCEPTION 'forced reorder suggestion success audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_reorder_suggestion_success_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_reorder_suggestion_success_audit_fn()
  `);

  await assert.rejects(() =>
    createSuggestedReordersFromForecasts(
      prisma,
      { forecastDate: "2026-08-07" },
      user
    )
  );
  await assertOriginalSuggestionPreserved();
  await assertNoNewSuggestions();
  assert.equal(await successLogCount(), 0);

  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_reorder_suggestion_success_audit ON employee_activity_logs"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION fail_reorder_suggestion_success_audit_fn()"
  );
  const result = await createSuggestedReordersFromForecasts(
    prisma,
    { forecastDate: "2026-08-07" },
    user
  );
  assert.deepEqual(result, {
    createdCount: 2,
    updatedCount: 1,
    skippedCount: 0,
  });

  const refreshedSuggestion = await currentExistingSuggestion();
  assert.equal(refreshedSuggestion.forecast_id, refreshedForecast.forecast_id);
  assert.equal(refreshedSuggestion.recommended_quantity, 8);
  assert.equal(refreshedSuggestion.requested_quantity, 8);
  assert.equal(refreshedSuggestion.expected_unit_cost, 800);
  assert.equal(refreshedSuggestion.supplier_name, "BATCH_REFRESH supplier");
  assert.equal(await prisma.supply_reorder_requests.count(), 3);
  assert.equal(await successLogCount(), 1);

  console.log("Supply reorder suggestion batch atomicity verified.");
} finally {
  if (prisma) {
    await prisma
      .$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_reorder_suggestion_insert")
      .catch(() => undefined);
    await prisma
      .$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_reorder_suggestion_success_audit"
      )
      .catch(() => undefined);
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
