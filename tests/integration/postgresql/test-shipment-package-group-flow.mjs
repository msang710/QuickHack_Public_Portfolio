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
  "quickhack-shipment-package-groups-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

async function createAllocationFixtures(ledgerApi, writeRules) {
  const timestamp = new Date("2026-07-21T09:00:00+09:00");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "shipment-package-group",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: 5, timestamp }
  );
  const orderInputs = [
    {
      receiverName: "합포장 고객",
      postCode: "12345",
      address1: "서울시 테스트구 같은로 1",
      address2: "101호",
      warranty: "2Y",
    },
    {
      receiverName: "합포장 고객",
      postCode: "12345",
      address1: "서울시 테스트구 같은로 1",
      address2: "101호",
      warranty: "1Y",
    },
    {
      receiverName: "단독 고객",
      postCode: "54321",
      address1: "부산시 테스트구 다른로 2",
      address2: "",
      warranty: "2Y",
    },
    {
      receiverName: "분할 고객",
      postCode: "77777",
      address1: "대전시 테스트구 분할로 3",
      address2: "201호",
      warranty: "2Y",
    },
    {
      receiverName: "분할 고객",
      postCode: "77777",
      address1: "대전시 테스트구 분할로 3",
      address2: "201호",
      warranty: "2Y",
    },
  ];
  const allocations = [];

  for (const [index, device] of devices.entries()) {
    const order = orderInputs[index];
    const externalOrderId = `PACKAGE-GROUP-ORDER-${index + 1}`;
    const externalShipmentId = `PACKAGE-GROUP-SHIPMENT-${index + 1}`;

    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_order_status: "INSTRUCT",
        ordered_at: new Date(`2026-07-21T09:0${index}:00+09:00`),
        receiver_name: order.receiverName,
        receiver_post_code: order.postCode,
        receiver_address_1: order.address1,
        receiver_address_2: order.address2,
        synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.order_matching_work_queue.create({
      data: {
        channel: "COUPANG",
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: `PACKAGE-GROUP-ITEM-${index + 1}`,
        ordered_quantity: 1,
        matchable_quantity: 1,
        mapping_status: "MAPPED",
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        required_model_label: catalog.options.model.label,
        required_storage_label: catalog.options.storage.label,
        required_color_label: catalog.options.color.label,
        required_warranty_group: order.warranty,
        work_status: "MATCHED",
        matched_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.$transaction((tx) =>
      ledgerApi.transitionInventoryStatusWithLedger(tx, {
        pgNo: device.pgNo,
        expectedFromStatus: "SELLABLE",
        toStatus: "RESERVED",
        transitionPolicy:
          writeRules.INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
        operationKey: `package-group-reserve:${device.pgNo}`,
        movementType:
          ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "INTEGRATION_TEST",
        sourceId: externalShipmentId,
        occurredAt: timestamp,
      })
    );
    allocations.push(
      await prisma.match_worker_allocation.create({
        data: {
          external_order_id: externalOrderId,
          external_shipment_id: externalShipmentId,
          external_vendor_item_id: `PACKAGE-GROUP-ITEM-${index + 1}`,
          pg_no: device.pgNo,
          sales_offer_id: catalog.salesOffer.sales_offer_id,
          inventory_sku_id: catalog.sku.inventory_sku_id,
          required_model: catalog.options.model.label,
          required_storage: catalog.options.storage.label,
          required_color: catalog.options.color.label,
          required_warranty_group: order.warranty,
          inventory_status_before_allocation: "SELLABLE",
          allocation_status: "API_ACKED",
          allocated_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      })
    );
  }

  return { allocations };
}

async function assertPrintGroupLifecycle(shipmentApi, allocations) {
  const groupedPrint = await shipmentApi.recordShipmentListPrint({
    allocationIds: [allocations[0].allocation_id],
    tabKey: "coupang-2y",
  });

  assert(groupedPrint.requestedCount === 1, "The requested row count changed.");
  assert(
    groupedPrint.printedCount === 2,
    "Selecting one member did not expand the entire package group."
  );
  assert(
    groupedPrint.packageGroupCount === 1,
    "Two co-packaged PGs were counted as more than one box."
  );

  const groupedBatchItems =
    await prisma.sales_channel_shipment_list_print_batch_items.findMany({
      where: { shipment_list_print_batch_id: groupedPrint.batchId },
      orderBy: { print_line_no: "asc" },
    });
  const packageGroupId = groupedBatchItems[0]?.package_group_id;

  assert(groupedBatchItems.length === 2, "The batch snapshot lost a group member.");
  assert(
    packageGroupId &&
      groupedBatchItems.every(
        (item) => item.package_group_id === packageGroupId
      ),
    "Co-packaged batch items were assigned to different package groups."
  );
  assert(
    (await prisma.shipment_package_group_members.count({
      where: { package_group_id: packageGroupId, removed_at: null },
    })) === 2,
    "The package group membership snapshot is incomplete."
  );

  await shipmentApi.confirmShipmentListPrintBatch({
    batchId: groupedPrint.batchId,
  });
  const frozenGroup = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: packageGroupId },
  });
  assert(frozenGroup.group_status === "FROZEN", "Confirmation did not freeze the group.");

  const confirmedMovementCount =
    await prisma.inventory_quantity_movements.count();
  const confirmedAuditCount = await prisma.employee_activity_logs.count({
    where: {
      action_type: "SHIPMENT_LIST_PRINT_BATCH_CONFIRMED",
      target_id: String(groupedPrint.batchId),
    },
  });
  await shipmentApi.confirmShipmentListPrintBatch({
    batchId: groupedPrint.batchId,
  });
  assert(
    (await prisma.inventory_quantity_movements.count()) ===
      confirmedMovementCount,
    "Repeated confirmation duplicated inventory movements."
  );
  assert(
    (await prisma.employee_activity_logs.count({
      where: {
        action_type: "SHIPMENT_LIST_PRINT_BATCH_CONFIRMED",
        target_id: String(groupedPrint.batchId),
      },
    })) === confirmedAuditCount,
    "Repeated confirmation duplicated its audit event."
  );

  let confirmedCancelError;
  try {
    await shipmentApi.cancelShipmentListPrintBatch({
      batchId: groupedPrint.batchId,
    });
  } catch (error) {
    confirmedCancelError = error;
  }
  assert(
    confirmedCancelError?.code === "SHIPMENT_PRINT_BATCH_STATE_CONFLICT",
    "A stale cancellation was allowed to overwrite a confirmed print batch."
  );

  await prisma.sales_channel_shipment_list_print_batches.update({
    where: { shipment_list_print_batch_id: groupedPrint.batchId },
    data: { print_date: new Date("2025-01-01T00:00:00.000Z") },
  });
  const focusedOldBatch = await shipmentApi.listShipmentPrintBatches({
    tabKey: "coupang-2y",
    focusBatchId: groupedPrint.batchId,
  });
  assert(
    focusedOldBatch.focusBatchFound &&
      focusedOldBatch.batches.some(
        (batch) => batch.batchId === groupedPrint.batchId
      ),
    "An older focused print batch was not included in the output navigation list."
  );
  const mismatchedFocusedBatch = await shipmentApi.listShipmentPrintBatches({
    tabKey: "coupang-1y",
    focusBatchId: groupedPrint.batchId,
  });
  assert(
    mismatchedFocusedBatch.focusBatchFound === false &&
      !mismatchedFocusedBatch.batches.some(
        (batch) => batch.batchId === groupedPrint.batchId
      ),
    "A focused print batch leaked into a different warranty tab."
  );

  const canceledPrint = await shipmentApi.recordShipmentListPrint({
    allocationIds: [allocations[2].allocation_id],
    tabKey: "coupang-2y",
  });
  await shipmentApi.cancelShipmentListPrintBatch({
    batchId: canceledPrint.batchId,
  });
  const canceledItem =
    await prisma.sales_channel_shipment_list_print_batch_items.findFirstOrThrow({
      where: { shipment_list_print_batch_id: canceledPrint.batchId },
    });
  const canceledGroup = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: canceledItem.package_group_id },
  });
  assert(
    canceledGroup.group_status === "CANCELED",
    "Canceling a print batch did not cancel its draft package group."
  );

  const canceledAuditCount = await prisma.employee_activity_logs.count({
    where: {
      action_type: "SHIPMENT_LIST_PRINT_BATCH_CANCELED",
      target_id: String(canceledPrint.batchId),
    },
  });
  await shipmentApi.cancelShipmentListPrintBatch({
    batchId: canceledPrint.batchId,
  });
  assert(
    (await prisma.employee_activity_logs.count({
      where: {
        action_type: "SHIPMENT_LIST_PRINT_BATCH_CANCELED",
        target_id: String(canceledPrint.batchId),
      },
    })) === canceledAuditCount,
    "Repeated cancellation duplicated its audit event."
  );

  let canceledConfirmError;
  try {
    await shipmentApi.confirmShipmentListPrintBatch({
      batchId: canceledPrint.batchId,
    });
  } catch (error) {
    canceledConfirmError = error;
  }
  assert(
    canceledConfirmError?.code === "SHIPMENT_PRINT_BATCH_STATE_CONFLICT",
    "A stale confirmation was allowed to reopen a canceled print batch."
  );

  const conflictedPrint = await shipmentApi.recordShipmentListPrint({
    allocationIds: [allocations[2].allocation_id],
    tabKey: "coupang-2y",
  });
  const conflictedItem =
    await prisma.sales_channel_shipment_list_print_batch_items.findFirstOrThrow({
      where: { shipment_list_print_batch_id: conflictedPrint.batchId },
    });
  await prisma.shipment_package_groups.update({
    where: { package_group_id: conflictedItem.package_group_id },
    data: { group_status: "FROZEN" },
  });

  let groupConflictError;
  try {
    await shipmentApi.cancelShipmentListPrintBatch({
      batchId: conflictedPrint.batchId,
    });
  } catch (error) {
    groupConflictError = error;
  }
  assert(
    groupConflictError?.code === "SHIPMENT_PACKAGE_GROUP_STATE_CONFLICT",
    "A changed package group did not stop print-batch cancellation."
  );
  const rolledBackBatch =
    await prisma.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
      where: { shipment_list_print_batch_id: conflictedPrint.batchId },
    });
  assert(
    rolledBackBatch.batch_status === "PENDING",
    "A failed group transition left the print batch partially canceled."
  );
  assert(
    (await prisma.employee_activity_logs.count({
      where: {
        action_type: "SHIPMENT_LIST_PRINT_BATCH_CANCELED",
        target_id: String(conflictedPrint.batchId),
      },
    })) === 0,
    "A rolled-back cancellation persisted an audit success event."
  );
}

