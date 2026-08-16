import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";
import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-order-matching-multi-shipment-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let matchingWorkerLease;

function inventoryResponse(vendorItemId, quantity) {
  return {
    mode: "mock",
    source: "mock:order-matching-inventory-verification",
    requestPath: `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`,
    httpStatusCode: 200,
    responseHash: `order-matching-${vendorItemId}-${quantity}`,
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "test",
      keyFingerprint: "test-fingerprint",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload: {
      vendorItemId,
      amountInStock: quantity,
      salePrice: null,
      onSale: true,
      checkedAt: new Date("2026-07-19T13:10:00.000Z"),
    },
  };
}

function successfulWriteResponse(command) {
  return {
    mode: "mock",
    source: "integration-test",
    requestPath: "/integration-test/order-acknowledgement",
    httpStatusCode: 200,
    responseHash: "integration-test-order-acknowledgement",
    auth: {},
    payload: {
      code: "200",
      message: "OK",
      data: {
        responseCode: 0,
        responseMessage: "SUCCESS",
        responseList: command.shipmentBoxIds.map((shipmentBoxId) => ({
          shipmentBoxId,
          succeed: true,
          resultCode: "OK",
          retryRequired: false,
          resultMessage: null,
        })),
      },
    },
  };
}

async function withCommittedFinalizationAcknowledgementLoss(run) {
  const originalTransaction = prisma.$transaction;
  let injected = false;

  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    if (
      !injected &&
      (result === "COMPLETED" || result === "PARTIALLY_COMPLETED")
    ) {
      injected = true;
      throw new Error("forced post-commit acknowledgement loss");
    }
    return result;
  };

  try {
    const result = await run();
    assert(injected, "The post-commit acknowledgement loss was not injected.");
    return result;
  } finally {
    prisma.$transaction = originalTransaction;
  }
}

