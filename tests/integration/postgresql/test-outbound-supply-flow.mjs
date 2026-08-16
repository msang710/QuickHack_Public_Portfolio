import { createPostgresqlPrismaClient } from "@/quickhack_server/core/database/postgresql-client";
import {
  consumePackingConfirmedSupplies,
  consumePrepackSupplies,
  listReturnSupplyCandidates,
  restoreReturnSupplies,
} from "@/quickhack_server/supplies/outbound-supply-service";
import {
  OUTBOUND_SUPPLY_CONSUMPTION_POLICY,
  SUPPLY_CONSUMPTION_TRIGGER,
} from "@/quickhack_shared/supplies/supplies";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-outbound-supply-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
const timestamp = new Date("2026-07-18T03:00:00.000Z");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createSupply(prisma, input) {
  const supply = await prisma.supplies.create({
    data: {
      supply_code: input.code,
      supply_name: input.name,
      outbound_consumption_policy: input.policy,
      updated_by_user_id: input.userId,
    },
  });

  await prisma.supply_inventory.create({
    data: {
      supply_id: supply.supply_id,
      current_quantity: 100,
      reserved_quantity: 0,
    },
  });
  await prisma.supply_consumption_rules.create({
    data: {
      supply_id: supply.supply_id,
      trigger_type:
        input.triggerType ?? SUPPLY_CONSUMPTION_TRIGGER.packingCompleted,
      quantity_per_unit: input.quantity,
      channel: input.channel ?? null,
      model: input.model ?? null,
      warranty: input.warranty ?? null,
      is_active: 1,
      updated_by_user_id: input.userId,
    },
  });

  return supply;
}

async function createAllocation(prisma, input) {
  await prisma.devices.create({
    data: {
      pg_no: input.pgNo,
      model: "TEST-MODEL",
      warranty: input.deviceWarranty ?? null,
    },
  });
  await prisma.inventory.create({
    data: {
      pg_no: input.pgNo,
      inventory_status: "PACKING",
      location: input.location,
    },
  });
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: input.orderId,
      external_shipment_id: input.shipmentId,
      external_order_status: "DEPARTURE",
    },
  });

  return prisma.match_worker_allocation.create({
    data: {
      external_order_id: input.orderId,
      external_shipment_id: input.shipmentId,
      external_vendor_item_id: "TEST-ITEM",
      pg_no: input.pgNo,
      required_warranty_group: input.requiredWarrantyGroup ?? null,
      // This service test does not exercise matching, so use a non-active status
      // to avoid requiring the full sales-offer fixture graph.
      allocation_status: "CANCELED",
    },
  });
}

async function createReturnAllocation(prisma, input) {
  const returnRow = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: input.receiptId,
      external_order_id: input.orderId,
      external_shipment_id: input.shipmentId,
      cancel_type: "RETURN",
      return_receipt_status: "UC",
      cancel_count: 1,
    },
  });

  return prisma.coupang_return_allocation.create({
    data: {
      coupang_return_raw_id: returnRow.coupang_return_raw_id,
      allocation_id: input.allocationId,
      external_receipt_id: input.receiptId,
      external_order_id: input.orderId,
      external_shipment_id: input.shipmentId,
      external_vendor_item_id: "TEST-ITEM",
      pg_no: input.pgNo,
      action_type: "approve",
      linked_by_user_id: input.userId,
    },
  });
}

async function quantities(prisma, supplies) {
  const rows = await prisma.supply_inventory.findMany({
    where: { supply_id: { in: supplies.map((supply) => supply.supply_id) } },
  });
  return new Map(rows.map((row) => [row.supply_id, row.current_quantity]));
}

let prisma;

