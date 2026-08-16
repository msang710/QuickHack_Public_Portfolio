import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  SUPPLY_CONSUMPTION_TRIGGER,
  normalizeSupplyConsumptionQuantity,
  supplyConsumptionTriggerSupportsFilter,
} from "../../../quickhack_shared/supplies/supplies.ts";

assert.equal(normalizeSupplyConsumptionQuantity(1.49), 1);
assert.equal(normalizeSupplyConsumptionQuantity(1.5), 2);
assert.equal(normalizeSupplyConsumptionQuantity(0.49), null);
assert.equal(normalizeSupplyConsumptionQuantity(0), null);
assert.equal(normalizeSupplyConsumptionQuantity("not-a-number"), null);

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-forecast-rule-filters-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    calculateSupplyForecasts,
    saveSupplyConsumptionRule,
  } = await import("@/quickhack_server/supplies/supplies-service");

  const userRow = await prisma.users.create({
    data: {
      username: "supply-forecast-filter-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply forecast filter test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function createSupply(code) {
    const supply = await prisma.supplies.create({
      data: {
        supply_code: code,
        supply_name: code,
        updated_by_user_id: user.userId,
      },
    });

    await prisma.supply_inventory.create({
      data: {
        supply_id: supply.supply_id,
        current_quantity: 0,
        reserved_quantity: 0,
      },
    });

    return supply;
  }

  async function createOption(category, optionKey, label = optionKey) {
    const existing = await prisma.product_criteria_options.findFirst({
      where: {
        category,
        option_key: optionKey,
        parent_key: "",
      },
    });

    if (existing) {
      return existing;
    }

    return prisma.product_criteria_options.create({
      data: {
        category,
        option_key: optionKey,
        label,
      },
    });
  }

  const [modelS24, modelS25, warranty] = await Promise.all([
    createOption("PRODUCT_MODEL", "GALAXY_S24", "Galaxy S24"),
    createOption("PRODUCT_MODEL", "GALAXY_S25", "Galaxy S25"),
    createOption("WARRANTY_GROUP", "2Y", "2년 보증"),
  ]);
  const [offerS24, offerS25] = await Promise.all([
    prisma.sales_offers.create({
      data: {
        offer_code: "SUPPLY-FILTER-S24",
        model_option_id: modelS24.option_id,
        warranty_group_option_id: warranty.option_id,
      },
    }),
    prisma.sales_offers.create({
      data: {
        offer_code: "SUPPLY-FILTER-S25",
        model_option_id: modelS25.option_id,
        warranty_group_option_id: warranty.option_id,
      },
    }),
  ]);

  async function createLegacyOrder(platform, suffix, model, quantity) {
    await prisma.orders.create({
      data: {
        platform,
        platform_order_id: `SUPPLY-FILTER-${suffix}`,
        ordered_at: new Date(),
        order_items: {
          create: {
            sale_product_name: `${model} order`,
            quantity,
            matched_model: model,
          },
        },
      },
    });
  }

  async function createChannelOrder(
    channel,
    suffix,
    offer,
    quantity,
    {
      matchableQuantity = quantity,
      cancelHoldQuantity = 0,
      canceledQuantity = 0,
      canceled = false,
    } = {}
  ) {
    await prisma.order_matching_work_queue.create({
      data: {
        channel,
        external_order_id: `ORDER-${suffix}`,
        external_shipment_id: `SHIPMENT-${suffix}`,
        external_vendor_item_id: `VENDOR-${suffix}`,
        ordered_quantity: quantity,
        matchable_quantity: matchableQuantity,
        cancel_hold_quantity: cancelHoldQuantity,
        canceled_quantity: canceledQuantity,
        canceled: canceled ? 1 : 0,
        ordered_at: new Date(),
        sales_offer_id: offer?.sales_offer_id ?? null,
        required_model_label:
          offer?.sales_offer_id === offerS24.sales_offer_id
            ? modelS24.label
            : offer?.sales_offer_id === offerS25.sales_offer_id
              ? modelS25.label
              : null,
        required_warranty_group: offer
          ? warranty.option_key.toUpperCase()
          : null,
      },
    });
  }

  await Promise.all([
    createLegacyOrder("COUPANG", "LEGACY-C-S24", "Galaxy S24", 2),
    createLegacyOrder("NAVER", "LEGACY-N-S24", "Galaxy S24", 4),
    createLegacyOrder("COUPANG", "LEGACY-C-S25", "Galaxy S25", 5),
    createChannelOrder("COUPANG", "CHANNEL-C-S24", offerS24, 3),
    createChannelOrder("NAVER", "CHANNEL-N-S24", offerS24, 11),
    createChannelOrder("COUPANG", "CHANNEL-C-S25", offerS25, 7),
    createChannelOrder("CANCEL_TEST", "NORMAL", null, 10),
    createChannelOrder("CANCEL_TEST", "PARTIAL-CANCEL", null, 10, {
      matchableQuantity: 6,
      cancelHoldQuantity: 4,
    }),
    createChannelOrder("CANCEL_TEST", "FULL-CANCEL", null, 10, {
      matchableQuantity: 10,
      canceledQuantity: 10,
      canceled: true,
    }),
  ]);

  const modelFilteredSupply = await createSupply("MODEL_FILTERED_SUPPLY");
  const modelKeyFilteredSupply = await createSupply(
    "MODEL_KEY_FILTERED_SUPPLY"
  );
  const warrantyKeyFilteredSupply = await createSupply(
    "WARRANTY_KEY_FILTERED_SUPPLY"
  );
  const channelFilteredSupply = await createSupply("CHANNEL_FILTERED_SUPPLY");
  const effectiveQuantitySupply = await createSupply(
    "EFFECTIVE_QUANTITY_SUPPLY"
  );
  const modelFilteredRule = await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: modelFilteredSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1.5,
      model: "Galaxy S24",
    },
    user
  );
  const modelKeyFilteredRule = await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: modelKeyFilteredSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1.49,
      model: "GALAXY_S24",
    },
    user
  );
  assert.equal(modelFilteredRule.quantity_per_unit, 2);
  assert.equal(modelKeyFilteredRule.quantity_per_unit, 1);
  await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: warrantyKeyFilteredSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      warranty: "2Y",
    },
    user
  );
  await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: effectiveQuantitySupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      channel: "cancel_test",
    },
    user
  );
  await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: channelFilteredSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      channel: "coupang",
    },
    user
  );

  await calculateSupplyForecasts(
    prisma,
    { supplyId: modelFilteredSupply.supply_id, lookbackDays: 1 },
    user
  );
  await calculateSupplyForecasts(
    prisma,
    { supplyId: modelKeyFilteredSupply.supply_id, lookbackDays: 1 },
    user
  );
  await calculateSupplyForecasts(
    prisma,
    { supplyId: warrantyKeyFilteredSupply.supply_id, lookbackDays: 1 },
    user
  );
  await calculateSupplyForecasts(
    prisma,
    { supplyId: channelFilteredSupply.supply_id, lookbackDays: 1 },
    user
  );
  await calculateSupplyForecasts(
    prisma,
    { supplyId: effectiveQuantitySupply.supply_id, lookbackDays: 1 },
    user
  );

  const [
    modelForecast,
    modelKeyForecast,
    warrantyKeyForecast,
    channelForecast,
    effectiveQuantityForecast,
  ] =
    await Promise.all([
      prisma.supply_forecast_snapshots.findFirstOrThrow({
        where: { supply_id: modelFilteredSupply.supply_id },
        orderBy: { forecast_id: "desc" },
      }),
      prisma.supply_forecast_snapshots.findFirstOrThrow({
        where: { supply_id: modelKeyFilteredSupply.supply_id },
        orderBy: { forecast_id: "desc" },
      }),
      prisma.supply_forecast_snapshots.findFirstOrThrow({
        where: { supply_id: warrantyKeyFilteredSupply.supply_id },
        orderBy: { forecast_id: "desc" },
      }),
      prisma.supply_forecast_snapshots.findFirstOrThrow({
        where: { supply_id: channelFilteredSupply.supply_id },
        orderBy: { forecast_id: "desc" },
      }),
      prisma.supply_forecast_snapshots.findFirstOrThrow({
        where: { supply_id: effectiveQuantitySupply.supply_id },
        orderBy: { forecast_id: "desc" },
      }),
    ]);

  assert.equal(
    modelForecast.expected_usage_quantity,
    40,
    "ORDER_ITEM model filter included orders for another model."
  );
  assert.equal(
    modelKeyForecast.expected_usage_quantity,
    0,
    "ORDER_ITEM model option keys must not match label-based rules."
  );
  assert.equal(
    warrantyKeyForecast.expected_usage_quantity,
    21,
    "ORDER_ITEM warranty option-key normalization stopped matching channel orders."
  );
  assert.equal(
    channelForecast.expected_usage_quantity,
    17,
    "ORDER_ITEM channel filter included orders from another channel."
  );
  assert.equal(
    effectiveQuantityForecast.expected_usage_quantity,
    16,
    "ORDER_ITEM forecast included cancel-held or fully canceled quantities."
  );

  const [quantityColumn] = await prisma.$queryRawUnsafe(
    `SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'supply_consumption_rules' AND column_name = 'quantity_per_unit'`
  );
  assert.equal(
    quantityColumn?.data_type,
    "integer",
    "Supply consumption must be persisted as a PostgreSQL integer."
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE supply_consumption_rules SET quantity_per_unit = 0 WHERE rule_id = ${modelFilteredRule.rule_id}`
    ),
    /positive.integer|check constraint/i
  );

  assert.equal(
    supplyConsumptionTriggerSupportsFilter(
      SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      "model"
    ),
    true
  );
  assert.equal(
    supplyConsumptionTriggerSupportsFilter(
      SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      "saleGrade"
    ),
    false
  );
  assert.equal(
    supplyConsumptionTriggerSupportsFilter(
      SUPPLY_CONSUMPTION_TRIGGER.returnReceived,
      "model"
    ),
    false
  );

  await assert.rejects(
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: modelFilteredSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 1,
        saleGrade: "A",
      },
      user
    ),
    (error) => error?.code === "UNSUPPORTED_SUPPLY_RULE_FILTER"
  );
  await assert.rejects(
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: modelFilteredSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.returnReceived,
        quantityPerUnit: 1,
        model: "Galaxy S24",
      },
      user
    ),
    (error) => error?.code === "UNSUPPORTED_SUPPLY_RULE_FILTER"
  );

  const overlapSupply = await createSupply("OVERLAP_SUPPLY");
  const galaxyS24Rule = await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: overlapSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      model: "Galaxy S24",
    },
    user
  );
  const galaxyS25Rule = await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: overlapSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      model: "Galaxy S25",
    },
    user
  );
  assert.notEqual(
    galaxyS24Rule.rule_id,
    galaxyS25Rule.rule_id,
    "Disjoint model rules were not saved independently."
  );

  const editedGalaxyS24Rule = await saveSupplyConsumptionRule(
    prisma,
    {
      ruleId: galaxyS24Rule.rule_id,
      expectedRevision: galaxyS24Rule.revision,
      supplyId: overlapSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      model: "Galaxy S24",
      note: "self update",
    },
    user
  );
  assert.equal(editedGalaxyS24Rule.note, "self update");

  await assert.rejects(
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: overlapSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.shipmentCreated,
        quantityPerUnit: 1,
        model: "Galaxy S24",
      },
      user
    ),
    (error) =>
      error?.status === 409 &&
      error?.code === "SUPPLY_CONSUMPTION_RULE_OVERLAP" &&
      error?.details?.conflictingRuleId === galaxyS24Rule.rule_id
  );

  const inactiveGenericRule = await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: overlapSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.packingCompleted,
      quantityPerUnit: 1,
      isActive: false,
    },
    user
  );
  assert.equal(inactiveGenericRule.is_active, 0);
  await assert.rejects(
    saveSupplyConsumptionRule(
      prisma,
      {
        ruleId: inactiveGenericRule.rule_id,
        expectedRevision: inactiveGenericRule.revision,
        supplyId: overlapSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.packingCompleted,
        quantityPerUnit: 1,
        isActive: true,
      },
      user
    ),
    (error) => error?.code === "SUPPLY_CONSUMPTION_RULE_OVERLAP"
  );

  const channelPartitionSupply = await createSupply(
    "CHANNEL_PARTITION_SUPPLY"
  );
  await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: channelPartitionSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      channel: "COUPANG",
    },
    user
  );
  await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: channelPartitionSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      channel: "NAVER",
    },
    user
  );
  await assert.rejects(
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: channelPartitionSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 1,
      },
      user
    ),
    (error) => error?.code === "SUPPLY_CONSUMPTION_RULE_OVERLAP"
  );

  console.log("Supply forecast filters and rule overlap guards verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