async function createOrderFixture(ledgerApi) {
  const timestamp = new Date("2026-07-19T13:00:00.000Z");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "multi-shipment",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: 3, timestamp }
  );
  const externalOrderId = "ORDER-MULTI-SHIPMENT-1";
  const shipments = [
    {
      externalShipmentId: "SHIP-MULTI-1",
      externalVendorItemId: "VENDOR-MULTI-1",
      quantity: 2,
    },
    {
      externalShipmentId: "SHIP-MULTI-2",
      externalVendorItemId: "VENDOR-MULTI-2",
      quantity: 1,
    },
  ];

  for (const shipment of shipments) {
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: shipment.externalVendorItemId,
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: shipment.externalShipmentId,
        external_order_status: "INSTRUCT",
        ordered_at: timestamp,
        synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.order_matching_work_queue.create({
      data: {
        channel: "COUPANG",
        external_order_id: externalOrderId,
        external_shipment_id: shipment.externalShipmentId,
        external_vendor_item_id: shipment.externalVendorItemId,
        vendor_item_name: shipment.externalVendorItemId,
        ordered_quantity: shipment.quantity,
        matchable_quantity: shipment.quantity,
        mapping_status: "MAPPED",
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        ...catalog.orderMappingSnapshot,
        work_status: "UNMATCHED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }

  return { timestamp, catalog, devices, externalOrderId, shipments };
}

async function assertMultiShipmentMatchingIsStable(matchingApi, ledgerApi) {
  const fixture = await createOrderFixture(ledgerApi);
  let inventoryReadCount = 0;
  const inventoryVerification = {
    openCredentialContext: async () => ({ test: true }),
    getInventory: async (vendorItemId) => {
      inventoryReadCount += 1;
      const allocations = await prisma.match_worker_allocation.findMany({
        where: { external_order_id: fixture.externalOrderId },
      });
      assert(
        allocations.length === 3 &&
          allocations.every(
            (allocation) => allocation.allocation_status === "API_ACKED"
          ),
        "Inventory verification started before acknowledgement finalization."
      );
      return inventoryResponse(String(vendorItemId), 0);
    },
  };
  const firstRun = await matchingApi.matchCoupangOrders(
    { limit: 20 },
    null,
    matchingWorkerLease,
    { inventoryVerification }
  );

  assert(firstRun.summary.processedItemCount === 2, "Both work items were not processed.");
  assert(firstRun.summary.matchedDeviceCount === 3, "Three devices were not matched.");
  assert(
    firstRun.summary.coupangAcknowledgement.alreadyInstructCount === 2,
    "Already-INSTRUCT shipments were not independently verified."
  );
  assert(
    firstRun.summary.coupangAcknowledgement.requestedCount === 0,
    "An already-INSTRUCT shipment incorrectly called the write API."
  );
  assert(
    firstRun.summary.inventoryVerification.candidateMappingCount === 2 &&
      firstRun.summary.inventoryVerification.matchedCount === 2 &&
      inventoryReadCount === 2,
    "The matching cycle did not verify each affected Coupang option exactly once."
  );

  const [allocations, workItems, inventories, balances, writeRequestCount] =
    await Promise.all([
      prisma.match_worker_allocation.findMany({
        where: { external_order_id: fixture.externalOrderId },
        orderBy: { allocation_id: "asc" },
      }),
      prisma.order_matching_work_queue.findMany({
        where: { external_order_id: fixture.externalOrderId },
        orderBy: { work_item_id: "asc" },
      }),
      prisma.inventory.findMany({
        where: { pg_no: { in: fixture.devices.map((device) => device.pgNo) } },
      }),
      prisma.inventory_quantity_balances.findMany({
        where: { inventory_sku_id: fixture.catalog.sku.inventory_sku_id },
      }),
      prisma.sales_channel_write_requests.count(),
    ]);

  assert(allocations.length === 3, "The worker created an incorrect allocation count.");
  assert(
    allocations.every((allocation) => allocation.allocation_status === "API_ACKED"),
    "Verified allocations were not moved to API_ACKED."
  );
  assert(
    allocations.filter(
      (allocation) =>
        allocation.external_shipment_id === fixture.shipments[0].externalShipmentId &&
        allocation.external_vendor_item_id === fixture.shipments[0].externalVendorItemId
    ).length === 2,
    "The first shipment did not keep exactly two PG allocations."
  );
  assert(
    allocations.filter(
      (allocation) =>
        allocation.external_shipment_id === fixture.shipments[1].externalShipmentId &&
        allocation.external_vendor_item_id === fixture.shipments[1].externalVendorItemId
    ).length === 1,
    "The second shipment did not keep exactly one PG allocation."
  );
  assert(
    new Set(allocations.map((allocation) => allocation.pg_no)).size === 3,
    "A PG was allocated to more than one shipment."
  );
  assert(
    workItems.every(
      (item) => item.work_status === "MATCHED" && item.work_failure_reason === null
    ),
    "A fully matched work item did not finish as MATCHED."
  );
  assert(
    inventories.every((inventory) => inventory.inventory_status === "RESERVED"),
    "Matched inventory was not reserved."
  );
  assert(writeRequestCount === 0, "The verified-read path persisted a write request.");

  const quantityByStatus = new Map(
    balances.map((balance) => [balance.inventory_status, balance.quantity])
  );
  assert(quantityByStatus.get("SELLABLE") === 0, "SELLABLE balance is incorrect.");
  assert(quantityByStatus.get("RESERVED") === 3, "RESERVED balance is incorrect.");

  for (const device of fixture.devices) {
    const movements = await prisma.inventory_quantity_movements.findMany({
      where: { pg_no: device.pgNo },
      orderBy: { inventory_quantity_movement_id: "asc" },
    });

    assert(
      movements.length === 3 &&
        movements[0].quantity_delta === 1 &&
        movements[1].quantity_delta === -1 &&
        movements[2].quantity_delta === 1,
      `Inventory ledger transfer is incorrect for ${device.pgNo}.`
    );
  }

  const movementCountBeforeRepeat = await prisma.inventory_quantity_movements.count();
  const previousFailure =
    await prisma.sales_channel_inventory_verification_states.findFirstOrThrow({
      orderBy: { verification_state_id: "asc" },
    });
  await prisma.sales_channel_inventory_verification_states.update({
    where: { verification_state_id: previousFailure.verification_state_id },
    data: {
      verification_status: "CHECK_FAILED",
      last_error_code: "PREVIOUS_CYCLE_FAILURE",
      last_error_message: "Must remain until a related cycle or manual recheck.",
      state_revision: { increment: 1 },
    },
  });
  const secondRun = await matchingApi.matchCoupangOrders(
    { limit: 20 },
    null,
    matchingWorkerLease,
    { inventoryVerification }
  );
  const [allocationCountAfterRepeat, movementCountAfterRepeat] = await Promise.all([
    prisma.match_worker_allocation.count({
      where: { external_order_id: fixture.externalOrderId },
    }),
    prisma.inventory_quantity_movements.count(),
  ]);

  assert(secondRun.summary.processedItemCount === 0, "Matched items were processed again.");
  assert(allocationCountAfterRepeat === 3, "A repeated worker cycle duplicated allocations.");
  assert(
    movementCountAfterRepeat === movementCountBeforeRepeat,
    "A repeated worker cycle duplicated quantity-ledger movements."
  );
  assert(
    inventoryReadCount === 2 &&
      secondRun.summary.inventoryVerification.requestedCount === 0,
    "A cycle without new matching work automatically retried an old failed check."
  );
  const unchangedFailure =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: previousFailure.verification_state_id,
      },
    });
  assert(
    unchangedFailure.verification_status === "CHECK_FAILED" &&
      unchangedFailure.last_error_code === "PREVIOUS_CYCLE_FAILURE",
    "The previous cycle failure was changed without a related matching event."
  );

  const relatedShipmentId = "SHIP-MULTI-RELATED-3";
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: fixture.externalOrderId,
      external_shipment_id: relatedShipmentId,
      external_order_status: "INSTRUCT",
      ordered_at: fixture.timestamp,
      synced_at: fixture.timestamp,
      created_at: fixture.timestamp,
      updated_at: fixture.timestamp,
    },
  });
  await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: fixture.externalOrderId,
      external_shipment_id: relatedShipmentId,
      external_vendor_item_id: fixture.shipments[0].externalVendorItemId,
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: fixture.catalog.salesOffer.sales_offer_id,
      ...fixture.catalog.orderMappingSnapshot,
      work_status: "UNMATCHED",
      created_at: fixture.timestamp,
      updated_at: fixture.timestamp,
    },
  });
  const relatedRun = await matchingApi.matchCoupangOrders(
    { limit: 20 },
    null,
    matchingWorkerLease,
    { inventoryVerification }
  );
  const recheckedFailure =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: previousFailure.verification_state_id,
      },
    });
  assert(
    relatedRun.summary.processedItemCount === 1 &&
      relatedRun.summary.failedItemCount === 1,
    "The related no-stock order did not complete its matching cycle as failed."
  );
  assert(
    relatedRun.summary.inventoryVerification.requestedCount === 2 &&
      inventoryReadCount === 4,
    "A new related matching event did not recheck every mapped option once."
  );
  assert(
    recheckedFailure.verification_status === "MATCHED" &&
      recheckedFailure.last_error_code === null,
    "The related matching event did not resolve the previous failed check."
  );
}

