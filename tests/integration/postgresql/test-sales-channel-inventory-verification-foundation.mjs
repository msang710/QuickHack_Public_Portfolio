import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inventory-verification-foundation-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

async function expectBlocked(database, label, statement, expectedMessage) {
  try {
    await database.exec(statement);
    assert.fail(`${label} was not blocked.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.endsWith("was not blocked.")) throw error;
    assert.match(message, new RegExp(expectedMessage), label);
  }
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    calculateMappedOfferSellableQuantity,
    INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS,
  } = await import(
    "@/quickhack_server/sales-channel/inventory-quantity-projection-service"
  );
  const {
    beginCoupangApiCallLog,
    completeCoupangApiCallLog,
    failCoupangApiCallLog,
    markCoupangApiCallProcessing,
    markCoupangApiCallReceived,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/api-call-log-service"
  );

  async function createOption(category, optionKey) {
    const existing = await prisma.product_criteria_options.findFirst({
      where: {
        category,
        option_key: optionKey,
        parent_key: "",
      },
    });

    if (existing) return existing;

    return prisma.product_criteria_options.create({
      data: {
        category,
        option_key: optionKey,
        label: optionKey,
      },
    });
  }

  const [
    model,
    otherModel,
    emptyModel,
    storage128,
    storage256,
    black,
    blue,
    gradeA,
    gradeAMinus,
    gradeBPlus,
    gradeB,
    warranty2Y,
    invalidWarranty,
  ] = await Promise.all([
    createOption("PRODUCT_MODEL", "MODEL-1"),
    createOption("PRODUCT_MODEL", "MODEL-2"),
    createOption("PRODUCT_MODEL", "MODEL-EMPTY"),
    createOption("STORAGE", "128GB"),
    createOption("STORAGE", "256GB"),
    createOption("DEVICE_COLOR", "BLACK"),
    createOption("DEVICE_COLOR", "BLUE"),
    createOption("SALE_GRADE", "A"),
    createOption("SALE_GRADE", "A-"),
    createOption("SALE_GRADE", "B+"),
    createOption("SALE_GRADE", "B"),
    createOption("WARRANTY_GROUP", "2Y"),
    createOption("WARRANTY_GROUP", "9Y"),
  ]);

  async function createOffer(input) {
    return prisma.sales_offers.create({
      data: {
        offer_code: input.offerCode,
        model_option_id: input.modelOptionId,
        storage_match_mode: input.storageMatchMode,
        storage_option_id: input.storageOptionId ?? null,
        color_match_mode: input.colorMatchMode,
        color_option_id: input.colorOptionId ?? null,
        warranty_group_option_id: input.warrantyGroupOptionId,
        is_active: input.isActive ?? 1,
      },
    });
  }

  const exactOffer = await createOffer({
    offerCode: "OFFER-EXACT",
    modelOptionId: model.option_id,
    storageMatchMode: "EXACT",
    storageOptionId: storage128.option_id,
    colorMatchMode: "EXACT",
    colorOptionId: black.option_id,
    warrantyGroupOptionId: warranty2Y.option_id,
  });
  const randomOffer = await createOffer({
    offerCode: "OFFER-RANDOM",
    modelOptionId: model.option_id,
    storageMatchMode: "RANDOM",
    colorMatchMode: "ANY",
    warrantyGroupOptionId: warranty2Y.option_id,
  });
  const emptyOffer = await createOffer({
    offerCode: "OFFER-EMPTY",
    modelOptionId: emptyModel.option_id,
    storageMatchMode: "ANY",
    colorMatchMode: "ANY",
    warrantyGroupOptionId: warranty2Y.option_id,
  });
  const inactiveOffer = await createOffer({
    offerCode: "OFFER-INACTIVE",
    modelOptionId: model.option_id,
    storageMatchMode: "ANY",
    colorMatchMode: "ANY",
    warrantyGroupOptionId: warranty2Y.option_id,
    isActive: 0,
  });
  const invalidWarrantyOffer = await createOffer({
    offerCode: "OFFER-INVALID-WARRANTY",
    modelOptionId: model.option_id,
    storageMatchMode: "ANY",
    colorMatchMode: "ANY",
    warrantyGroupOptionId: invalidWarranty.option_id,
  });

  async function createMapping(externalVendorItemId, offer, status = "MAPPED") {
    return prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: externalVendorItemId,
        external_option_name: externalVendorItemId,
        sales_offer_id: offer?.sales_offer_id ?? null,
        mapping_status: status,
      },
    });
  }

  const exactMapping = await createMapping("VENDOR-EXACT", exactOffer);
  const duplicateMapping = await createMapping("VENDOR-EXACT-DUP", exactOffer);
  const randomMapping = await createMapping("VENDOR-RANDOM", randomOffer);
  const emptyMapping = await createMapping("VENDOR-EMPTY", emptyOffer);
  const unmappedMapping = await createMapping("VENDOR-UNMAPPED", null, "UNMAPPED");
  const inactiveMapping = await createMapping("VENDOR-INACTIVE", inactiveOffer);
  const invalidWarrantyMapping = await createMapping(
    "VENDOR-INVALID-WARRANTY",
    invalidWarrantyOffer
  );

  async function createSku(input) {
    return prisma.inventory_skus.create({
      data: {
        sku_code: input.skuCode,
        model_option_id: input.modelOptionId,
        storage_option_id: input.storageOptionId,
        color_option_id: input.colorOptionId,
        sale_grade_option_id: input.saleGradeOptionId,
        is_active: input.isActive ?? 1,
        deactivated_at:
          input.isActive === 0 ? new Date("2026-08-01T11:00:00+09:00") : null,
      },
    });
  }

  async function createBalance(sku, inventoryStatus, quantity) {
    return prisma.inventory_quantity_balances.create({
      data: {
        inventory_sku_id: sku.inventory_sku_id,
        inventory_status: inventoryStatus,
        quantity,
      },
    });
  }

  const skuA = await createSku({
    skuCode: "SKU-A",
    modelOptionId: model.option_id,
    storageOptionId: storage128.option_id,
    colorOptionId: black.option_id,
    saleGradeOptionId: gradeA.option_id,
  });
  const skuAMinus = await createSku({
    skuCode: "SKU-A-MINUS",
    modelOptionId: model.option_id,
    storageOptionId: storage128.option_id,
    colorOptionId: black.option_id,
    saleGradeOptionId: gradeAMinus.option_id,
  });
  const skuBPlus = await createSku({
    skuCode: "SKU-B-PLUS",
    modelOptionId: model.option_id,
    storageOptionId: storage128.option_id,
    colorOptionId: black.option_id,
    saleGradeOptionId: gradeBPlus.option_id,
  });
  const skuB = await createSku({
    skuCode: "SKU-B",
    modelOptionId: model.option_id,
    storageOptionId: storage128.option_id,
    colorOptionId: black.option_id,
    saleGradeOptionId: gradeB.option_id,
  });
  const skuRandomBucket = await createSku({
    skuCode: "SKU-RANDOM-BUCKET",
    modelOptionId: model.option_id,
    storageOptionId: storage256.option_id,
    colorOptionId: blue.option_id,
    saleGradeOptionId: gradeA.option_id,
  });
  const skuOtherModel = await createSku({
    skuCode: "SKU-OTHER-MODEL",
    modelOptionId: otherModel.option_id,
    storageOptionId: storage128.option_id,
    colorOptionId: black.option_id,
    saleGradeOptionId: gradeA.option_id,
  });
  const inactiveSku = await createSku({
    skuCode: "SKU-INACTIVE",
    modelOptionId: model.option_id,
    storageOptionId: storage128.option_id,
    colorOptionId: blue.option_id,
    saleGradeOptionId: gradeA.option_id,
    isActive: 0,
  });

  await Promise.all([
    createBalance(skuA, "SELLABLE", 2),
    createBalance(skuA, "RESERVED", 9),
    createBalance(skuAMinus, "SELLABLE", 3),
    createBalance(skuBPlus, "SELLABLE", 4),
    createBalance(skuB, "SELLABLE", 5),
    createBalance(skuRandomBucket, "SELLABLE", 6),
    createBalance(skuOtherModel, "SELLABLE", 7),
    createBalance(inactiveSku, "SELLABLE", 8),
  ]);

  const exactProjection = await calculateMappedOfferSellableQuantity(
    exactMapping.mapping_id
  );
  assert.equal(exactProjection.status, "PROJECTED");
  assert.equal(exactProjection.ledgerQuantity, 9);
  assert.deepEqual(
    [...exactProjection.eligibleSaleGrades].sort(),
    ["A", "A-", "B+"].sort()
  );

  const duplicateProjection = await calculateMappedOfferSellableQuantity(
    duplicateMapping.mapping_id
  );
  assert.equal(duplicateProjection.status, "PROJECTED");
  assert.equal(duplicateProjection.ledgerQuantity, 9);

  const randomProjection = await calculateMappedOfferSellableQuantity(
    randomMapping.mapping_id
  );
  assert.equal(randomProjection.status, "PROJECTED");
  assert.equal(randomProjection.ledgerQuantity, 15);

  const emptyProjection = await calculateMappedOfferSellableQuantity(
    emptyMapping.mapping_id
  );
  assert.equal(emptyProjection.status, "PROJECTED");
  assert.equal(emptyProjection.ledgerQuantity, 0);

  const missingProjection = await calculateMappedOfferSellableQuantity(999_999);
  assert.equal(missingProjection.status, "SKIPPED");
  assert.equal(
    missingProjection.skipReason,
    INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.mappingNotFound
  );

  const unmappedProjection = await calculateMappedOfferSellableQuantity(
    unmappedMapping.mapping_id
  );
  assert.equal(unmappedProjection.status, "SKIPPED");
  assert.equal(
    unmappedProjection.skipReason,
    INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.mappingNotActive
  );

  const inactiveProjection = await calculateMappedOfferSellableQuantity(
    inactiveMapping.mapping_id
  );
  assert.equal(inactiveProjection.status, "SKIPPED");
  assert.equal(
    inactiveProjection.skipReason,
    INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.salesOfferNotActive
  );

  const invalidWarrantyProjection = await calculateMappedOfferSellableQuantity(
    invalidWarrantyMapping.mapping_id
  );
  assert.equal(invalidWarrantyProjection.status, "SKIPPED");
  assert.equal(
    invalidWarrantyProjection.skipReason,
    INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.invalidWarrantyGroup
  );

  const timestamp = new Date("2026-08-01T12:00:00+09:00");
  const successfulLogId = await beginCoupangApiCallLog({
    apiName: "GET_PRODUCT_QUANTITY_PRICE_STATUS",
    externalVendorItemId: exactMapping.external_vendor_item_id,
    pageToken: "secret-page-token",
    requestStartedAt: timestamp,
  });
  await markCoupangApiCallReceived({
    apiCallLogId: successfulLogId,
    endpointPath: `/vendor-items/${exactMapping.external_vendor_item_id}/inventories`,
    httpStatusCode: 200,
    externalResponseCode: "SUCCESS",
    responseHash: "safe-response-hash",
    receivedAt: timestamp,
  });
  await markCoupangApiCallProcessing({
    apiCallLogId: successfulLogId,
    responseRowCount: 1,
    processingStartedAt: timestamp,
  });
  await prisma.$transaction((tx) =>
    completeCoupangApiCallLog(tx, {
      apiCallLogId: successfulLogId,
      processedRowCount: 1,
      processedAt: timestamp,
    })
  );

  const successfulLog = await prisma.coupang_api_call_log.findUniqueOrThrow({
    where: { coupang_api_call_log_id: successfulLogId },
  });
  assert.equal(successfulLog.processed_status, "SUCCESS");
  assert.equal(
    successfulLog.external_vendor_item_id,
    exactMapping.external_vendor_item_id
  );
  assert.equal(successfulLog.page_token_hash?.length, 64);
  assert.notEqual(successfulLog.page_token_hash, "secret-page-token");

  const failedLogId = await beginCoupangApiCallLog({
    apiName: "GET_PRODUCT_QUANTITY_PRICE_STATUS",
    externalVendorItemId: "VENDOR-FAILURE",
    requestStartedAt: timestamp,
  });
  const failure = new Error("safe test failure");
  failure.name = "TimeoutError";
  await failCoupangApiCallLog(failedLogId, failure);
  const failedLog = await prisma.coupang_api_call_log.findUniqueOrThrow({
    where: { coupang_api_call_log_id: failedLogId },
  });
  assert.equal(failedLog.processed_status, "FAILED");
  assert.equal(failedLog.error_code, "TimeoutError");

  const verificationState =
    await prisma.sales_channel_inventory_verification_states.create({
      data: {
        mapping_id: exactMapping.mapping_id,
        channel: exactMapping.channel,
        external_vendor_item_id: exactMapping.external_vendor_item_id,
        sales_offer_id: exactOffer.sales_offer_id,
        verification_status: "MATCHED",
        ledger_quantity: 9,
        channel_quantity: 9,
        last_checked_at: timestamp,
        last_api_call_log_id: successfulLogId,
      },
    });
  assert.equal(verificationState.ledger_quantity, 9);
  assert.equal(verificationState.pending_order_quantity, 0);
  assert.equal(verificationState.state_revision, 1);

  await prisma.$disconnect();
  prisma = null;

  const database = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);

  try {
    const logColumns = new Set(
      (
        await database
          .prepare(`SELECT column_name AS name
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'coupang_api_call_log'`)
          .all()
      ).map((row) => String(row.name))
    );
    assert(logColumns.has("external_vendor_item_id"));
    const verificationColumns = new Set(
      (
        await database
        .prepare(
          `SELECT column_name AS name
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'sales_channel_inventory_verification_states'`
        )
        .all()
      ).map((row) => String(row.name))
    );
    assert(verificationColumns.has("pending_order_quantity"));
    assert(verificationColumns.has("state_revision"));

    await database
      .prepare(`UPDATE sales_channel_inventory_verification_states
                SET channel_quantity = 8,
                    state_revision = state_revision + 1
                WHERE verification_state_id = ?`)
      .run(verificationState.verification_state_id);
    assert.equal(
      (await database
        .prepare(`SELECT state_revision
                  FROM sales_channel_inventory_verification_states
                  WHERE verification_state_id = ?`)
        .get(verificationState.verification_state_id)).state_revision,
      2
    );

    await expectBlocked(
      database,
      "missing verification state revision increment",
      `UPDATE sales_channel_inventory_verification_states
       SET channel_quantity = 7
       WHERE verification_state_id = ${verificationState.verification_state_id}`,
      "state_revision must increase by one"
    );
    await expectBlocked(
      database,
      "verification state revision jump",
      `UPDATE sales_channel_inventory_verification_states
       SET state_revision = state_revision + 2
       WHERE verification_state_id = ${verificationState.verification_state_id}`,
      "state_revision must increase by one"
    );

    await expectBlocked(
      database,
      "negative pending quantity insert",
      `INSERT INTO sales_channel_inventory_verification_states (
         mapping_id,
         channel,
         external_vendor_item_id,
         sales_offer_id,
         ledger_quantity,
         pending_order_quantity
       ) VALUES (
         ${duplicateMapping.mapping_id},
         'COUPANG',
         '${duplicateMapping.external_vendor_item_id}',
         ${exactOffer.sales_offer_id},
         9,
         -1
       )`,
      "ck_inventory_verification_quantities"
    );

    await expectBlocked(
      database,
      "negative ledger quantity",
      `UPDATE sales_channel_inventory_verification_states
       SET ledger_quantity = -1,
           state_revision = state_revision + 1
       WHERE verification_state_id = ${verificationState.verification_state_id}`,
      "ck_inventory_verification_quantities"
    );
    await expectBlocked(
      database,
      "negative pending quantity update",
      `UPDATE sales_channel_inventory_verification_states
       SET pending_order_quantity = -1,
           state_revision = state_revision + 1
       WHERE verification_state_id = ${verificationState.verification_state_id}`,
      "ck_inventory_verification_quantities"
    );
    await expectBlocked(
      database,
      "invalid verification status",
      `UPDATE sales_channel_inventory_verification_states
       SET verification_status = 'UNKNOWN',
           state_revision = state_revision + 1
       WHERE verification_state_id = ${verificationState.verification_state_id}`,
      "ck_inventory_verification_status"
    );
    await expectBlocked(
      database,
      "verification identity mutation",
      `UPDATE sales_channel_inventory_verification_states
       SET external_vendor_item_id = 'MUTATED'
       WHERE verification_state_id = ${verificationState.verification_state_id}`,
      "identity is immutable"
    );
    await expectBlocked(
      database,
      "API call vendor item mutation",
      `UPDATE coupang_api_call_log
       SET external_vendor_item_id = 'MUTATED'
       WHERE coupang_api_call_log_id = ${successfulLogId}`,
      "external_vendor_item_id is immutable"
    );
    const invalidConstraints = await database
      .prepare(`SELECT conname
                FROM pg_catalog.pg_constraint
                WHERE connamespace = current_schema()::regnamespace
                  AND NOT convalidated`)
      .all();
    assert.equal(invalidConstraints.length, 0);
  } finally {
    await database.close();
  }

  console.log(
    "Sales-channel inventory verification foundation and projection passed."
  );
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