async function assertDraftGroupSplit(packageGroupApi, allocations) {
  const splitCandidates = await prisma.match_worker_allocation.findMany({
    where: {
      allocation_id: {
        in: [allocations[3].allocation_id, allocations[4].allocation_id],
      },
    },
    include: { order: true },
  });
  const created = await prisma.$transaction((tx) =>
    packageGroupApi.createDraftShipmentPackageGroups(tx, {
      channel: "COUPANG",
      allocations: splitCandidates,
      createdAt: new Date("2026-07-21T09:20:00+09:00"),
    })
  );
  const parentGroupId = created.groups[0].package_group_id;
  const children = await prisma.$transaction((tx) =>
    packageGroupApi.splitDraftShipmentPackageGroup(tx, {
      packageGroupId: parentGroupId,
      allocationIds: [allocations[4].allocation_id],
      splitAt: new Date("2026-07-21T09:21:00+09:00"),
    })
  );
  const parent = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: parentGroupId },
  });

  assert(parent.group_status === "SPLIT", "The split parent remained active.");
  assert(children.length === 2, "A split did not create two child groups.");
  assert(
    children.every((child) => child.group_status === "DRAFT"),
    "Split child groups were not returned to the editable draft state."
  );
  assert(
    (await prisma.shipment_package_group_members.count({
      where: {
        package_group_id: { in: children.map((child) => child.package_group_id) },
        removed_at: null,
      },
    })) === 2,
    "Split child membership is incomplete."
  );
}