async function createMixedShipmentStatusFixture(
  ledgerApi,
  { suffix, reverseRawInsertOrder }
) {
  const timestamp = new Date("2026-07-19T14:00:00.000Z");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: `mixed-shipment-${suffix}`,
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: 2, timestamp }
  );
  const externalOrderId = `ORDER-MIXED-SHIPMENT-${suffix}`;
  const shipments = [
    {
      externalShipmentId: `SHIP-MIXED-INSTRUCT-${suffix}`,
      externalVendorItemId: `VENDOR-MIXED-INSTRUCT-${suffix}`,
      status: "INSTRUCT",
    },
    {
      externalShipmentId: `SHIP-MIXED-ACCEPT-${suffix}`,
      externalVendorItemId: `VENDOR-MIXED-ACCEPT-${suffix}`,
      status: "ACCEPT",
    },
  ];

  for (const shipment of shipments) {
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: shipment.externalVendorItemId,
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  }

  const rawInsertOrder = reverseRawInsertOrder
    ? [...shipments].reverse()
    : shipments;

  for (const shipment of rawInsertOrder) {
    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: shipment.externalShipmentId,
        external_order_status: shipment.status,
        ordered_at: timestamp,
        synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }

  const workItemIds = [];

  for (const shipment of shipments) {
    const workItem = await prisma.order_matching_work_queue.create({
      data: {
        channel: "COUPANG",
        external_order_id: externalOrderId,
        external_shipment_id: shipment.externalShipmentId,
        external_vendor_item_id: shipment.externalVendorItemId,
        vendor_item_name: shipment.externalVendorItemId,
        ordered_quantity: 1,
        matchable_quantity: 1,
        mapping_status: "MAPPED",
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        ...catalog.orderMappingSnapshot,
        work_status: "UNMATCHED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    });

    workItemIds.push(workItem.work_item_id);
  }

  return {
    timestamp,
    devices,
    externalOrderId,
    shipments,
    workItemIds,
  };
}

async function assertMixedShipmentStatusesAreIsolated(
  matchingApi,
  ledgerApi,
  options
) {
  const fixture = await createMixedShipmentStatusFixture(ledgerApi, options);
  const instructShipment = fixture.shipments.find(
    (shipment) => shipment.status === "INSTRUCT"
  );
  const acceptShipment = fixture.shipments.find(
    (shipment) => shipment.status === "ACCEPT"
  );

  assert(instructShipment && acceptShipment, "Mixed shipment fixture is invalid.");

  const writeCommands = [];
  const requestWrite = async (command) => {
    writeCommands.push(command);
    throw new Error("TEST_WRITE_BLOCKED_AFTER_TARGET_CAPTURE");
  };
  const inventoryVerification = {
    openCredentialContext: async () => ({ test: true }),
    getInventory: async (vendorItemId) =>
      inventoryResponse(String(vendorItemId), 0),
  };
  const firstRun = await matchingApi.matchCoupangOrders(
    { workItemIds: fixture.workItemIds },
    null,
    matchingWorkerLease,
    { inventoryVerification, requestWrite }
  );
  const acknowledgement = firstRun.summary.coupangAcknowledgement;

  assert(
    firstRun.summary.processedItemCount === 2 &&
      firstRun.summary.matchedDeviceCount === 2,
    "The mixed-status shipments were not both matched."
  );
  assert(
    acknowledgement.candidateCount === 2 &&
      acknowledgement.alreadyInstructCount === 1 &&
      acknowledgement.requestedCount === 1 &&
      acknowledgement.failedCount === 1,
    `Mixed shipment acknowledgement was not isolated: ${JSON.stringify(acknowledgement)}`
  );
  assert(
    writeCommands.length === 1 &&
      writeCommands[0].shipmentBoxIds.length === 1 &&
      writeCommands[0].shipmentBoxIds[0] ===
        acceptShipment.externalShipmentId,
    "The ACCEPT write request included the wrong shipmentBoxId."
  );
  assert(
    writeCommands[0].targets.length === 1 &&
      writeCommands[0].targets[0].externalOrderId ===
        fixture.externalOrderId &&
      writeCommands[0].targets[0].externalShipmentId ===
        acceptShipment.externalShipmentId,
    "The persisted write target did not retain the exact order-shipment pair."
  );
  assert(
    acknowledgement.failures.some(
      (failure) =>
        failure.externalShipmentId === acceptShipment.externalShipmentId
    ) &&
      !acknowledgement.failures.some(
        (failure) =>
          failure.externalShipmentId === instructShipment.externalShipmentId
      ),
    "The simulated write failure leaked to the already-INSTRUCT shipment."
  );

  const allocationsAfterFailure =
    await prisma.match_worker_allocation.findMany({
      where: { external_order_id: fixture.externalOrderId },
      include: {
        device: {
          include: { inventory: true },
        },
      },
    });
  const allocationByShipmentId = new Map(
    allocationsAfterFailure.map((allocation) => [
      allocation.external_shipment_id,
      allocation,
    ])
  );
  const instructAllocation = allocationByShipmentId.get(
    instructShipment.externalShipmentId
  );
  const acceptAllocation = allocationByShipmentId.get(
    acceptShipment.externalShipmentId
  );

  assert(
    instructAllocation?.allocation_status === "API_ACKED" &&
      instructAllocation.device.inventory?.inventory_status === "RESERVED",
    "The exact INSTRUCT shipment was not acknowledged and reserved."
  );
  assert(
    acceptAllocation?.allocation_status === "ALLOCATED" &&
      acceptAllocation.device.inventory?.inventory_status === "RESERVED",
    "A failed ACCEPT write changed allocation or inventory state."
  );

  const movementCountBeforeRecovery = new Map();

  for (const allocation of allocationsAfterFailure) {
    movementCountBeforeRecovery.set(
      allocation.external_shipment_id,
      await prisma.inventory_quantity_movements.count({
        where: { pg_no: allocation.pg_no },
      })
    );
  }

  const recoveredAt = new Date("2026-07-19T14:10:00.000Z");
  await prisma.coupang_order_raw.update({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: fixture.externalOrderId,
        external_shipment_id: acceptShipment.externalShipmentId,
      },
    },
    data: {
      external_order_status: "INSTRUCT",
      synced_at: recoveredAt,
      updated_at: recoveredAt,
    },
  });

  await matchingApi.matchCoupangOrders(
    { limit: 20 },
    null,
    matchingWorkerLease,
    { inventoryVerification, requestWrite }
  );

  const allocationsAfterRecovery =
    await prisma.match_worker_allocation.findMany({
      where: { external_order_id: fixture.externalOrderId },
      include: {
        device: {
          include: { inventory: true },
        },
      },
    });

  assert(
    writeCommands.length === 1,
    "An observed INSTRUCT shipment incorrectly retried the write API."
  );
  assert(
    allocationsAfterRecovery.every(
      (allocation) =>
        allocation.allocation_status === "API_ACKED" &&
        allocation.device.inventory?.inventory_status === "RESERVED"
    ),
    "The recovered shipment did not reach API_ACKED and RESERVED."
  );

  for (const allocation of allocationsAfterRecovery) {
    const movementCount = await prisma.inventory_quantity_movements.count({
      where: { pg_no: allocation.pg_no },
    });
    const previousCount = movementCountBeforeRecovery.get(
      allocation.external_shipment_id
    );
    assert(
      movementCount === previousCount,
      `Recovery created incorrect ledger movements for ${allocation.external_shipment_id}.`
    );
  }
}

