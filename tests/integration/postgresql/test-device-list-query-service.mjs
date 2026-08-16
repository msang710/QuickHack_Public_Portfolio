import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-device-list-query-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
const kstDateTime = (value) => new Date(`${value.replace(" ", "T")}+09:00`);

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    parseDeviceListQuery,
    queryDeviceListPage,
  } = await import(
    "@/quickhack_server/inventory/device-list-query-service"
  );
  const { getDeviceDetailByPgNo } = await import(
    "@/quickhack_server/inventory/devices-service"
  );
  const { DEVICE_LIST_CONTEXT, DEVICE_LIST_SORT_KEYS } = await import(
    "@/quickhack_shared/device/device-list-query"
  );

  const batch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-08-01T00:00:00.000Z"),
      batch_no: 1,
      expected_quantity: 105,
    },
  });

  await prisma.devices.createMany({
    data: Array.from({ length: 105 }, (_, index) => {
      const sequence = index + 1;
      return {
        pg_no: `PG${String(sequence).padStart(4, "0")}`,
        imei:
          sequence <= 30
            ? null
            : `359999${String(sequence).padStart(9, "0")}`,
        model: sequence % 2 === 0 ? "Galaxy S24" : "Galaxy S23",
        model_seq: sequence,
        storage: sequence % 2 === 0 ? "256GB" : "128GB",
        color: sequence % 2 === 0 ? "Black" : "Blue",
        sale_grade: sequence % 3 === 0 ? "B" : "A",
        warranty: "2Y",
        created_at: kstDateTime(`2026-08-01 09:${String(sequence % 60).padStart(2, "0")}:00`),
        updated_at: kstDateTime(`2026-08-01 09:${String(sequence % 60).padStart(2, "0")}:00`),
      };
    }),
  });

  await prisma.inbounds.createMany({
    data: Array.from({ length: 105 }, (_, index) => {
      const sequence = index + 1;
      return {
        pg_no: `PG${String(sequence).padStart(4, "0")}`,
        inbound_batch_id: batch.inbound_batch_id,
        supplier_name: sequence === 1 ? "Current Supplier" : "Supplier",
        purchase_price: 100_000 + sequence,
        received_at: kstDateTime("2026-08-01 09:00:00"),
        inbound_status: sequence <= 3 ? "INSPECTED" : "PURCHASED",
      };
    }),
  });
  const latestInbound = await prisma.inbounds.create({
    data: {
      pg_no: "PG0001",
      inbound_batch_id: batch.inbound_batch_id,
      supplier_name: "Latest Supplier",
      purchase_price: 200_000,
      received_at: kstDateTime("2026-08-01 10:00:00"),
      inbound_status: "INSPECTED",
    },
  });

  await prisma.inventory.createMany({
    data: Array.from({ length: 105 }, (_, index) => {
      const sequence = index + 1;
      return {
        pg_no: `PG${String(sequence).padStart(4, "0")}`,
        inventory_status: sequence <= 4 ? "SELLABLE" : "HOLD",
        location: sequence <= 4 ? "A-01" : "B-01",
        stocked_at: kstDateTime("2026-08-01 11:00:00"),
      };
    }),
  });
  await prisma.inspections.createMany({
    data: [
      {
        pg_no: "PG0001",
        inbound_id: latestInbound.inbound_id,
        inspection_type: "APPEARANCE",
        appearance_grade: "A",
        appearance_defect: "none",
        appearance_checked_at: kstDateTime("2026-08-01 10:10:00"),
      },
      {
        pg_no: "PG0001",
        inbound_id: latestInbound.inbound_id,
        inspection_type: "FUNCTION",
        function_defect: "none",
        function_checked_at: kstDateTime("2026-08-01 10:20:00"),
      },
    ],
  });

  const defaultPage = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.inventory,
  });
  assert.equal(defaultPage.items.length, 100);
  assert.equal(defaultPage.hasMore, true);
  assert.ok(defaultPage.nextCursor);

  const firstPage = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.inventory,
    sort: "pgNo",
    direction: "asc",
    limit: 25,
  });
  assert.equal(firstPage.items.length, 25);
  assert.equal(firstPage.items[0]?.pgNo, "PG0001");
  assert.equal(firstPage.items.at(-1)?.pgNo, "PG0025");
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  assert.equal("inspections" in firstPage.items[0], false);
  assert.equal("orders" in firstPage.items[0], false);
  assert.equal("detailRecords" in firstPage.items[0], false);

  const secondPage = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.inventory,
    sort: "pgNo",
    direction: "asc",
    limit: 25,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items[0]?.pgNo, "PG0026");
  assert.equal(
    firstPage.items.some((item) =>
      secondPage.items.some((next) => next.pgNo === item.pgNo)
    ),
    false
  );

  const imeiSortedPgNos = [];
  let imeiCursor = null;
  do {
    const page = await queryDeviceListPage({
      context: DEVICE_LIST_CONTEXT.inventory,
      sort: "imei",
      direction: "asc",
      limit: 20,
      cursor: imeiCursor,
    });
    imeiSortedPgNos.push(...page.items.map((item) => item.pgNo));
    imeiCursor = page.nextCursor;
  } while (imeiCursor);
  assert.equal(imeiSortedPgNos.length, 105);
  assert.equal(new Set(imeiSortedPgNos).size, 105);
  assert.equal(
    imeiSortedPgNos.slice(-30).every((pgNo) => Number(pgNo.slice(2)) <= 30),
    true
  );

  for (const sort of DEVICE_LIST_SORT_KEYS) {
    for (const direction of ["asc", "desc"]) {
      const pgNos = [];
      let cursor = null;
      do {
        const page = await queryDeviceListPage({
          context: DEVICE_LIST_CONTEXT.inventory,
          sort,
          direction,
          limit: 17,
          cursor,
        });
        pgNos.push(...page.items.map((item) => item.pgNo));
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(pgNos.length, 105, `${sort}/${direction} skipped a row`);
      assert.equal(
        new Set(pgNos).size,
        105,
        `${sort}/${direction} returned a duplicate row`
      );
    }
  }

  const latestSupplier = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.inventory,
    search: "Latest Supplier",
  });
  assert.deepEqual(latestSupplier.items.map((item) => item.pgNo), ["PG0001"]);
  const supersededSupplier = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.inventory,
    search: "Current Supplier",
  });
  assert.equal(supersededSupplier.items.length, 0);

  const auditCandidates = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.audit,
    sort: "pgNo",
    direction: "asc",
  });
  assert.deepEqual(
    auditCandidates.items.map((item) => item.pgNo),
    ["PG0001", "PG0002", "PG0003", "PG0004"]
  );

  const purchasePending = await queryDeviceListPage({
    context: DEVICE_LIST_CONTEXT.purchasePending,
    sort: "pgNo",
    direction: "asc",
  });
  assert.deepEqual(
    purchasePending.items.map((item) => item.pgNo),
    ["PG0001", "PG0002", "PG0003"]
  );
  assert.equal(purchasePending.items[0]?.inbound?.supplierName, "Latest Supplier");
  assert.equal(purchasePending.items[0]?.appearanceGrade, "A");
  assert.equal(purchasePending.items[0]?.functionDefect, "none");

  const detail = await getDeviceDetailByPgNo("pg0001");
  assert.equal(detail?.pgNo, "PG0001");
  assert.ok(Array.isArray(detail?.inspections));
  assert.ok(Array.isArray(detail?.orders));
  assert.ok(detail?.detailRecords);

  assert.throws(
    () =>
      parseDeviceListQuery({
        context: DEVICE_LIST_CONTEXT.inventory,
        sort: "pgNo",
        direction: "asc",
        cursor: "not-a-cursor",
      }),
    (error) => error?.code === "DEVICE_LIST_CURSOR_INVALID"
  );

  const indexRows = await prisma.$queryRawUnsafe(`
    SELECT indexname AS name
    FROM pg_catalog.pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN ('devices', 'inbounds', 'inspections', 'inventory')
  `);
  const indexNames = new Set(indexRows.map((row) => String(row.name)));
  for (const expected of [
    "idx_devices_updated_latest",
    "idx_inbounds_status_pg_latest",
    "idx_inbounds_pg_no",
    "idx_inspections_pg_type_latest",
    "idx_inventory_status_pg",
  ]) {
    assert.ok(indexNames.has(expected), `Missing query index: ${expected}`);
  }

  console.log("Device list query service verified.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
