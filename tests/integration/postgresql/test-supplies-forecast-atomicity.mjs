import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-forecast-atomicity-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { calculateSupplyForecasts } = await import(
    "@/quickhack_server/supplies/supplies-service"
  );

  const userRow = await prisma.users.create({
    data: {
      username: "supply-forecast-atomicity-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply forecast atomicity test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function createSupply(code) {
    return prisma.supplies.create({
      data: {
        supply_code: code,
        supply_name: code,
        updated_by_user_id: user.userId,
        inventory: {
          create: {
            current_quantity: 0,
            reserved_quantity: 0,
          },
        },
      },
    });
  }

  function createBeforeTransactionMutationClient(mutate) {
    let transactionCount = 0;
    let mutationApplied = false;

    return {
      client: new Proxy(prisma, {
        get(target, property) {
          if (property !== "$transaction") {
            return Reflect.get(target, property, target);
          }

          return async (...args) => {
            transactionCount += 1;
            assert.equal(
              transactionCount,
              1,
              "Forecast calculation must enter exactly one transaction."
            );
            await mutate();
            mutationApplied = true;
            return target.$transaction(...args);
          };
        },
      }),
      state() {
        return {
          mutationApplied,
          transactionCount,
        };
      },
    };
  }

  const firstSupply = await createSupply("ATOMICITY_FIRST");
  const secondSupply = await createSupply("ATOMICITY_SECOND");
  const supplyIds = [firstSupply.supply_id, secondSupply.supply_id];

  async function persistedForecasts() {
    return prisma.supply_forecast_snapshots.findMany({
      where: {
        supply_id: {
          in: supplyIds,
        },
      },
      include: {
        calculation_fields: true,
      },
      orderBy: {
        supply_id: "asc",
      },
    });
  }

  async function successfulCalculationLogCount() {
    return prisma.employee_activity_logs.count({
      where: {
        action_type: "SUPPLY_FORECAST_CALCULATE",
        result: "SUCCESS",
      },
    });
  }

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_second_supply_forecast_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.supply_id = ${secondSupply.supply_id} THEN
        RAISE EXCEPTION 'forced second supply forecast failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_second_supply_forecast
    BEFORE INSERT ON supply_forecast_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION fail_second_supply_forecast_fn()
  `);

  await assert.rejects(() =>
    calculateSupplyForecasts(prisma, { lookbackDays: 1 }, user)
  );
  assert.deepEqual(
    await persistedForecasts(),
    [],
    "A later forecast failure must roll back earlier snapshots and calculation fields."
  );
  assert.equal(
    await successfulCalculationLogCount(),
    0,
    "A failed forecast batch must not write a success activity log."
  );

  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_second_supply_forecast ON supply_forecast_snapshots"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION fail_second_supply_forecast_fn()"
  );
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_supply_forecast_success_audit_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = 'SUPPLY_FORECAST_CALCULATE' THEN
        RAISE EXCEPTION 'forced supply forecast success audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_supply_forecast_success_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_supply_forecast_success_audit_fn()
  `);

  await assert.rejects(() =>
    calculateSupplyForecasts(prisma, { lookbackDays: 1 }, user)
  );
  assert.deepEqual(
    await persistedForecasts(),
    [],
    "Forecast snapshots must roll back when the success activity log cannot be written."
  );
  assert.equal(await successfulCalculationLogCount(), 0);

  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_supply_forecast_success_audit ON employee_activity_logs"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION fail_supply_forecast_success_audit_fn()"
  );
  const created = await calculateSupplyForecasts(
    prisma,
    { lookbackDays: 1 },
    user
  );
  assert.equal(created.length, 2);

  const successfulForecasts = await persistedForecasts();
  assert.equal(successfulForecasts.length, 2);
  assert(
    successfulForecasts.every(
      (forecast) => forecast.calculation_fields.length > 0
    ),
    "Every successful snapshot must retain its calculation evidence."
  );
  assert.equal(await successfulCalculationLogCount(), 1);

  const freshnessSupply = await createSupply("ATOMICITY_FRESHNESS");
  const freshnessBoundary = createBeforeTransactionMutationClient(() =>
    prisma.supply_inventory.update({
      where: {
        supply_id: freshnessSupply.supply_id,
      },
      data: {
        current_quantity: 25,
        version: {
          increment: 1,
        },
      },
    })
  );
  const freshnessForecasts = await calculateSupplyForecasts(
    freshnessBoundary.client,
    {
      supplyId: freshnessSupply.supply_id,
      lookbackDays: 1,
    },
    user
  );
  assert.deepEqual(freshnessBoundary.state(), {
    mutationApplied: true,
    transactionCount: 1,
  });
  assert.equal(freshnessForecasts.length, 1);
  assert.equal(
    freshnessForecasts[0].current_quantity,
    25,
    "The saved forecast must use inventory committed immediately before the transaction starts."
  );
  assert.equal(freshnessForecasts[0].available_quantity, 25);

  const persistedFreshnessForecast =
    await prisma.supply_forecast_snapshots.findFirst({
      where: {
        supply_id: freshnessSupply.supply_id,
      },
      orderBy: {
        forecast_id: "desc",
      },
    });
  assert.equal(persistedFreshnessForecast?.current_quantity, 25);
  assert.equal(persistedFreshnessForecast?.available_quantity, 25);
  assert.equal(await successfulCalculationLogCount(), 2);

  const deactivatedSupply = await createSupply("ATOMICITY_DEACTIVATED");
  const activeMembershipBoundary = createBeforeTransactionMutationClient(() =>
    prisma.supplies.update({
      where: {
        supply_id: deactivatedSupply.supply_id,
      },
      data: {
        is_active: 0,
      },
    })
  );
  const deactivatedForecasts = await calculateSupplyForecasts(
    activeMembershipBoundary.client,
    {
      supplyId: deactivatedSupply.supply_id,
      lookbackDays: 1,
    },
    user
  );
  assert.deepEqual(activeMembershipBoundary.state(), {
    mutationApplied: true,
    transactionCount: 1,
  });
  assert.deepEqual(
    deactivatedForecasts,
    [],
    "A supply deactivated immediately before the transaction starts must be excluded."
  );
  assert.equal(
    await prisma.supply_forecast_snapshots.count({
      where: {
        supply_id: deactivatedSupply.supply_id,
      },
    }),
    0
  );
  assert.equal(await successfulCalculationLogCount(), 3);

  console.log(
    "Supply forecast snapshot freshness, batch atomicity, and success audit atomicity verified."
  );
} finally {
  if (prisma) {
    await prisma
      .$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_second_supply_forecast")
      .catch(() => undefined);
    await prisma
      .$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_supply_forecast_success_audit"
      )
      .catch(() => undefined);
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