async function assertAddressRefreshFailureDoesNotReclassifyAcknowledgement(
  matchingApi,
  writeApi,
  ledgerApi
) {
  const fixture = await createMixedShipmentStatusFixture(ledgerApi, {
    suffix: "ADDRESS-REFRESH-FAILURE",
    reverseRawInsertOrder: false,
  });
  let refreshCalls = 0;
  const requestWrite = (command, lifecycle, _dependencies, options) =>
    writeApi.requestSalesChannelWrite(
      command,
      lifecycle,
      {
        executeWrite: async (writeCommand) =>
          successfulWriteResponse(writeCommand),
      },
      options
    );
  const inventoryVerification = {
    openCredentialContext: async () => ({ test: true }),
    getInventory: async (vendorItemId) =>
      inventoryResponse(String(vendorItemId), 0),
  };
  const result = await matchingApi.matchCoupangOrders(
    { workItemIds: fixture.workItemIds },
    null,
    matchingWorkerLease,
    {
      inventoryVerification,
      requestWrite,
      refreshInstructOrderAddresses: async () => {
        refreshCalls += 1;
        throw new Error("forced address refresh failure");
      },
    }
  );
  const acknowledgement = result.summary.coupangAcknowledgement;
  const allocations = await prisma.match_worker_allocation.findMany({
    where: { external_order_id: fixture.externalOrderId },
    include: { device: { include: { inventory: true } } },
  });
  const rawOrders = await prisma.coupang_order_raw.findMany({
    where: { external_order_id: fixture.externalOrderId },
  });

  assert(refreshCalls === 1, "The post-acknowledgement address read was not attempted once.");
  assert(
    acknowledgement.requestedCount === 1 &&
      acknowledgement.writeSucceededCount === 1 &&
      acknowledgement.failedCount === 0,
    "Address refresh failure was reclassified as acknowledgement failure."
  );
  assert(
    acknowledgement.addressRefreshCandidateCount === 1 &&
      acknowledgement.addressRefreshSucceededCount === 0 &&
      acknowledgement.addressRefreshFailedCount === 1 &&
      acknowledgement.postAcknowledgementRefresh?.result.status === "FAILED",
    "Address refresh failure was not isolated in the acknowledgement summary."
  );
  assert(
    result.summary.postAcknowledgementRefresh?.result.status === "FAILED",
    "The top-level matching summary did not expose the address refresh warning."
  );
  assert(
    allocations.length === 2 &&
      allocations.every(
        (allocation) =>
          allocation.allocation_status === "API_ACKED" &&
          allocation.device.inventory?.inventory_status === "RESERVED"
      ),
    "Address refresh failure rolled back API_ACKED allocations or RESERVED inventory."
  );
  assert(
    rawOrders.every((order) => order.external_order_status === "INSTRUCT"),
    "Confirmed acknowledgement was not projected before the optional address refresh."
  );
}