async function assertFrozenGroupReturnSuccessor(packageGroupApi, allocations) {
  const membership =
    await prisma.shipment_package_group_members.findFirstOrThrow({
      where: {
        allocation_id: allocations[0].allocation_id,
        removed_at: null,
      },
    });
  const returnedAt = new Date("2026-07-21T09:30:00+09:00");
  await prisma.$transaction((tx) =>
    packageGroupApi.applyPreShipmentReturnToPackageGroups(tx, {
      allocationIds: [allocations[0].allocation_id],
      returnedAt,
      operationKey: "package-group-return-test",
    })
  );
  const [parent, successor] = await Promise.all([
    prisma.shipment_package_groups.findUniqueOrThrow({
      where: { package_group_id: membership.package_group_id },
      include: { members: true },
    }),
    prisma.shipment_package_groups.findFirstOrThrow({
      where: { split_from_group_id: membership.package_group_id },
      include: { members: { where: { removed_at: null } } },
    }),
  ]);
  assert(
    parent.group_status === "INVALIDATED" &&
      parent.members.every((member) => member.removed_at !== null),
    "A partial return did not invalidate the immutable FROZEN group."
  );
  assert(
    successor.group_status === "DRAFT" &&
      successor.members.length === 1 &&
      successor.members[0].allocation_id === allocations[1].allocation_id,
    "A partial return did not create the remaining-member DRAFT successor."
  );

  await prisma.$transaction((tx) =>
    packageGroupApi.applyPreShipmentReturnToPackageGroups(tx, {
      allocationIds: [allocations[0].allocation_id],
      returnedAt,
      operationKey: "package-group-return-test",
    })
  );
  assert(
    (await prisma.shipment_package_groups.count({
      where: { split_from_group_id: membership.package_group_id },
    })) === 1,
    "A repeated settled return created a duplicate package-group successor."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const shipmentApi = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const packageGroupApi = await import(
    "@/quickhack_server/shipment/shipment-package-group-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const writeRules = await import(
    "@/quickhack_shared/inventory/inventory-write-rules"
  );
  const { allocations } = await createAllocationFixtures(ledgerApi, writeRules);

  await assertPrintGroupLifecycle(shipmentApi, allocations);
  await assertFrozenGroupReturnSuccessor(packageGroupApi, allocations);
  await assertDraftGroupSplit(packageGroupApi, allocations);
  console.log("Shipment package group lifecycle and split policy verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
