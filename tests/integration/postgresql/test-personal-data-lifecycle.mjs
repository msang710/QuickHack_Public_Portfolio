import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-personal-data-lifecycle-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const { prisma } = await import("../../../quickhack_server/core/prisma.ts");
const {
  reconcilePersonalDataLifecyclesForOrder,
  recordPersonalDataDeliveryCompletion,
} = await import(
  "../../../quickhack_server/security/personal-data-lifecycle-service.ts"
);
const {
  recordReturnObservation,
  recordExchangeObservation,
} = await import(
  "../../../quickhack_server/sales-channel/coupang/claim-history-service.ts"
);
const {
  redactExpiredSalesChannelPersonalData,
} = await import(
  "../../../quickhack_server/admin/privacy-maintenance-service.ts"
);
const {
  persistCoupangOrderRawSnapshots,
} = await import(
  "../../../quickhack_server/sales-channel/coupang/sync-service.ts"
);
const {
  addSeconds,
  nowKstSqlDateTime,
  quickHackClock,
} = await import("../../../quickhack_shared/core/time.ts");
const { reserveSalesChannelProjectionObservation } = await import(
  "../../../quickhack_server/sales-channel/projection-revision-service.ts"
);

function daysAgo(days) {
  return addSeconds(quickHackClock.nowDate(), -days * 24 * 60 * 60);
}

function snapshotTime(value) {
  return nowKstSqlDateTime(value);
}

function orderInput(externalOrderId, externalShipmentId, overrides = {}) {
  return {
    externalOrderId,
    externalShipmentId,
    channelStatus: "FINAL_DELIVERY",
    orderedAt: daysAgo(130),
    paidAt: daysAgo(130),
    ordererName: "주문자",
    receiverName: "수령자",
    receiverSafeNumber: "050712345678",
    receiverAddress1: "서울특별시 강남구 테스트로 1",
    receiverAddress2: "101동 101호",
    receiverPostCode: "01234",
    shippingMemo: "문 앞에 놓아주세요",
    deliveryCompanyName: "로젠택배",
    invoiceNumber: "12345678901",
    invoiceUploadedAt: daysAgo(120),
    splitShipping: false,
    items: [],
    ...overrides,
  };
}

async function createRawOrder(
  externalOrderId,
  externalShipmentId,
  overrides = {}
) {
  const timestamp = overrides.timestamp ?? daysAgo(1);
  return prisma.coupang_order_raw.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_order_status: overrides.status ?? "INSTRUCT",
      orderer_name: overrides.ordererName ?? "주문자",
      receiver_name: overrides.receiverName ?? "수령자",
      receiver_safe_number:
        overrides.receiverSafeNumber ?? "050712345678",
      receiver_address_1:
        overrides.receiverAddress1 ?? "서울특별시 강남구 테스트로 1",
      receiver_address_2: overrides.receiverAddress2 ?? "101동 101호",
      receiver_post_code: "01234",
      shipping_memo: overrides.shippingMemo ?? "문 앞에 놓아주세요",
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
}

function returnSnapshot(status, completedAt = null) {
  return {
    external_created_at: snapshotTime(daysAgo(100)),
    external_modified_at: snapshotTime(completedAt ?? daysAgo(1)),
    external_completed_at: completedAt ? snapshotTime(completedAt) : null,
    external_completion_type: null,
    receipt_type: "RETURN",
    receipt_status: status,
    release_status: "Y",
    fault_by_type: "CUSTOMER",
    reason_code: "CHANGE_MIND",
    reason_label: "단순 변심",
    reason_category: "고객",
    reason_detail: null,
    cancel_count: "1",
  };
}

function exchangeSnapshot(status, modifiedAt) {
  return {
    external_created_at: snapshotTime(daysAgo(100)),
    external_modified_at: snapshotTime(modifiedAt),
    exchange_status: status,
    fault_by_type: "CUSTOMER",
    reason_code: "EXCHANGE_REQUEST",
    reason_label: "교환 요청",
    reason_detail: null,
  };
}

async function observeReturn(input) {
  await prisma.$transaction(async (tx) => {
    await tx.coupang_return_raw.upsert({
      where: { external_receipt_id: input.receiptId },
      create: {
        external_receipt_id: input.receiptId,
        external_order_id: input.orderId,
        external_shipment_id: input.shipmentId ?? null,
        return_receipt_status: input.status,
        cancel_count: 1,
        synced_at: input.observedAt,
        created_at: input.observedAt,
        updated_at: input.observedAt,
      },
      update: {
        return_receipt_status: input.status,
        synced_at: input.observedAt,
        updated_at: input.observedAt,
      },
    });
    await recordReturnObservation({
      tx,
      externalReceiptId: input.receiptId,
      externalOrderId: input.orderId,
      externalShipmentId: input.shipmentId ?? null,
      snapshot: returnSnapshot(input.status, input.completedAt ?? null),
      observedAt: input.observedAt,
    });
    await reconcilePersonalDataLifecyclesForOrder(tx, {
      externalOrderId: input.orderId,
      externalShipmentId: input.shipmentId,
      now: input.observedAt,
    });
  });
}