async function assertCommittedFinalizationRecoveryPreservesMatchingSummary(
  matchingApi,
  writeApi,
  ledgerApi
) {
  const fixture = await createMixedShipmentStatusFixture(ledgerApi, {
    suffix: "COMMIT-ACK-LOSS",
    reverseRawInsertOrder: false,
  });
  let writeCalls = 0;
  let recoveredWriteResult = null;
  let addressRefreshInput = null;
  const requestWrite = async (command, lifecycle, _dependencies, options) => {
    recoveredWriteResult = await withCommittedFinalizationAcknowledgementLoss(
      () =>
        writeApi.requestSalesChannelWrite(
          command,
          lifecycle,
          {
            executeWrite: async (writeCommand) => {
              writeCalls += 1;
              return successfulWriteResponse(writeCommand);
            },
          },
          options
        )
    );
    return recoveredWriteResult;
  };
  const result = await matchingApi.matchCoupangOrders(
    { workItemIds: fixture.workItemIds },
    null,
    matchingWorkerLease,
    {
      inventoryVerification: {
        openCredentialContext: async () => ({ test: true }),
        getInventory: async (vendorItemId) =>
          inventoryResponse(String(vendorItemId), 0),
      },
      requestWrite,
      refreshInstructOrderAddresses: async (input) => {
        addressRefreshInput = {
          requestId: input.requestId,
          targetIds: [...input.targetIds],
        };
        return {
          status: "SUCCEEDED",
          code: "TEST_ADDRESS_REFRESH_SUCCEEDED",
          endpointPath: "/integration-test/ordersheets",
          targetCount: input.targetIds.length,
          refreshedTargetCount: input.targetIds.length,
          failedTargetCount: 0,
        };
      },
    }
  );
  const acknowledgement = result.summary.coupangAcknowledgement;
  const storedRequest =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { sales_channel_write_request_id: recoveredWriteResult.requestId },
      include: { targets: { orderBy: { target_position: "asc" } } },
    });
  const expectedTargetIds = storedRequest.targets
    .filter(
      (target) =>
        target.external_result_status === "SUCCEEDED" &&
        target.local_finalization_status === "SUCCEEDED" &&
        target.local_finalized_at?.getTime() ===
          storedRequest.local_finalized_at?.getTime()
    )
    .map((target) => target.sales_channel_write_request_target_id);
  const [allocations, rawOrders] = await Promise.all([
    prisma.match_worker_allocation.findMany({
      where: { external_order_id: fixture.externalOrderId },
      include: { device: { include: { inventory: true } } },
    }),
    prisma.coupang_order_raw.findMany({
      where: { external_order_id: fixture.externalOrderId },
    }),
  ]);

  assert(writeCalls === 1, "Commit recovery resent the Coupang write.");
  assert(
    recoveredWriteResult.status === "COMPLETED" &&
      JSON.stringify(recoveredWriteResult.targetIds) ===
        JSON.stringify(expectedTargetIds),
    "The matching dependency did not receive the committed target IDs."
  );
  assert(
    addressRefreshInput?.requestId === recoveredWriteResult.requestId &&
      JSON.stringify(addressRefreshInput.targetIds) ===
        JSON.stringify(expectedTargetIds),
    "The committed target IDs were not forwarded to address refresh."
  );
  assert(
    acknowledgement.candidateCount === 2 &&
      acknowledgement.alreadyInstructCount === 1 &&
      acknowledgement.requestedCount === 1 &&
      acknowledgement.writeSucceededCount === 1 &&
      acknowledgement.succeededCount === 2 &&
      acknowledgement.failedCount === 0 &&
      acknowledgement.addressRefreshCandidateCount === 1 &&
      acknowledgement.addressRefreshSucceededCount === 1 &&
      acknowledgement.addressRefreshFailedCount === 0,
    `Commit recovery changed the matching summary: ${JSON.stringify(acknowledgement)}`
  );
  assert(
    allocations.length === 2 &&
      allocations.every(
        (allocation) =>
          allocation.allocation_status === "API_ACKED" &&
          allocation.device.inventory?.inventory_status === "RESERVED"
      ),
    "Commit recovery left an allocation or inventory in the wrong state."
  );
  assert(
    rawOrders.length === 2 &&
      rawOrders.every((order) => order.external_order_status === "INSTRUCT"),
    "Commit recovery left a raw order before INSTRUCT."
  );
  for (const allocation of allocations) {
    const movements = await prisma.inventory_quantity_movements.findMany({
      where: { pg_no: allocation.pg_no },
    });
    assert(
      movements.length === 3,
      `Commit recovery duplicated ledger movements for ${allocation.pg_no}.`
    );
  }
}

