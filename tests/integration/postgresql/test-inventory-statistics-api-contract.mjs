import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";

import {
  createStatisticsSnapshotFixture,
} from "../../support/statistics-snapshot-fixtures.ts";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  createInventoryCatalogFixture,
} from "../../support/inventory-business-fixtures.mjs";
import { QUICKHACK_TRACE_ID_HEADER } from "../../../quickhack_shared/observability/http-trace.ts";
import {
  quickHackClock,
} from "../../../quickhack_shared/core/time.ts";
import { addKstCalendarDays } from "../../../quickhack_shared/statistics/statistics-period.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inventory-statistics-api-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function request(path, token) {
  return new NextRequest(`http://localhost${path}`, {
    headers: token
      ? { cookie: `quickhack_session=${token}` }
      : undefined,
  });
}

async function createInventoryFixture({
  ledgerService,
  catalog,
  index,
  status,
  timestamp,
  movementType,
}) {
  const pgNo = `${catalog.prefix}-STATS-PG-${index}`;
  const imei = `3577000000000${String(index).padStart(2, "0")}`;

  await prisma.devices.create({
    data: {
      pg_no: pgNo,
      imei,
      model: catalog.options.model.label,
      model_code: catalog.options.model.option_key,
      model_seq: index,
      storage: catalog.options.storage.label,
      color: catalog.options.color.label,
      sale_grade: catalog.options.grade.option_key,
      warranty: "2Y",
      inventory_sku_id: catalog.sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.inventory.create({
    data: {
      pg_no: pgNo,
      inventory_status: status,
      location: "INVENTORY_STATISTICS_TEST",
      stocked_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.$transaction((tx) =>
    ledgerService.recordInventoryCreatedWithLedger(tx, {
      pgNo,
      inventoryStatus: status,
      operationKey: `inventory-statistics-api:${pgNo}`,
      movementType:
        movementType ??
        ledgerService.INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated,
      sourceType: "INVENTORY_STATISTICS_API_TEST",
      sourceId: pgNo,
      occurredAt: timestamp,
    })
  );
  const purchasePrice =
    status === "SELLABLE" ? 321_000 + index : null;

  if (purchasePrice !== null) {
    await prisma.inbounds.create({
      data: {
        pg_no: pgNo,
        purchase_price: purchasePrice,
        price_agreed_at: timestamp,
        inbound_status: "PURCHASED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }

  return { pgNo, imei, purchasePrice };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const ledgerService = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const inventoryApi = await import(
    "@/quickhack_server/api/statistics/inventory"
  );
  const snapshotStore = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );
  const timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const roles = ["LEADER", "MANAGER", "STAFF", "VIEWER"];
  const tokens = new Map();

  for (const role of roles) {
    const user = await prisma.users.create({
      data: {
        username: `inventory-statistics-${role.toLowerCase()}`,
        password_hash: "test-only",
        role,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    tokens.set(role, await authService.createUserSession(user.user_id));
  }

  const unauthorized = await inventoryApi.GET(
    request("/api/statistics/inventory")
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(
    (
      await inventoryApi.GET(
        request("/api/statistics/inventory?q=legacy")
      )
    ).status,
    401
  );

  for (const role of ["MANAGER", "STAFF", "VIEWER"]) {
    const forbidden = await inventoryApi.GET(
      request("/api/statistics/inventory", tokens.get(role))
    );
    assert.equal(
      forbidden.status,
      403,
      `${role} must not call the LEADER inventory statistics API.`
    );
  }

  for (const unsupportedSearchPath of [
    "/api/statistics/inventory?q=",
    "/api/statistics/inventory?q=SKU",
  ]) {
    const unsupportedSearch = await inventoryApi.GET(
      request(unsupportedSearchPath, tokens.get("LEADER"))
    );
    assert.equal(unsupportedSearch.status, 400);
    assert.match(
      (await unsupportedSearch.json()).message,
      /통계 검색은 지원하지 않습니다/
    );
  }

  const invalidPeriod = await inventoryApi.GET(
    request(
      "/api/statistics/inventory?period=week",
      tokens.get("LEADER")
    )
  );
  assert.equal(invalidPeriod.status, 400);
  assert.equal((await invalidPeriod.json()).ok, false);

  const today = quickHackClock.formatKstDate();
  const cutoffDate = addKstCalendarDays(today, -1);
  const exactFromDate = addKstCalendarDays(cutoffDate, -6);
  const conflictingPeriod = await inventoryApi.GET(
    request(
      `/api/statistics/inventory?period=30d&fromDate=${exactFromDate}&toDate=${cutoffDate}`,
      tokens.get("LEADER")
    )
  );
  assert.equal(conflictingPeriod.status, 400);

  const incompletePeriod = await inventoryApi.GET(
    request(
      `/api/statistics/inventory?fromDate=${exactFromDate}`,
      tokens.get("LEADER")
    )
  );
  assert.equal(incompletePeriod.status, 400);

  const openPeriod = await inventoryApi.GET(
    request(
      `/api/statistics/inventory?fromDate=${exactFromDate}&toDate=${today}`,
      tokens.get("LEADER")
    )
  );
  assert.equal(openPeriod.status, 400);

  const empty = await inventoryApi.GET(
    request("/api/statistics/inventory", tokens.get("LEADER"))
  );
  assert.equal(empty.status, 200);
  assert.ok(empty.headers.get(QUICKHACK_TRACE_ID_HEADER));
  const emptyBody = await empty.json();
  assert.equal(emptyBody.ok, true);
  assert.equal(emptyBody.data.integrity.availability, "EMPTY");
  assert.equal(emptyBody.data.asOf.totalQuantity, 0);
  assert.equal(emptyBody.data.aging.integrity.availability, "EMPTY");
  assert.equal(emptyBody.data.aging.warehouseQuantity, 0);
  assert.equal(emptyBody.data.aging.longTermQuantity, 0);
  assert.equal(emptyBody.data.period.preset, "90d");
  assert.equal(emptyBody.data.period.dayCount, 90);
  assert.equal(emptyBody.data.period.integrity.availability, "EMPTY");
  assert.equal(emptyBody.data.period.summary.salesCompletedQuantity, 0);
  assert.equal(
    emptyBody.data.calculation.delivery.status,
    "LIVE_FALLBACK"
  );
  assert.equal(
    emptyBody.data.calculation.delivery.fallbackReason,
    "NOT_FOUND"
  );
  assert.ok(
    emptyBody.data.asOf.groups.every((group) => group.quantity === 0)
  );

  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "INVENTORY-STATS-API",
    timestamp,
  });
  const fixtures = [];

  for (const [index, status] of [
    "SELLABLE",
    "DELIVERING",
    "NONE_TRACKING",
    "RETURN_REQUESTED",
  ].entries()) {
    fixtures.push(
      await createInventoryFixture({
        ledgerService,
        catalog,
        index: index + 1,
        status,
        timestamp,
      })
    );
  }

  const ready = await inventoryApi.GET(
    request(
      "/api/statistics/inventory?period=30d",
      tokens.get("LEADER")
    )
  );
  assert.equal(ready.status, 200);
  assert.ok(ready.headers.get(QUICKHACK_TRACE_ID_HEADER));
  const readyBody = await ready.json();
  assert.equal(readyBody.ok, true);
  assert.equal(readyBody.data.integrity.availability, "READY");
  assert.equal(readyBody.data.asOf.totalQuantity, 4);
  assert.equal(readyBody.data.source.inventoryRowCount, 4);
  assert.equal(readyBody.data.source.balanceQuantity, 4);
  assert.equal(readyBody.data.aging.integrity.availability, "READY");
  assert.equal(readyBody.data.aging.warehouseQuantity, 1);
  assert.equal(readyBody.data.aging.resolvedCycleQuantity, 1);
  assert.equal(readyBody.data.aging.missingCycleQuantity, 0);
  assert.equal(readyBody.data.aging.longTermQuantity, 0);
  assert.equal(readyBody.data.aging.skuRows.length, 1);
  assert.equal(readyBody.data.period.preset, "30d");
  assert.equal(readyBody.data.period.dayCount, 30);
  assert.equal(readyBody.data.period.integrity.availability, "READY");
  assert.equal(readyBody.data.period.summary.newInventoryQuantity, 1);
  assert.equal(readyBody.data.period.summary.salesCompletedQuantity, 0);
  assert.equal(readyBody.data.period.source.operationCount, 4);
  assert.deepEqual(
    Object.fromEntries(
      readyBody.data.aging.buckets.map((bucket) => [
        bucket.key,
        bucket.quantity,
      ])
    ),
    {
      DAYS_0_29: 1,
      DAYS_30_59: 0,
      DAYS_60_89: 0,
      DAYS_90_PLUS: 0,
    }
  );
  assert.deepEqual(readyBody.data.aging.skuRows[0].purchaseCost, {
    amount: fixtures[0].purchasePrice,
    pricedQuantity: 1,
    totalQuantity: 1,
    missingPriceQuantity: 0,
    coveragePercent: 100,
  });
  assert.deepEqual(
    Object.fromEntries(
      readyBody.data.asOf.groups.map((group) => [
        group.key,
        group.quantity,
      ])
    ),
    {
      SELLABLE: 1,
      ORDER_ALLOCATED: 0,
      SALES_RESTRICTED: 0,
      DELIVERING: 1,
      TRACKING_EXCEPTION: 1,
      FINAL_DELIVERY: 0,
      CLAIM_LOCATION_UNKNOWN: 1,
    }
  );

  const defaultReady = await inventoryApi.GET(
    request("/api/statistics/inventory", tokens.get("LEADER"))
  );
  assert.equal(defaultReady.status, 200);
  const defaultReadyBody = await defaultReady.json();

  const exact = await inventoryApi.GET(
    request(
      `/api/statistics/inventory?fromDate=${exactFromDate}&toDate=${cutoffDate}`,
      tokens.get("LEADER")
    )
  );
  assert.equal(exact.status, 200);
  const exactBody = await exact.json();
  assert.equal(exactBody.data.period.preset, "custom");
  assert.equal(exactBody.data.period.fromDate, exactFromDate);
  assert.equal(exactBody.data.period.toDate, cutoffDate);
  assert.equal(exactBody.data.period.dayCount, 7);
  assert.deepEqual(exactBody.data.calculation.period, {
    fromDate: exactFromDate,
    toDate: cutoffDate,
    dayCount: 7,
  });
  assert.equal(exactBody.data.calculation.dataCutoffDate, cutoffDate);
  assert.equal(exactBody.data.calculation.isDefaultPeriod, false);
  assert.equal(
    exactBody.data.calculation.delivery.status,
    "LIVE_CUSTOM_PERIOD"
  );
  assert.equal(exactBody.data.asOf.date, cutoffDate);

  const serializedReady = JSON.stringify(readyBody);
  for (const fixture of fixtures) {
    assert.equal(serializedReady.includes(fixture.pgNo), false);
    assert.equal(serializedReady.includes(fixture.imei), false);
  }

  const sellableBalance =
    await prisma.inventory_quantity_balances.findFirstOrThrow({
      where: { inventory_status: "SELLABLE" },
    });
  await prisma.inventory_quantity_balances.update({
    where: {
      inventory_quantity_balance_id:
        sellableBalance.inventory_quantity_balance_id,
    },
    data: {
      quantity: {
        increment: 1,
      },
    },
  });

  const partial = await inventoryApi.GET(
    request("/api/statistics/inventory", tokens.get("LEADER"))
  );
  assert.equal(partial.status, 200);
  const partialBody = await partial.json();
  assert.equal(partialBody.ok, true);
  assert.equal(partialBody.data.integrity.availability, "PARTIAL");
  assert.equal(partialBody.data.asOf.totalQuantity, null);
  assert.equal(partialBody.data.aging.integrity.availability, "PARTIAL");
  assert.equal(partialBody.data.aging.warehouseQuantity, null);
  assert.equal(partialBody.data.period.integrity.availability, "PARTIAL");
  assert.equal(partialBody.data.period.summary.averageWarehouseQuantity, null);
  assert.ok(
    partialBody.data.asOf.groups.every(
      (group) => group.quantity === null
    )
  );
  assert.ok(
    partialBody.data.integrity.issues.some(
      (issue) => issue.code === "SKU_STATUS_MISMATCH"
    )
  );

  await prisma.$executeRawUnsafe(
    "DROP TABLE inventory_quantity_movements"
  );
  const failed = await inventoryApi.GET(
    request("/api/statistics/inventory", tokens.get("LEADER"))
  );
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.code, "INTERNAL_ERROR");
  assert.match(failedBody.traceId, /^[0-9a-f-]{36}$/);

  const snapshotCalculation = {
    ...defaultReadyBody.data.calculation,
  };
  delete snapshotCalculation.delivery;
  const snapshotData = {
    ...defaultReadyBody.data,
    calculation: snapshotCalculation,
  };
  const snapshotContract = {
    dataCutoffDate: snapshotCalculation.dataCutoffDate,
    periodFrom: snapshotCalculation.period.fromDate,
    periodTo: snapshotCalculation.period.toDate,
    dayCount: snapshotCalculation.period.dayCount,
    calculationVersion: "statistics-daily-v3",
  };
  const snapshotBatch =
    await snapshotStore.createStatisticsSnapshotBatch(
      prisma,
      snapshotContract
    );
  for (const domain of ["PURCHASE", "INVENTORY", "SALES", "RETURNS"]) {
    await snapshotStore.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: snapshotBatch.snapshot_batch_id,
      domain,
      data:
        domain === "INVENTORY"
          ? snapshotData
          : createStatisticsSnapshotFixture(
              domain,
              snapshotContract
            ),
    });
  }
  await snapshotStore.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: snapshotBatch.snapshot_batch_id,
  });
  const stored = await inventoryApi.GET(
    request("/api/statistics/inventory", tokens.get("LEADER"))
  );
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(
    storedBody.data.calculation.delivery.status,
    "SNAPSHOT_CURRENT"
  );
  assert.equal(storedBody.data.source.inventoryRowCount, 4);

  console.log(
    "Inventory statistics API auth, unsupported-search, empty, ready, partial, PII, and failure contracts verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