async function observeExchange(input) {
  await prisma.$transaction(async (tx) => {
    await tx.coupang_exchange_raw.upsert({
      where: { external_exchange_id: input.exchangeId },
      create: {
        external_exchange_id: input.exchangeId,
        external_order_id: input.orderId,
        external_shipment_id: input.shipmentId,
        exchange_status: input.status,
        synced_at: input.observedAt,
        created_at: input.observedAt,
        updated_at: input.observedAt,
      },
      update: {
        exchange_status: input.status,
        synced_at: input.observedAt,
        updated_at: input.observedAt,
      },
    });
    await recordExchangeObservation({
      tx,
      externalExchangeId: input.exchangeId,
      externalOrderId: input.orderId,
      externalShipmentId: input.shipmentId,
      snapshot: exchangeSnapshot(input.status, input.modifiedAt),
      observedAt: input.observedAt,
    });
    await reconcilePersonalDataLifecyclesForOrder(tx, {
      externalOrderId: input.orderId,
      externalShipmentId: input.shipmentId,
      now: input.observedAt,
    });
  });
}

async function recordDelivery(orderId, shipmentId, completedAt) {
  await prisma.$transaction((tx) =>
    recordPersonalDataDeliveryCompletion(tx, {
      externalOrderId: orderId,
      externalShipmentId: shipmentId,
      completedAt,
      now: completedAt,
    })
  );
}

async function rawOrder(orderId, shipmentId) {
  return prisma.coupang_order_raw.findUniqueOrThrow({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: orderId,
        external_shipment_id: shipmentId,
      },
    },
  });
}