try {
  ({ client: prisma } = createPostgresqlPrismaClient({
    connectionString: temporaryDatabase.databaseUrl,
    applicationName: "quickhack-test-outbound-supply",
  }));

  const user = await prisma.users.create({
    data: {
      username: "supply-flow-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const sticker = await createSupply(prisma, {
    code: "TEST_NO_REFUND_STICKER",
    name: "No-refund sticker",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed,
    quantity: 2,
    userId: user.user_id,
  });
  const a8Box = await createSupply(prisma, {
    code: "COMMON_A8_BOX",
    name: "A-8 box",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly,
    quantity: 1,
    userId: user.user_id,
  });
  const warrantyCard = await createSupply(prisma, {
    code: "TEST_WARRANTY_CARD_2Y",
    name: "2-year warranty card",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed,
    quantity: 1,
    warranty: "2\uB144 \uBCF4\uC99D",
    userId: user.user_id,
  });
  const charger = await createSupply(prisma, {
    code: "TEST_CHARGER",
    name: "Charger",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly,
    quantity: 1,
    userId: user.user_id,
  });
  const naverOnlySupply = await createSupply(prisma, {
    code: "TEST_NAVER_ONLY_SUPPLY",
    name: "Naver-only supply",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed,
    triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
    channel: "NAVER",
    quantity: 1,
    userId: user.user_id,
  });
  const supplies = [
    sticker,
    a8Box,
    charger,
    warrantyCard,
    naverOnlySupply,
  ];

  const firstAllocation = await createAllocation(prisma, {
    pgNo: "PG-SUPPLY-1",
    orderId: "ORDER-SUPPLY-1",
    shipmentId: "SHIP-SUPPLY-1",
    location: "\uD3EC\uC7A5 \uC644\uB8CC",
    deviceWarranty: "2\uB144 \uBCF4\uC99D",
    requiredWarrantyGroup: "2Y",
  });
  const audit = await prisma.inventory_audit_sessions.create({
    data: {
      audit_base_date: new Date("2026-07-18T00:00:00.000Z"),
      audit_period_from: new Date("2026-07-17T15:00:00.000Z"),
      audit_period_to: new Date("2026-07-18T14:59:59.000Z"),
      created_by_user_id: user.user_id,
    },
  });

  await prisma.$transaction((tx) =>
    consumePrepackSupplies(tx, {
      pgNos: ["PG-SUPPLY-1"],
      inventoryAuditSessionId: audit.inventory_audit_session_id,
      auditPeriodFrom: audit.audit_period_from,
      auditPeriodTo: audit.audit_period_to,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );

  const stickerRule = await prisma.supply_consumption_rules.findFirstOrThrow({
    where: { supply_id: sticker.supply_id },
  });
  const warrantyRule = await prisma.supply_consumption_rules.findFirstOrThrow({
    where: { supply_id: warrantyCard.supply_id },
  });
  await prisma.supplies.update({
    where: { supply_id: sticker.supply_id },
    data: { outbound_consumption_policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly },
  });
  await prisma.supply_consumption_rules.update({
    where: { rule_id: stickerRule.rule_id },
    data: { quantity_per_unit: 7, revision: { increment: 1 } },
  });
  await prisma.supply_consumption_rules.update({
    where: { rule_id: warrantyRule.rule_id },
    data: { is_active: 0, revision: { increment: 1 } },
  });
  await prisma.$transaction((tx) =>
    consumePrepackSupplies(tx, {
      pgNos: ["PG-SUPPLY-1"],
      inventoryAuditSessionId: audit.inventory_audit_session_id,
      auditPeriodFrom: audit.audit_period_from,
      auditPeriodTo: audit.audit_period_to,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );

  let current = await quantities(prisma, supplies);
  assert(current.get(sticker.supply_id) === 98, "Prepack retry double-consumed the sticker.");
  assert(current.get(a8Box.supply_id) === 100, "Prepack consumed the A-8 box.");
  assert(current.get(charger.supply_id) === 100, "Prepack consumed a confirmed-only supply.");
  assert(current.get(warrantyCard.supply_id) === 99, "Prepack did not match the warranty-card label.");
  assert(
    current.get(naverOnlySupply.supply_id) === 100,
    "Prepack consumed a supply before its sales channel was known."
  );

  await prisma.$transaction((tx) =>
    consumePackingConfirmedSupplies(tx, {
      allocationId: firstAllocation.allocation_id,
      pgNo: firstAllocation.pg_no,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );
  await prisma.$transaction((tx) =>
    consumePackingConfirmedSupplies(tx, {
      allocationId: firstAllocation.allocation_id,
      pgNo: firstAllocation.pg_no,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );

  current = await quantities(prisma, supplies);
  assert(current.get(sticker.supply_id) === 98, "Packing retry double-consumed a claimed prepack supply.");
  assert(current.get(a8Box.supply_id) === 99, "Packing did not consume exactly one A-8 box.");
  assert(current.get(charger.supply_id) === 99, "Packing did not consume exactly one charger.");
  assert(current.get(warrantyCard.supply_id) === 99, "Warranty code/label normalization double-consumed or missed the card.");
  assert(
    current.get(naverOnlySupply.supply_id) === 100,
    "Coupang packing consumed a Naver-only supply."
  );

  const firstReturn = await createReturnAllocation(prisma, {
    receiptId: "RETURN-SUPPLY-1",
    orderId: "ORDER-SUPPLY-1",
    shipmentId: "SHIP-SUPPLY-1",
    pgNo: "PG-SUPPLY-1",
    allocationId: firstAllocation.allocation_id,
    userId: user.user_id,
  });
  const candidates = await prisma.$transaction((tx) =>
    listReturnSupplyCandidates(tx, firstAllocation.allocation_id)
  );
  const stickerEvent = candidates.find((item) => item.supplyCode === sticker.supply_code);
  const chargerEvent = candidates.find((item) => item.supplyCode === charger.supply_code);
  const a8Event = candidates.find((item) => item.supplyCode === a8Box.supply_code);
  const warrantyEvent = candidates.find(
    (item) => item.supplyCode === warrantyCard.supply_code
  );
  assert(candidates.length === 4, "The return modal candidates do not match actual consumption events.");
  assert(a8Event?.reusable === false, "The A-8 box was marked reusable.");
  assert(stickerEvent?.quantity === 2, "The return candidate did not preserve the exact integer consumption quantity.");

  const stickerConsumption = await prisma.supply_consumption_events.findUniqueOrThrow({
    where: {
      supply_consumption_event_id: stickerEvent.consumptionEventId,
    },
    include: { stock_movement: true },
  });
  assert(stickerConsumption.quantity === 2, "The consumption event did not store the configured integer quantity.");
  assert(
    stickerConsumption.applied_rule_revision === stickerRule.revision,
    "The consumption event did not preserve the applied rule revision."
  );
  assert(stickerConsumption.stock_movement?.quantity === 2, "The stock movement did not use the same integer quantity as the event.");

  let fractionalEventBlocked = false;
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO supply_consumption_events (
        supply_id,
        rule_id,
        trigger_type,
        source_type,
        source_id,
        pg_no,
        quantity,
        applied_rule_revision,
        consumed_at,
        created_by_user_id,
        allocation_id,
        idempotency_key,
        consumption_stage,
        claimed_at
      )
      SELECT
        supply_id,
        rule_id,
        trigger_type,
        'INTEGER_CONTRACT_TEST',
        'fractional-event',
        pg_no,
        0,
        applied_rule_revision,
        consumed_at,
        created_by_user_id,
        allocation_id,
        'supply:integer-contract:fractional-event',
        'PACKING_CONFIRMED',
        claimed_at
      FROM supply_consumption_events
      WHERE supply_consumption_event_id = ${stickerEvent.consumptionEventId}
    `);
  } catch {
    fractionalEventBlocked = true;
  }
  assert(
    fractionalEventBlocked,
    "The database accepted a non-positive supply consumption event."
  );

  const selectedEventIds = [
    stickerEvent?.consumptionEventId,
    chargerEvent?.consumptionEventId,
    warrantyEvent?.consumptionEventId,
  ].filter(Number.isInteger);
  await prisma.$transaction((tx) =>
    restoreReturnSupplies(tx, {
      allocationId: firstAllocation.allocation_id,
      coupangReturnAllocationId: firstReturn.coupang_return_allocation_id,
      selectedConsumptionEventIds: selectedEventIds,
      restoreAllReusable: false,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );
  await prisma.$transaction((tx) =>
    restoreReturnSupplies(tx, {
      allocationId: firstAllocation.allocation_id,
      coupangReturnAllocationId: firstReturn.coupang_return_allocation_id,
      selectedConsumptionEventIds: selectedEventIds,
      restoreAllReusable: false,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );

  current = await quantities(prisma, supplies);
  assert(current.get(sticker.supply_id) === 100, "Selected sticker recovery was not idempotent.");
  assert(current.get(charger.supply_id) === 100, "Selected charger recovery was not idempotent.");
  assert(current.get(a8Box.supply_id) === 99, "Post-shipment return restored the A-8 box.");
  assert(current.get(warrantyCard.supply_id) === 100, "Post-shipment return did not restore the selected warranty card.");
  assert(
    current.get(naverOnlySupply.supply_id) === 100,
    "Return processing changed an unmatched channel-specific supply."
  );

  await prisma.supplies.update({
    where: { supply_id: sticker.supply_id },
    data: { outbound_consumption_policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed },
  });
  await prisma.supply_consumption_rules.update({
    where: { rule_id: stickerRule.rule_id },
    data: { quantity_per_unit: 2, revision: { increment: 1 } },
  });
  await prisma.supply_consumption_rules.update({
    where: { rule_id: warrantyRule.rule_id },
    data: { is_active: 1, revision: { increment: 1 } },
  });

  let a8SelectionBlocked = false;
  try {
    await prisma.$transaction((tx) =>
      restoreReturnSupplies(tx, {
        allocationId: firstAllocation.allocation_id,
        coupangReturnAllocationId: firstReturn.coupang_return_allocation_id,
        selectedConsumptionEventIds: [a8Event.consumptionEventId],
        restoreAllReusable: false,
        occurredAt: timestamp,
        actorUserId: user.user_id,
      })
    );
  } catch {
    a8SelectionBlocked = true;
  }
  assert(a8SelectionBlocked, "The server accepted A-8 box recovery.");

  const secondAllocation = await createAllocation(prisma, {
    pgNo: "PG-SUPPLY-2",
    orderId: "ORDER-SUPPLY-2",
    shipmentId: "SHIP-SUPPLY-2",
    location: "PACKING-STATION",
    deviceWarranty: "2\uB144 \uBCF4\uC99D",
    requiredWarrantyGroup: "2Y",
  });
  await prisma.$transaction((tx) =>
    consumePackingConfirmedSupplies(tx, {
      allocationId: secondAllocation.allocation_id,
      pgNo: secondAllocation.pg_no,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );
  const secondReturn = await createReturnAllocation(prisma, {
    receiptId: "RETURN-SUPPLY-2",
    orderId: "ORDER-SUPPLY-2",
    shipmentId: "SHIP-SUPPLY-2",
    pgNo: "PG-SUPPLY-2",
    allocationId: secondAllocation.allocation_id,
    userId: user.user_id,
  });
  await prisma.$transaction((tx) =>
    restoreReturnSupplies(tx, {
      allocationId: secondAllocation.allocation_id,
      coupangReturnAllocationId: secondReturn.coupang_return_allocation_id,
      restoreAllReusable: true,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );

  current = await quantities(prisma, supplies);
  assert(current.get(sticker.supply_id) === 100, "Pre-shipment return did not restore reusable prepack supplies.");
  assert(current.get(charger.supply_id) === 100, "Pre-shipment return did not restore reusable packing supplies.");
  assert(current.get(a8Box.supply_id) === 98, "Pre-shipment return incorrectly restored the A-8 box.");
  assert(current.get(warrantyCard.supply_id) === 100, "Pre-shipment return did not restore the warranty card.");
  assert(
    current.get(naverOnlySupply.supply_id) === 100,
    "A later Coupang allocation consumed a Naver-only supply."
  );

  await prisma.product_criteria_options.create({
    data: {
      category: "PRODUCT_MODEL",
      option_key: "TEST_MODEL_KEY",
      label: "TEST-MODEL",
    },
  });
  const modelLabelSupply = await createSupply(prisma, {
    code: "TEST_MODEL_LABEL_SUPPLY",
    name: "Model label supply",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly,
    triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
    model: "TEST-MODEL",
    quantity: 1,
    userId: user.user_id,
  });
  const modelKeySupply = await createSupply(prisma, {
    code: "TEST_MODEL_KEY_SUPPLY",
    name: "Model key supply",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.packingConfirmedOnly,
    triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
    model: "TEST_MODEL_KEY",
    quantity: 1,
    userId: user.user_id,
  });
  const modelAllocation = await createAllocation(prisma, {
    pgNo: "PG-SUPPLY-MODEL",
    orderId: "ORDER-SUPPLY-MODEL",
    shipmentId: "SHIP-SUPPLY-MODEL",
    location: "PACKING-STATION",
  });

  await prisma.$transaction((tx) =>
    consumePackingConfirmedSupplies(tx, {
      allocationId: modelAllocation.allocation_id,
      pgNo: modelAllocation.pg_no,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );

  const modelRuleQuantities = await quantities(prisma, [
    modelLabelSupply,
    modelKeySupply,
  ]);
  assert(
    modelRuleQuantities.get(modelLabelSupply.supply_id) === 99,
    "Outbound consumption stopped matching the device model label."
  );
  assert(
    modelRuleQuantities.get(modelKeySupply.supply_id) === 100,
    "Outbound consumption matched a model option key instead of the device model label."
  );

  const conflictAllocation = await createAllocation(prisma, {
    pgNo: "PG-SUPPLY-CONFLICT",
    orderId: "ORDER-SUPPLY-CONFLICT",
    shipmentId: "SHIP-SUPPLY-CONFLICT",
    location: "\uD3EC\uC7A5 \uC644\uB8CC",
  });
  const conflictAudit = await prisma.inventory_audit_sessions.create({
    data: {
      audit_base_date: new Date("2026-07-19T00:00:00.000Z"),
      audit_period_from: new Date("2026-07-18T15:00:00.000Z"),
      audit_period_to: new Date("2026-07-19T14:59:59.000Z"),
      created_by_user_id: user.user_id,
    },
  });
  await prisma.$transaction((tx) =>
    consumePrepackSupplies(tx, {
      pgNos: [conflictAllocation.pg_no],
      inventoryAuditSessionId: conflictAudit.inventory_audit_session_id,
      auditPeriodFrom: conflictAudit.audit_period_from,
      auditPeriodTo: conflictAudit.audit_period_to,
      occurredAt: timestamp,
      actorUserId: user.user_id,
    })
  );
  const lateSupply = await createSupply(prisma, {
    code: "TEST_LATE_PREPACK_RULE",
    name: "Late prepack rule",
    policy: OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed,
    quantity: 1,
    userId: user.user_id,
  });
  let lateRuleBlocked = false;
  try {
    await prisma.$transaction((tx) =>
      consumePackingConfirmedSupplies(tx, {
        allocationId: conflictAllocation.allocation_id,
        pgNo: conflictAllocation.pg_no,
        occurredAt: timestamp,
        actorUserId: user.user_id,
      })
    );
  } catch (error) {
    lateRuleBlocked = error?.code === "SUPPLY_PREPACK_RULE_SET_CHANGED";
  }
  assert(lateRuleBlocked, "A rule added after prepack did not block packing.");
  const lateInventory = await prisma.supply_inventory.findUniqueOrThrow({
    where: { supply_id: lateSupply.supply_id },
  });
  assert(lateInventory.current_quantity === 100, "A late prepack rule was consumed instead of blocking packing.");

  console.log("Outbound supply consumption and return recovery invariants verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
