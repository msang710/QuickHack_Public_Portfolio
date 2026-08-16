import assert from "node:assert/strict";
import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-purchase-statistics-evidence-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseDateTime(value) {
  if (value instanceof Date) return value;
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function authUser(user) {
  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.username,
    role: "LEADER",
    isDeveloper: true,
    mobilePackingEnabled: true,
  };
}

async function createInboundInspection(input) {
  const timestamp = databaseDateTime(input.timestamp);
  const inbound = await prisma.inbounds.create({
    data: {
      pg_no: input.pgNo,
      inbound_status: "INSPECTED",
      received_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.inspections.create({
    data: {
      pg_no: input.pgNo,
      inbound_id: inbound.inbound_id,
      inspection_type: "APPEARANCE",
      appearance_grade: input.appearanceGrade,
      appearance_checked_at: timestamp,
      checked_at: timestamp,
      return_yn: "N",
      created_at: timestamp,
    },
  });
  return inbound;
}

async function assertPurchasePriceEvidence(
  purchaseApi,
  purchaseExportApi,
  inspectionApi,
  correctionApi,
  ledgerApi,
  user
) {
  const timestamp = databaseDateTime("2026-07-28 09:00:00");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "purchase-evidence",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: 4, timestamp }
  );
  const appearanceGradeOption = await prisma.product_criteria_options.create({
    data: {
      category: "APPEARANCE_GRADE",
      option_key: "A",
      label: "A",
      parent_key: "",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const rate = await prisma.purchase_price_rates.create({
    data: {
      model_option_id: catalog.options.model.option_id,
      storage_option_id: catalog.options.storage.option_id,
      appearance_grade_option_id: appearanceGradeOption.option_id,
      price_date: new Date("2026-07-28T00:00:00.000Z"),
      purchase_price: 300000,
      note: "purchase evidence test",
      created_by_user_id: user.userId,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const rateInbound = await createInboundInspection({
    pgNo: devices[0].pgNo,
    appearanceGrade: "A",
    timestamp,
  });
  const overrideInbound = await createInboundInspection({
    pgNo: devices[1].pgNo,
    appearanceGrade: "A",
    timestamp,
  });

  const oldInbound = await prisma.inbounds.create({
    data: {
      pg_no: devices[2].pgNo,
      inbound_status: "INSPECTED",
      received_at: databaseDateTime("2026-07-27 09:00:00"),
      created_at: databaseDateTime("2026-07-27 09:00:00"),
      updated_at: databaseDateTime("2026-07-27 09:00:00"),
    },
  });
  const manualInbound = await createInboundInspection({
    pgNo: devices[2].pgNo,
    appearanceGrade: "B",
    timestamp,
  });
  await prisma.inspections.create({
    data: {
      pg_no: devices[2].pgNo,
      inbound_id: oldInbound.inbound_id,
      inspection_type: "APPEARANCE",
      appearance_grade: "A",
      appearance_checked_at: databaseDateTime("2026-07-28 09:01:00"),
      checked_at: databaseDateTime("2026-07-28 09:01:00"),
      return_yn: "N",
      created_at: databaseDateTime("2026-07-28 09:01:00"),
    },
  });

  await assert.rejects(
    purchaseApi.confirmInboundPurchases(
      prisma,
      {
        items: [
          {
            pgNo: devices[2].pgNo,
            expectedInboundId: manualInbound.inbound_id,
            expectedInboundRevision: manualInbound.revision,
            purchasePrice: 300000,
            purchasePriceRateId: rate.purchase_price_rate_id,
            purchasePriceRateRevision: rate.revision,
            purchasePriceQueryContext: {
              priceDate: "2026-07-28",
              note: rate.note,
            },
          },
        ],
      },
      user
    ),
    (error) => error?.code === "PURCHASE_PRICE_RATE_STALE",
    "A rate selected for a different current inspection grade was silently treated as manual evidence."
  );

  const result = await purchaseApi.confirmInboundPurchases(
    prisma,
    {
      items: [
        {
          pgNo: devices[0].pgNo,
          expectedInboundId: rateInbound.inbound_id,
          expectedInboundRevision: rateInbound.revision,
          purchasePrice: 300000,
          purchasePriceRateId: rate.purchase_price_rate_id,
          purchasePriceRateRevision: rate.revision,
          purchasePriceQueryContext: {
            priceDate: "2026-07-28",
            note: rate.note,
          },
        },
        {
          pgNo: devices[1].pgNo,
          expectedInboundId: overrideInbound.inbound_id,
          expectedInboundRevision: overrideInbound.revision,
          purchasePrice: 310000,
          purchasePriceRateId: rate.purchase_price_rate_id,
          purchasePriceRateRevision: rate.revision,
          purchasePriceQueryContext: {
            priceDate: "2026-07-28",
            note: rate.note,
          },
        },
        {
          pgNo: devices[2].pgNo,
          expectedInboundId: manualInbound.inbound_id,
          expectedInboundRevision: manualInbound.revision,
          purchasePrice: 300000,
          purchasePriceRateId: null,
          purchasePriceRateRevision: null,
          purchasePriceQueryContext: { priceDate: "", note: "" },
        },
      ],
    },
    user
  );
  assert.equal(result.confirmedCount, 3);

  const [rateRow, overrideRow, manualRow] = await Promise.all([
    prisma.inbounds.findUniqueOrThrow({
      where: { inbound_id: rateInbound.inbound_id },
    }),
    prisma.inbounds.findUniqueOrThrow({
      where: { inbound_id: overrideInbound.inbound_id },
    }),
    prisma.inbounds.findUniqueOrThrow({
      where: { inbound_id: manualInbound.inbound_id },
    }),
  ]);
  assert.equal(rateRow.purchase_price_entry_mode, "RATE");
  assert.equal(
    rateRow.purchase_price_reference_rate_id,
    rate.purchase_price_rate_id
  );
  assert.equal(rateRow.purchase_price_reference_amount, 300000);
  assert.equal(
    rateRow.purchase_price_updated_at?.getTime(),
    rate.updated_at.getTime()
  );
  assert.equal(overrideRow.purchase_price_entry_mode, "OVERRIDE");
  assert.equal(
    overrideRow.purchase_price_reference_rate_id,
    rate.purchase_price_rate_id
  );
  assert.equal(overrideRow.purchase_price_reference_amount, 300000);
  assert.notEqual(
    overrideRow.purchase_price_updated_at?.getTime(),
    rate.updated_at.getTime()
  );
  assert.equal(manualRow.purchase_price_entry_mode, "MANUAL");
  assert.equal(manualRow.purchase_price_reference_rate_id, null);
  assert.equal(manualRow.purchase_price_reference_amount, null);
  const postPurchasePgNo = "PP0000000001";
  const inspectedBeforePurchase = await inspectionApi.saveInspectionRecord(
    prisma,
    {
      PG: postPurchasePgNo,
      제품명: catalog.options.model.label,
      저장공간: catalog.options.storage.label,
      기기색상: catalog.options.color.label,
      외관등급: "A",
      외관검수자: "pre-purchase-tester",
      외관검수일시: "2026-07-28 09:10:00",
      기능하자: "없음",
      기능검수자: "pre-purchase-tester",
      기능검수일시: "2026-07-28 09:10:00",
      매입처반품유무: "N",
    },
    user.userId
  );
  assert.equal(inspectedBeforePurchase.status, "INSPECTED");

  const exportRequest = {
    kind: "purchase-statement",
    purchaseDate: "2026-07-28",
    supplierName: "purchase export test",
    items: [
      {
        pgNo: postPurchasePgNo,
        expectedInboundId: inspectedBeforePurchase.inbound_id,
        expectedInboundRevision: 1,
        purchasePrice: 300000,
        purchasePriceRateId: rate.purchase_price_rate_id,
        purchasePriceRateRevision: rate.revision,
        purchasePriceQueryContext: {
          priceDate: "2026-07-28",
          note: rate.note,
        },
      },
    ],
  };
  const exportWorkbook = await purchaseExportApi.buildPurchaseExportWorkbook(
    prisma,
    exportRequest
  );
  assert.ok(exportWorkbook.buffer.length > 0);

  const postPurchaseConfirmation = await purchaseApi.confirmInboundPurchases(
    prisma,
    {
      items: [
        {
          pgNo: postPurchasePgNo,
          expectedInboundId: inspectedBeforePurchase.inbound_id,
          expectedInboundRevision: 1,
          purchasePrice: 300000,
          purchasePriceRateId: rate.purchase_price_rate_id,
          purchasePriceRateRevision: rate.revision,
          purchasePriceQueryContext: {
            priceDate: "2026-07-28",
            note: rate.note,
          },
        },
      ],
    },
    user
  );
  assert.equal(postPurchaseConfirmation.confirmedCount, 1);
  await assert.rejects(
    purchaseExportApi.buildPurchaseExportWorkbook(prisma, exportRequest),
    (error) => error?.code === "PURCHASE_EXPORT_TARGET_CHANGED"
  );

  const postPurchaseInspection = await inspectionApi.saveInspectionRecord(
    prisma,
    {
      PG: postPurchasePgNo,
      제품명: catalog.options.model.label,
      저장공간: catalog.options.storage.label,
      기기색상: catalog.options.color.label,
      기능하자: "없음",
      기능검수자: "post-purchase-tester",
      기능검수일시: "2026-07-28 09:20:00",
      매입처반품유무: "N",
    },
    user.userId
  );
  assert.equal(
    postPurchaseInspection.status,
    "PURCHASED",
    "A deliberate post-purchase inspection correction regressed inbound status."
  );
  assert.equal(
    (
      await prisma.inbounds.findUniqueOrThrow({
        where: { inbound_id: inspectedBeforePurchase.inbound_id },
      })
    ).inbound_status,
    "PURCHASED"
  );
  assert.equal(
    await prisma.inspections.count({
      where: {
        pg_no: postPurchasePgNo,
        inbound_id: inspectedBeforePurchase.inbound_id,
        inspection_type: "FUNCTION",
      },
    }),
    2,
    "A post-purchase inspection correction was not preserved."
  );

  const repeatedConfirmation = await purchaseApi.confirmInboundPurchases(
    prisma,
    {
      items: [
        {
          pgNo: postPurchasePgNo,
          expectedInboundId: inspectedBeforePurchase.inbound_id,
          expectedInboundRevision: (
            await prisma.inbounds.findUniqueOrThrow({
              where: { inbound_id: inspectedBeforePurchase.inbound_id },
            })
          ).revision,
          purchasePrice: 300000,
          purchasePriceRateId: rate.purchase_price_rate_id,
          purchasePriceRateRevision: rate.revision,
          purchasePriceQueryContext: {
            priceDate: "2026-07-28",
            note: rate.note,
          },
        },
      ],
    },
    user
  );
  assert.equal(repeatedConfirmation.skippedCount, 1);
  assert.equal(repeatedConfirmation.confirmedCount, 0);

  const inboundBeforeCorrection = await prisma.inbounds.findUniqueOrThrow({
    where: { inbound_id: rateInbound.inbound_id },
  });
  await correctionApi.updateExistingInventoryRecord(
    prisma,
    devices[0].pgNo,
    {
      editReason: "purchase evidence correction",
      patches: [
        {
          recordKind: "inbound",
          recordId: rateInbound.inbound_id,
          expectedRevision: inboundBeforeCorrection.revision,
          fieldKey: "purchase_price",
          expectedValue: inboundBeforeCorrection.purchase_price,
          nextValue: 320000,
        },
      ],
    },
    user
  );
  const corrected = await prisma.inbounds.findUniqueOrThrow({
    where: { inbound_id: rateInbound.inbound_id },
  });
  assert.equal(corrected.purchase_price, 320000);
  assert.equal(corrected.purchase_price_entry_mode, "MANUAL");
  assert.equal(corrected.purchase_price_reference_rate_id, null);
  assert.equal(corrected.purchase_price_reference_amount, null);

  await prisma.purchase_price_rates.delete({
    where: { purchase_price_rate_id: rate.purchase_price_rate_id },
  });
  const preservedOverride = await prisma.inbounds.findUniqueOrThrow({
    where: { inbound_id: overrideInbound.inbound_id },
  });
  assert.equal(preservedOverride.purchase_price_reference_rate_id, null);
  assert.equal(preservedOverride.purchase_price_reference_amount, 300000);
  assert.equal(preservedOverride.purchase_price_entry_mode, "OVERRIDE");

  const sequencePgNos = ["SQ0000000001", "SQ0000000002"];
  await Promise.all(
    sequencePgNos.map((pgNo, index) =>
      inspectionApi.saveInspectionRecord(
        prisma,
        {
          PG: pgNo,
          제품명: catalog.options.model.label,
          저장공간: catalog.options.storage.label,
          기기색상: catalog.options.color.label,
          외관등급: "A",
          외관검수자: `sequence-${index + 1}`,
          외관검수일시: `2026-07-28 09:${30 + index}:00`,
          기능하자: "없음",
          기능검수자: `sequence-${index + 1}`,
          기능검수일시: `2026-07-28 09:${30 + index}:00`,
          매입처반품유무: "N",
        },
        user.userId
      )
    )
  );
  const sequenceInbounds = await prisma.inbounds.findMany({
    where: { pg_no: { in: sequencePgNos } },
    orderBy: { pg_no: "asc" },
  });
  const sequenceResults = await Promise.all(
    sequenceInbounds.map((inbound) =>
      purchaseApi.confirmInboundPurchases(
        prisma,
        {
          items: [
            {
              pgNo: inbound.pg_no,
              expectedInboundId: inbound.inbound_id,
              expectedInboundRevision: inbound.revision,
              purchasePrice: 310000,
              purchasePriceRateId: null,
              purchasePriceRateRevision: null,
              purchasePriceQueryContext: { priceDate: "", note: "" },
            },
          ],
        },
        user
      )
    )
  );
  assert.deepEqual(
    sequenceResults.map((result) => result.confirmedCount),
    [1, 1],
    "Concurrent purchases for the same model did not both commit."
  );
  const allocatedSequences = (
    await prisma.devices.findMany({
      where: { pg_no: { in: sequencePgNos } },
      orderBy: { pg_no: "asc" },
      select: { model_seq: true },
    })
  ).map((device) => device.model_seq);
  assert.equal(new Set(allocatedSequences).size, 2);
  assert.ok(allocatedSequences.every((sequence) => Number.isInteger(sequence)));

  return catalog;
}

async function assertInspectionEvidence(inspectionApi, purchaseApi, user) {
  const concurrentPgNo = "CI0000000001";
  await Promise.all([
    inspectionApi.saveInspectionRecord(
      prisma,
      {
        PG: concurrentPgNo,
        제품명: "Concurrent Inspection Model",
        저장공간: "128GB",
        외관등급: "A",
        외관검수자: "appearance-worker",
        외관검수일시: "2026-07-28 09:40:00",
        매입처반품유무: "N",
      },
      user.userId
    ),
    inspectionApi.saveInspectionRecord(
      prisma,
      {
        PG: concurrentPgNo,
        제품명: "Concurrent Inspection Model",
        저장공간: "128GB",
        기능하자: "없음",
        기능검수자: "function-worker",
        기능검수일시: "2026-07-28 09:40:01",
        매입처반품유무: "N",
      },
      user.userId
    ),
  ]);
  const concurrentInbounds = await prisma.inbounds.findMany({
    where: { pg_no: concurrentPgNo },
  });
  assert.equal(
    concurrentInbounds.length,
    1,
    "Concurrent first inspections created more than one inbound cycle."
  );
  const concurrentInspections = await prisma.inspections.findMany({
    where: { pg_no: concurrentPgNo },
  });
  assert.equal(concurrentInspections.length, 2);
  assert.ok(
    concurrentInspections.every(
      (inspection) => inspection.inbound_id === concurrentInbounds[0].inbound_id
    )
  );
  assert.equal(concurrentInbounds[0].inbound_status, "INSPECTED");

  const supplierReturnPgNo = "SR0000000001";
  await inspectionApi.saveInspectionRecord(prisma, {
    PG: supplierReturnPgNo,
    제품명: "Supplier Return Model",
    저장공간: "128GB",
    외관등급: "A",
    외관검수자: "tester",
    외관검수일시: "2026-07-28 10:00:00",
    매입처반품유무: "Y",
  });
  const supplierReturnInbound = await prisma.inbounds.findFirstOrThrow({
    where: { pg_no: supplierReturnPgNo },
    orderBy: { inbound_id: "desc" },
  });
  const firstSupplierReturnedAt = supplierReturnInbound.supplier_returned_at;
  assert.equal(supplierReturnInbound.inbound_status, "SUPPLIER_RETURN");
  assert.ok(firstSupplierReturnedAt);
  const supplierReturnInspections = await prisma.inspections.findMany({
    where: { pg_no: supplierReturnPgNo },
  });
  assert.equal(supplierReturnInspections.length, 1);
  assert.equal(
    supplierReturnInspections[0].inbound_id,
    supplierReturnInbound.inbound_id
  );

  await inspectionApi.saveInspectionRecord(prisma, {
    PG: supplierReturnPgNo,
    제품명: "Supplier Return Model",
    저장공간: "128GB",
    기능하자: "없음",
    기능검수자: "tester",
    기능검수일시: "2026-07-28 10:05:00",
    매입처반품유무: "N",
  });
  const supplierReturnAfterRetry = await prisma.inbounds.findUniqueOrThrow({
    where: { inbound_id: supplierReturnInbound.inbound_id },
  });
  assert.equal(
    supplierReturnAfterRetry.supplier_returned_at?.getTime(),
    firstSupplierReturnedAt.getTime(),
    "A later inspection rewrote the first supplier-return timestamp."
  );

  const supplierReturnPurchase = await purchaseApi.confirmInboundPurchases(
    prisma,
    {
      items: [
        {
          pgNo: supplierReturnPgNo,
          expectedInboundId: supplierReturnAfterRetry.inbound_id,
          expectedInboundRevision: supplierReturnAfterRetry.revision,
          purchasePrice: 100000,
          purchasePriceRateId: null,
          purchasePriceRateRevision: null,
          purchasePriceQueryContext: {
            priceDate: "2026-07-28",
            note: "",
          },
        },
      ],
    },
    user
  );
  assert.equal(supplierReturnPurchase.conflictCount, 1);
  assert.equal(
    await prisma.inventory.count({ where: { pg_no: supplierReturnPgNo } }),
    0,
    "A supplier-return conflict created sellable inventory."
  );

  const cyclePgNo = "CY0000000001";
  const firstCycle = await inspectionApi.saveInspectionRecord(prisma, {
    PG: cyclePgNo,
    제품명: "Cycle Model",
    저장공간: "128GB",
    외관등급: "A",
    외관검수자: "tester",
    외관검수일시: "2026-07-28 11:00:00",
    매입처반품유무: "N",
  });
  const secondInbound = await prisma.inbounds.create({
    data: {
      pg_no: cyclePgNo,
      inbound_status: "RECEIVED",
      received_at: databaseDateTime("2026-07-28 11:05:00"),
      created_at: databaseDateTime("2026-07-28 11:05:00"),
      updated_at: databaseDateTime("2026-07-28 11:05:00"),
    },
  });
  const secondCycle = await inspectionApi.saveInspectionRecord(prisma, {
    PG: cyclePgNo,
    제품명: "Cycle Model",
    저장공간: "128GB",
    기능하자: "없음",
    기능검수자: "tester",
    기능검수일시: "2026-07-28 11:10:00",
    매입처반품유무: "N",
  });
  assert.equal(firstCycle.status, "INSPECTING");
  assert.equal(secondCycle.inbound_id, secondInbound.inbound_id);
  assert.equal(
    secondCycle.status,
    "INSPECTING",
    "Inspections from different inbound cycles were combined."
  );
  const secondCycleInspection = await prisma.inspections.findUniqueOrThrow({
    where: { inspection_id: secondCycle.inspection_id },
  });
  assert.equal(secondCycleInspection.inbound_id, secondInbound.inbound_id);

  const legacyPgNo = "LG0000000001";
  await prisma.devices.create({
    data: {
      pg_no: legacyPgNo,
      model: "Legacy Model",
      storage: "128GB",
    },
  });
  const legacyInbound = await prisma.inbounds.create({
    data: {
      pg_no: legacyPgNo,
      inbound_status: "RECEIVED",
      received_at: databaseDateTime("2026-07-28 12:00:00"),
      created_at: databaseDateTime("2026-07-28 12:00:00"),
      updated_at: databaseDateTime("2026-07-28 12:00:00"),
    },
  });
  await assert.rejects(
    prisma.inspections.create({
      data: {
        pg_no: legacyPgNo,
        inbound_id: null,
        inspection_type: "APPEARANCE",
        appearance_grade: "A",
        appearance_checked_at: databaseDateTime("2026-07-28 12:00:00"),
        checked_at: databaseDateTime("2026-07-28 12:00:00"),
        return_yn: "N",
        created_at: databaseDateTime("2026-07-28 12:00:00"),
      },
    })
  );
  await inspectionApi.saveInspectionRecord(prisma, {
    PG: legacyPgNo,
    제품명: "Legacy Model",
    저장공간: "128GB",
    외관등급: "A",
    외관검수자: "tester",
    외관검수일시: "2026-07-28 12:00:00",
    매입처반품유무: "N",
  });
  const linkedInspection = await prisma.inspections.findFirstOrThrow({
    where: { pg_no: legacyPgNo },
  });
  assert.equal(linkedInspection.inbound_id, legacyInbound.inbound_id);
  assert.equal(await prisma.inspections.count({ where: { pg_no: legacyPgNo } }), 1);
}

async function assertManualInventoryEvidence(inventoryApi, catalog, user) {
  const pgNo = "MN0000000001";
  await assert.rejects(
    inventoryApi.createManualInventoryRecord(
      prisma,
      {
        pgNo,
        model: catalog.options.model.label,
        inboundStatus: "SUPPLIER_RETURN",
        inventoryStatus: "SELLABLE",
        reason: "invalid manual state pair",
      },
      user
    ),
    (error) => error?.code === "INVENTORY_INPUT_INVALID"
  );
  assert.equal(await prisma.devices.count({ where: { pg_no: pgNo } }), 0);

  await inventoryApi.createManualInventoryRecord(
    prisma,
    {
      pgNo,
      model: catalog.options.model.label,
      modelCode: catalog.options.model.option_key,
      storage: catalog.options.storage.label,
      color: catalog.options.color.label,
      saleGrade: catalog.options.grade.option_key,
      purchasePrice: "275000",
      supplierName: "manual supplier",
      inboundStatus: "PURCHASED",
      inventoryStatus: "SELLABLE",
      appearanceGrade: "A",
      appearanceWorker: "tester",
      appearanceCheckedAt: "2026-07-28 13:00:00",
      reason: "manual purchase evidence test",
    },
    user
  );
  const inbound = await prisma.inbounds.findFirstOrThrow({
    where: { pg_no: pgNo },
    orderBy: { inbound_id: "desc" },
  });
  const inspection = await prisma.inspections.findFirstOrThrow({
    where: { pg_no: pgNo },
  });
  assert.equal(inbound.purchase_price_entry_mode, "MANUAL");
  assert.equal(inbound.inbound_status, "PURCHASED");
  assert.equal(inbound.supplier_returned_at, null);
  assert.equal(inspection.inbound_id, inbound.inbound_id);

  const device = await prisma.devices.findUniqueOrThrow({
    where: { pg_no: pgNo },
  });
  const auditSession = await prisma.inventory_audit_sessions.create({
    data: {
      audit_base_date: new Date("2026-07-28T00:00:00.000Z"),
      audit_period_from: new Date("2026-07-28T00:00:00.000Z"),
      audit_period_to: new Date("2026-07-28T00:00:00.000Z"),
      changed_count: 1,
      created_by_user_id: user.userId,
    },
  });
  const auditChange = await prisma.inventory_audit_location_changes.create({
    data: {
      inventory_audit_session_id: auditSession.inventory_audit_session_id,
      pg_no: pgNo,
      previous_location: "상품화 대기",
      new_location: "A-01",
    },
  });
  await assert.rejects(
    inventoryApi.deleteManualInventoryRecord(
      prisma,
      pgNo,
      {
        reason: "relation-aware delete conflict",
        expectedRevision: device.revision,
      },
      user
    ),
    (error) => error?.code === "INVENTORY_DELETE_CONFLICT"
  );
  assert.equal(
    (
      await prisma.inventory_audit_location_changes.findUniqueOrThrow({
        where: {
          inventory_audit_location_change_id:
            auditChange.inventory_audit_location_change_id,
        },
      })
    ).pg_no,
    pgNo,
    "A rejected delete detached its audit relation."
  );
  await prisma.inventory_audit_location_changes.delete({
    where: {
      inventory_audit_location_change_id:
        auditChange.inventory_audit_location_change_id,
    },
  });
  await prisma.inventory_audit_sessions.delete({
    where: {
      inventory_audit_session_id: auditSession.inventory_audit_session_id,
    },
  });
  await inventoryApi.deleteManualInventoryRecord(
    prisma,
    pgNo,
    {
      reason: "manual inventory delete boundary",
      expectedRevision: device.revision,
    },
    user
  );
  assert.equal(await prisma.devices.count({ where: { pg_no: pgNo } }), 0);
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const purchaseApi = await import(
    "@/quickhack_server/inbound/purchase-confirm-service"
  );
  const purchaseExportApi = await import(
    "@/quickhack_server/inbound/purchase-export-service"
  );
  const inspectionApi = await import(
    "@/quickhack_server/inspection/inspection-save-service"
  );
  const inventoryApi = await import(
    "@/quickhack_server/inventory/inventory-management-service"
  );
  const correctionApi = await import(
    "@/quickhack_server/inventory/inventory-correction-command-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const userRow = await prisma.users.create({
    data: {
      username: "purchase-evidence-user",
      password_hash: "test-only",
      role: "LEADER",
      created_at: databaseDateTime("2026-07-28 08:00:00"),
      updated_at: databaseDateTime("2026-07-28 08:00:00"),
    },
  });
  const user = authUser(userRow);

  const catalog = await assertPurchasePriceEvidence(
    purchaseApi,
    purchaseExportApi,
    inspectionApi,
    correctionApi,
    ledgerApi,
    user
  );
  await assertInspectionEvidence(inspectionApi, purchaseApi, user);
  await assertManualInventoryEvidence(inventoryApi, catalog, user);
  console.log(
    "Purchase price, inbound inspection, supplier-return, and manual evidence verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