try {
  await createRawOrder("ORDER-WAITING", "SHIP-WAITING", {
    timestamp: daysAgo(200),
  });
  await redactExpiredSalesChannelPersonalData();
  assert(
    (await rawOrder("ORDER-WAITING", "SHIP-WAITING")).receiver_name ===
      "수령자",
    "An old sync timestamp must not redact an order without completion evidence."
  );

  await createRawOrder("ORDER-DELIVERED", "SHIP-DELIVERED");
  await recordDelivery("ORDER-DELIVERED", "SHIP-DELIVERED", daysAgo(100));
  const deliveredRun = await redactExpiredSalesChannelPersonalData();
  const delivered = await rawOrder("ORDER-DELIVERED", "SHIP-DELIVERED");
  assert(
    delivered.receiver_name !== "수령자" &&
      delivered.receiver_safe_number.endsWith("5678"),
    "A delivery completed over 90 days ago must be masked even after a recent sync."
  );
  assert(
    deliveredRun.redacted >= 1,
    "The worker result must report newly redacted subjects."
  );

  await createRawOrder("ORDER-ACTIVE", "SHIP-ACTIVE");
  await recordDelivery("ORDER-ACTIVE", "SHIP-ACTIVE", daysAgo(120));
  await observeReturn({
    receiptId: "RETURN-ACTIVE",
    orderId: "ORDER-ACTIVE",
    shipmentId: "SHIP-ACTIVE",
    status: "RETURNS_UNCHECKED",
    observedAt: daysAgo(10),
  });
  await redactExpiredSalesChannelPersonalData();
  assert(
    (await rawOrder("ORDER-ACTIVE", "SHIP-ACTIVE")).receiver_name ===
      "수령자",
    "An active return must pause the retention clock."
  );

  await observeReturn({
    receiptId: "RETURN-ACTIVE",
    orderId: "ORDER-ACTIVE",
    shipmentId: "SHIP-ACTIVE",
    status: "RETURNS_COMPLETED",
    completedAt: daysAgo(95),
    observedAt: daysAgo(94),
  });
  const terminalLifecycle =
    await prisma.sales_channel_personal_data_lifecycles.findFirstOrThrow({
      where: {
        external_order_id: "ORDER-ACTIVE",
        external_shipment_id: "SHIP-ACTIVE",
      },
    });
  assert(
    terminalLifecycle.active_claim_count === 0 &&
      terminalLifecycle.retention_basis === "RETURN_COMPLETED",
    "A completed return must restart retention from the claim terminal time."
  );
  await redactExpiredSalesChannelPersonalData();
  assert(
    (await rawOrder("ORDER-ACTIVE", "SHIP-ACTIVE")).receiver_name !==
      "수령자",
    "A return completed over 90 days ago must become eligible."
  );

  for (const shipmentId of ["SHIP-ORDER-A", "SHIP-ORDER-B"]) {
    await createRawOrder("ORDER-SCOPED", shipmentId);
    await recordDelivery("ORDER-SCOPED", shipmentId, daysAgo(120));
  }
  await observeReturn({
    receiptId: "RETURN-ORDER-SCOPED",
    orderId: "ORDER-SCOPED",
    shipmentId: null,
    status: "RETURNS_UNCHECKED",
    observedAt: daysAgo(5),
  });
  await redactExpiredSalesChannelPersonalData();
  assert(
    (await rawOrder("ORDER-SCOPED", "SHIP-ORDER-A")).receiver_name ===
      "수령자" &&
      (await rawOrder("ORDER-SCOPED", "SHIP-ORDER-B")).receiver_name ===
        "수령자",
    "A claim without a shipment ID must protect every shipment in the order."
  );

  await createRawOrder("ORDER-EXCHANGE", "SHIP-EXCHANGE");
  await recordDelivery("ORDER-EXCHANGE", "SHIP-EXCHANGE", daysAgo(130));
  await observeExchange({
    exchangeId: "EXCHANGE-TERMINAL",
    orderId: "ORDER-EXCHANGE",
    shipmentId: "SHIP-EXCHANGE",
    status: "SUCCESS",
    modifiedAt: daysAgo(91),
    observedAt: daysAgo(90),
  });
  await redactExpiredSalesChannelPersonalData();
  assert(
    (await rawOrder("ORDER-EXCHANGE", "SHIP-EXCHANGE")).receiver_name !==
      "수령자",
    "SUCCESS must be treated as a terminal exchange status."
  );

  await createRawOrder("ORDER-FALLBACK", "SHIP-FALLBACK");
  await recordDelivery("ORDER-FALLBACK", "SHIP-FALLBACK", daysAgo(150));
  await observeReturn({
    receiptId: "RETURN-FALLBACK",
    orderId: "ORDER-FALLBACK",
    shipmentId: "SHIP-FALLBACK",
    status: "RETURNS_COMPLETED",
    completedAt: null,
    observedAt: daysAgo(95),
  });
  const fallbackRun = await redactExpiredSalesChannelPersonalData();
  assert(
    fallbackRun.fallbackTimestamp >= 1,
    "A missing external terminal timestamp must use detected_at and be reported."
  );

  const beforeNoOp =
    await prisma.sales_channel_personal_data_lifecycles.findFirstOrThrow({
      where: {
        external_order_id: "ORDER-FALLBACK",
        external_shipment_id: "SHIP-FALLBACK",
      },
    });
  await prisma.$transaction((tx) =>
    reconcilePersonalDataLifecyclesForOrder(tx, {
      externalOrderId: "ORDER-FALLBACK",
      externalShipmentId: "SHIP-FALLBACK",
      now: quickHackClock.nowDate(),
    })
  );
  const afterNoOp =
    await prisma.sales_channel_personal_data_lifecycles.findFirstOrThrow({
      where: {
        external_order_id: "ORDER-FALLBACK",
        external_shipment_id: "SHIP-FALLBACK",
      },
    });
  assert(
    beforeNoOp.retention_started_at?.getTime() ===
        afterNoOp.retention_started_at?.getTime() &&
      beforeNoOp.updated_at.getTime() === afterNoOp.updated_at.getTime(),
    "A no-op observation must not move the retention clock or projection timestamp."
  );

  await persistCoupangOrderRawSnapshots([
    orderInput("ORDER-DELIVERED", "SHIP-DELIVERED", {
      receiverName: "재노출 수령자",
      receiverSafeNumber: "050799998888",
    }),
  ], await reserveSalesChannelProjectionObservation());
  const blockedRehydration = await rawOrder(
    "ORDER-DELIVERED",
    "SHIP-DELIVERED"
  );
  assert(
    blockedRehydration.receiver_name !== "재노출 수령자" &&
      blockedRehydration.receiver_safe_number.endsWith("8888"),
    "Ordinary order sync must not rehydrate expired delivery PII."
  );

  await observeReturn({
    receiptId: "RETURN-NEW-CYCLE",
    orderId: "ORDER-DELIVERED",
    shipmentId: "SHIP-DELIVERED",
    status: "RETURNS_UNCHECKED",
    observedAt: quickHackClock.nowDate(),
  });
  await persistCoupangOrderRawSnapshots([
    orderInput("ORDER-DELIVERED", "SHIP-DELIVERED", {
      receiverName: "신규 업무 수령자",
      receiverSafeNumber: "050711112222",
    }),
  ], await reserveSalesChannelProjectionObservation());
  const reopenedCycle = await rawOrder(
    "ORDER-DELIVERED",
    "SHIP-DELIVERED"
  );
  assert(
    reopenedCycle.receiver_name === "신규 업무 수령자" &&
      reopenedCycle.receiver_safe_number === "050711112222",
    "A genuinely new active claim may store newly synchronized operational PII."
  );

  console.log("Personal-data lifecycle integration tests passed.");
} finally {
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