async function assertAmbiguousConfirmationSnapshotIsReused(
  matchingApi,
  writeApi,
  ledgerApi
) {
  const fixture = await createMixedShipmentStatusFixture(ledgerApi, {
    suffix: "AMBIGUOUS-SNAPSHOT-REUSE",
    reverseRawInsertOrder: false,
  });
  let confirmationReads = 0;
  let addressRefreshCalls = 0;
  const requestWrite = (command, lifecycle, _dependencies, options) =>
    writeApi.requestSalesChannelWrite(
      command,
      lifecycle,
      {
        executeWrite: async () => {
          throw new Error("fetch failed after the channel applied the write");
        },
        verifyWrite: async ({ requestId }) => {
          confirmationReads += 1;
          const persistedTargets =
            await prisma.sales_channel_write_request_targets.findMany({
              where: { sales_channel_write_request_id: requestId },
              orderBy: { target_position: "asc" },
            });
          return {
            outcome: "CONFIRMED",
            code: "INSTRUCT_CONFIRMED",
            message: "confirmed by one targeted read",
            endpointPath: "/integration-test/ordersheets",
            targetCount: command.targets.length,
            confirmedCount: command.targets.length,
            targetGroups: persistedTargets.map((target) => ({
              groupKey: `SHIPMENT:${target.external_shipment_id}`,
              targetIds: [target.sales_channel_write_request_target_id],
              outcome: "CONFIRMED",
              code: "INSTRUCT_CONFIRMED",
            })),
            observedStatuses: command.targets.map((target) => ({
              externalOrderId: target.externalOrderId,
              externalShipmentId: target.externalShipmentId,
              externalReceiptId: null,
              observedStatus: "INSTRUCT",
            })),
          };
        },
      },
      options
    );
  const result = await matchingApi.matchCoupangOrders(
    { workItemIds: fixture.workItemIds },
    null,
    matchingWorkerLease,
    {
      inventoryVerification: {
        openCredentialContext: async () => ({ test: true }),
        getInventory: async (vendorItemId) =>
          inventoryResponse(String(vendorItemId), 0),
      },
      requestWrite,
      refreshInstructOrderAddresses: async () => {
        addressRefreshCalls += 1;
        throw new Error("a second read must not run");
      },
    }
  );
  const acknowledgement = result.summary.coupangAcknowledgement;
  const rawOrders = await prisma.coupang_order_raw.findMany({
    where: { external_order_id: fixture.externalOrderId },
  });

  assert(
    confirmationReads === 1 && addressRefreshCalls === 0,
    "Ambiguous confirmation performed a second address read."
  );
  assert(
    acknowledgement.ambiguousWriteConfirmationReadCount === 1 &&
      acknowledgement.addressRefreshSucceededCount === 1 &&
      acknowledgement.addressRefreshFailedCount === 0 &&
      acknowledgement.postAcknowledgementRefresh?.source ===
        "AMBIGUOUS_CONFIRMATION_SNAPSHOT_REUSED",
    "The ambiguous confirmation snapshot was not represented as the address baseline."
  );
  assert(
    rawOrders.every((order) => order.external_order_status === "INSTRUCT"),
    "Ambiguous-write confirmation did not finalize the local order status."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const matchingApi = await import(
    "@/quickhack_server/sales-channel/coupang/order-matching-service"
  );
  const writeApi = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const { ensureRegisteredWorkerJobs } = await import(
    "@/quickhack_server/workers/worker-jobs"
  );
  const { ORDER_MATCHING_WORKER_KEY } = await import(
    "@/quickhack_server/workers/worker-keys"
  );
  await ensureRegisteredWorkerJobs();
  const matchingWorkerJob =
    await prisma.server_worker_jobs.findUniqueOrThrow({
      where: { worker_key: ORDER_MATCHING_WORKER_KEY },
    });
  matchingWorkerLease = {
    workerJobId: matchingWorkerJob.worker_job_id,
    leaseToken: "multi-shipment-matching-worker-lease",
    signal: new AbortController().signal,
    assertLeaseActive: async () => undefined,
  };
  let missingLeaseError = null;
  try {
    await matchingApi.matchCoupangOrders({ limit: 1 }, null, undefined);
  } catch (error) {
    missingLeaseError = error;
  }
  assert(
    missingLeaseError?.code === "WORKER_LEASE_REQUIRED",
    "Order matching entered without an owned worker lease."
  );

  await assertMultiShipmentMatchingIsStable(matchingApi, ledgerApi);
  await assertMixedShipmentStatusesAreIsolated(matchingApi, ledgerApi, {
    suffix: "FORWARD",
    reverseRawInsertOrder: false,
  });
  await assertMixedShipmentStatusesAreIsolated(matchingApi, ledgerApi, {
    suffix: "REVERSE",
    reverseRawInsertOrder: true,
  });
  await assertAddressRefreshFailureDoesNotReclassifyAcknowledgement(
    matchingApi,
    writeApi,
    ledgerApi
  );
  await assertCommittedFinalizationRecoveryPreservesMatchingSummary(
    matchingApi,
    writeApi,
    ledgerApi
  );
  await assertAmbiguousConfirmationSnapshotIsReused(
    matchingApi,
    writeApi,
    ledgerApi
  );
  console.log(
    "Multi-shipment order matching, mixed-status isolation, committed-finalization recovery, address refresh isolation, and ledger idempotency verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
