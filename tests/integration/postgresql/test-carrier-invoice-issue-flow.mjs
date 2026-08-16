import { spawn } from "node:child_process";
import path from "node:path";
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
  "quickhack-carrier-invoice-issue-"
);
const logenMockDatabase = createTemporaryDatabase(
  "quickhack-carrier-invoice-logen-mock-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
const logenMockPort = 3200;
const logenMockBaseUrl = `http://127.0.0.1:${logenMockPort}`;
const logenMockSecret = "LOGEN-MOCK-TEST-SECRET";

let logenMockOutput = "";
const logenMock = spawn(
  process.execPath,
  [
    path.join(process.cwd(), "mock_server", "logen", "server.mjs"),
    "--host",
    "127.0.0.1",
    "--port",
    String(logenMockPort),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL: logenMockDatabase.databaseUrl,
      LOGEN_MOCK_SECRET_KEY: logenMockSecret,
      LOGEN_MOCK_FAILURE_ENABLED: "false",
      LOGEN_MOCK_TRACKING_INTERVAL_MS: "0",
      LOGEN_MOCK_RETURN_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);
logenMock.stdout.on("data", (chunk) => {
  logenMockOutput += chunk.toString();
});
logenMock.stderr.on("data", (chunk) => {
  logenMockOutput += chunk.toString();
});

async function waitForLogenMock() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (logenMock.exitCode !== null) {
      throw new Error(`Logen mock exited early.\n${logenMockOutput}`);
    }
    try {
      const response = await fetch(`${logenMockBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup races are expected.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Logen mock did not become healthy.\n${logenMockOutput}`);
}

let prisma;
let fixtureSequence = 0;
let trackingSequence = 88100000000;
let registrationLeaseSequence = 0;

function at(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function registrationWorkerLease(label) {
  const controller = new AbortController();
  registrationLeaseSequence += 1;
  return {
    leaseToken: `test:${label}:${registrationLeaseSequence}`,
    signal: controller.signal,
    assertLeaseActive: async () => undefined,
  };
}

async function waitForRegistrationWork(input) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const work = await prisma.carrier_shipment_registration_works.findFirst({
      where: {
        issue_item: {
          carrier_invoice_issue_batch_id: input.issueBatchId,
        },
        work_status: input.status,
        execution_token: input.executionToken,
      },
    });
    if (work) return work;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Registration work did not reach ${input.status} for ${input.executionToken}.`
  );
}

function externalId(base, offset) {
  return String(BigInt(base) + BigInt(fixtureSequence * 100 + offset));
}

function nextTrackingNumber() {
  trackingSequence += 1;
  return String(trackingSequence);
}

function allocationItem(trackingNumber = nextTrackingNumber()) {
  return {
    trackingNumber,
    resultCode: "TRUE",
    resultMessage: null,
    succeeded: true,
  };
}

function allocationCall(items, options = {}) {
  return {
    apiCallLogId: options.apiCallLogId ?? null,
    allocation: {
      statusCode: options.statusCode ?? "SUCCESS",
      statusMessage: options.statusMessage ?? null,
      items,
    },
  };
}

async function createConfirmedShipmentBatch(ledgerApi, writeRules, groupSizes) {
  fixtureSequence += 1;
  const prefix = `invoice-issue-${fixtureSequence}`;
  const timestamp = at(
    `2026-07-22 09:${String(fixtureSequence).padStart(2, "0")}:00`
  );
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix,
    timestamp,
  });
  const count = groupSizes.reduce((sum, size) => sum + size, 0);
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count, timestamp }
  );
  const allocations = [];
  let deviceIndex = 0;

  for (const [groupIndex, groupSize] of groupSizes.entries()) {
    for (let memberIndex = 0; memberIndex < groupSize; memberIndex += 1) {
      const device = devices[deviceIndex];
      const externalOrderId = externalId("935770000000000000", deviceIndex + 1);
      const externalShipmentId = externalId("884440000000000000", deviceIndex + 1);
      const externalVendorItemId = externalId("777330000000000000", deviceIndex + 1);

      await prisma.coupang_order_raw.create({
        data: {
          external_order_id: externalOrderId,
          external_shipment_id: externalShipmentId,
          external_order_status: "INSTRUCT",
          ordered_at: at(
            `2026-07-22 09:${String(deviceIndex).padStart(2, "0")}:00`
          ),
          receiver_name: `${prefix}-receiver-${groupIndex}`,
          receiver_safe_number: `0507000${String(deviceIndex).padStart(4, "0")}`,
          receiver_post_code: `1${String(groupIndex).padStart(4, "0")}`,
          receiver_address_1: `${prefix}-address-${groupIndex}`,
          receiver_address_2: "101",
          synced_at: timestamp,
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
          operationKey: `${prefix}:reserve:${device.pgNo}`,
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
            external_vendor_item_id: externalVendorItemId,
            vendor_item_name: `${prefix}-phone-${deviceIndex + 1}`,
            pg_no: device.pgNo,
            sales_offer_id: catalog.salesOffer.sales_offer_id,
            inventory_sku_id: catalog.sku.inventory_sku_id,
            required_model: catalog.options.model.label,
            required_storage: catalog.options.storage.label,
            required_color: catalog.options.color.label,
            required_warranty_group: "2Y",
            inventory_status_before_allocation: "SELLABLE",
            allocation_status: "API_ACKED",
            allocated_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp,
          },
        })
      );
      await prisma.order_matching_work_queue.create({
        data: {
          channel: "COUPANG",
          external_order_id: externalOrderId,
          external_shipment_id: externalShipmentId,
          external_vendor_item_id: externalVendorItemId,
          vendor_item_name: `${prefix}-phone-${deviceIndex + 1}`,
          sales_price: 500000 + deviceIndex * 10000,
          ordered_quantity: 1,
          matchable_quantity: 1,
          mapping_status: "MAPPED",
          sales_offer_id: catalog.salesOffer.sales_offer_id,
          work_status: "MATCHED",
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
      deviceIndex += 1;
    }
  }

  const shipmentApi = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const printed = await shipmentApi.recordShipmentListPrint({
    allocationIds: allocations.map((item) => item.allocation_id),
    tabKey: "coupang-2y",
  });
  await shipmentApi.confirmShipmentListPrintBatch({ batchId: printed.batchId });
  for (const allocation of allocations) {
    await prisma.$transaction((tx) =>
      ledgerApi.transitionInventoryStatusWithLedger(tx, {
        pgNo: allocation.pg_no,
        expectedFromStatus: "PACKING",
        toStatus: "PACKED",
        transitionPolicy:
          writeRules.INVENTORY_TRANSITION_POLICY.packingValidation,
        operationKey: `${prefix}:packed:${allocation.pg_no}`,
        movementType:
          ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "INTEGRATION_TEST_PACKING",
        sourceId: String(printed.batchId),
        occurredAt: timestamp,
      })
    );
  }
  const printItems =
    await prisma.sales_channel_shipment_list_print_batch_items.findMany({
      where: { shipment_list_print_batch_id: printed.batchId },
      orderBy: { print_line_no: "asc" },
    });
  const packageGroupIds = Array.from(
    new Set(printItems.map((item) => item.package_group_id).filter(Boolean))
  );

  return {
    prefix,
    timestamp,
    batchId: printed.batchId,
    allocations,
    printItems,
    packageGroupIds,
  };
}

async function assertSuccessfulIdempotentAllocation(
  issueApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [2, 1]
  );
  let callCount = 0;
  const returnedNumbers = [nextTrackingNumber(), nextTrackingNumber()];
  const allocator = async (quantity) => {
    callCount += 1;
    assert(quantity === 2, "Co-packaged PGs were not counted as one parcel.");
    return allocationCall(returnedNumbers.map(allocationItem));
  };

  const first = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    { allocateTrackingNumbers: allocator }
  );
  const repeated = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    { allocateTrackingNumbers: allocator }
  );

  assert(first.status === "ALLOCATED", "A complete response was not allocated.");
  assert(first.items.length === 2, "The issue batch did not use package groups.");
  assert(callCount === 1, "Repeating the same source batch called Logen twice.");
  assert(
    repeated.issueBatchId === first.issueBatchId,
    "An idempotent repeat created another issue batch."
  );
  assert(
    first.items.every(
      (item, index) =>
        item.packageGroupId === fixture.packageGroupIds[index] &&
        item.trackingNumber === returnedNumbers[index]
    ),
    "Tracking numbers were not mapped in the frozen print order."
  );
  return { fixture, issueBatch: first };
}

function createCoupangOrdersheetReader(
  uploadedInvoiceByShipment = new Map()
) {
  return async (orderId) => {
    const raw = await prisma.coupang_order_raw.findFirstOrThrow({
      where: { external_order_id: String(orderId) },
    });
    const allocations = await prisma.match_worker_allocation.findMany({
      where: {
        external_order_id: raw.external_order_id,
        external_shipment_id: raw.external_shipment_id,
      },
      orderBy: { allocation_id: "asc" },
    });
    const invoiceNumber = uploadedInvoiceByShipment.get(
      raw.external_shipment_id
    );
    return {
      httpStatusCode: 200,
      payload: {
        code: "SUCCESS",
        message: "OK",
        data: [
          {
            orderId: raw.external_order_id,
            shipmentBoxId: raw.external_shipment_id,
            status: invoiceNumber ? "DEPARTURE" : "INSTRUCT",
            orderedAt: raw.ordered_at?.toISOString() ?? null,
            receiver: {
              name: raw.receiver_name,
              safeNumber: raw.receiver_safe_number,
              addr1: raw.receiver_address_1,
              addr2: raw.receiver_address_2,
              postCode: raw.receiver_post_code,
            },
            parcelPrintMessage: raw.shipping_memo,
            deliveryCompanyName: invoiceNumber ? "Logen" : null,
            invoiceNumber: invoiceNumber ?? null,
            splitShipping: false,
            orderItems: allocations.map((allocation) => ({
              vendorItemId: allocation.external_vendor_item_id,
              vendorItemName: allocation.external_vendor_item_id,
              shippingCount: 1,
              holdCountForCancel: 0,
              cancelCount: 0,
              canceled: false,
              invoiceNumberUploadDate: invoiceNumber
                ? "2026-07-23T10:00:00Z"
                : null,
            })),
          },
        ],
      },
    };
  };
}

async function assertCoupangInvoiceUploadFlow(
  issueApi,
  invoiceApi,
  writeService,
  verificationService,
  ledgerApi,
  writeRules,
  registrationApi,
  labelApi,
  trackingApi,
  deliveryProjectionApi,
  trackingQueryApi
) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [2, 1]
  );
  const issueBatch = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId }
  );
  const uploadedInvoiceByShipment = new Map();
  const sentCommands = [];

  const getOrdersheetByOrderId = async (orderId) => {
    const raw = await prisma.coupang_order_raw.findFirstOrThrow({
      where: { external_order_id: String(orderId) },
    });
    const allocations = await prisma.match_worker_allocation.findMany({
      where: {
        external_order_id: raw.external_order_id,
        external_shipment_id: raw.external_shipment_id,
      },
      orderBy: { allocation_id: "asc" },
    });
    const invoiceNumber = uploadedInvoiceByShipment.get(
      raw.external_shipment_id
    );
    return {
      httpStatusCode: 200,
      payload: {
        code: "SUCCESS",
        message: "OK",
        data: [
          {
            orderId: raw.external_order_id,
            shipmentBoxId: raw.external_shipment_id,
            status: invoiceNumber ? "DEPARTURE" : "INSTRUCT",
            orderedAt: raw.ordered_at?.toISOString() ?? null,
            receiver: {
              name: raw.receiver_name,
              safeNumber: raw.receiver_safe_number,
              addr1: raw.receiver_address_1,
              addr2: raw.receiver_address_2,
              postCode: raw.receiver_post_code,
            },
            parcelPrintMessage: raw.shipping_memo,
            deliveryCompanyName: invoiceNumber ? "로젠택배" : null,
            invoiceNumber: invoiceNumber ?? null,
            splitShipping: false,
            orderItems: allocations.map((allocation) => ({
              vendorItemId: allocation.external_vendor_item_id,
              vendorItemName: allocation.external_vendor_item_id,
              shippingCount: 1,
              holdCountForCancel: 0,
              cancelCount: 0,
              canceled: false,
              invoiceNumberUploadDate: invoiceNumber
                ? "2026-07-23T10:00:00Z"
                : null,
            })),
          },
        ],
      },
    };
  };
  const requestWrite = (command, lifecycle) =>
    writeService.requestSalesChannelWrite(command, lifecycle, {
      executeWrite: async (writeCommand) => {
        sentCommands.push(writeCommand);
        for (const item of writeCommand.invoiceItems) {
          uploadedInvoiceByShipment.set(item.shipmentBoxId, item.invoiceNumber);
        }
        if (sentCommands.length === 1) {
          throw new Error("simulated timeout after invoice apply");
        }
        return {
          httpStatusCode: 200,
          payload: {
            code: "200",
            message: "OK",
            data: {
              responseCode: 0,
              responseMessage: "SUCCESS",
              responseList: writeCommand.invoiceItems.map((item) => ({
                shipmentBoxId: item.shipmentBoxId,
                succeed: true,
                resultCode: "OK",
                retryRequired: false,
                resultMessage: null,
              })),
            },
          },
        };
      },
      verifyWrite: (input) =>
        verificationService.verifyAndRefreshCoupangWriteRequest(input, {
          getOrdersheetByOrderId,
        }),
    });

  const result = await invoiceApi.submitCoupangInvoicesForIssueBatch(
    { issueBatchId: issueBatch.issueBatchId },
    { getOrdersheetByOrderId, requestWrite }
  );
  const repeated = await invoiceApi.submitCoupangInvoicesForIssueBatch(
    { issueBatchId: issueBatch.issueBatchId },
    { getOrdersheetByOrderId, requestWrite }
  );

  if (result.status !== "COMPLETED") {
    const diagnostics = await prisma.sales_channel_write_requests.findMany({
      where: {
        sales_channel_write_request_id: {
          in: result.requests
            .map((request) => request.requestId)
            .filter((requestId) => requestId != null),
        },
      },
      select: {
        sales_channel_write_request_id: true,
        request_status: true,
        error_code: true,
        error_message: true,
      },
      orderBy: { sales_channel_write_request_id: "asc" },
    });
    throw new Error(
      `Coupang invoice upload did not complete: ${JSON.stringify({ result, diagnostics })}`
    );
  }
  assert(
    repeated.status === "COMPLETED" && sentCommands.length === 3,
    "Repeating a completed issue batch resent a Coupang invoice write."
  );
  assert(
    result.targetCount === 3 && result.completedCount === 3,
    "One write request was not created per distinct Coupang shipmentBoxId."
  );
  assert(sentCommands.length === 3, "The Coupang invoice write count changed.");
  assert(
    sentCommands.every(
      (command) =>
        command.requestType === "COUPANG_INVOICE_UPLOAD" &&
        command.invoiceItems.every(
          (item) =>
            item.deliveryCompanyCode === "KGB" &&
            item.splitShipping === false &&
            item.preSplitShipped === false &&
            item.estimatedShippingDate === ""
        )
    ),
    "The full-shipment Logen payload policy was not preserved."
  );

  const firstGroup = fixture.packageGroupIds[0];
  const firstGroupCommands = sentCommands.filter(
    (command) => command.packageGroupId === firstGroup
  );
  assert(
    firstGroupCommands.length === 2 &&
      new Set(
        firstGroupCommands.flatMap((command) =>
          command.invoiceItems.map((item) => item.invoiceNumber)
        )
      ).size === 1,
    "Co-packaged shipments did not share one Logen tracking number."
  );

  const groups = await prisma.shipment_package_groups.findMany({
    where: { package_group_id: { in: fixture.packageGroupIds } },
  });
  assert(
    groups.every((group) => group.group_status === "READY"),
    "A fully verified package group did not advance to READY."
  );
  const carrierShipments = await prisma.carrier_shipments.findMany({
    where: {
      carrier_shipment_id: {
        in: issueBatch.items.map((item) => item.carrierShipmentId),
      },
    },
  });
  assert(
    carrierShipments.every(
      (shipment) =>
        shipment.invoice_status === "ALLOCATED" &&
        shipment.shipment_status === "ALLOCATED"
    ),
    "PR3 advanced the carrier shipment lifecycle beyond ALLOCATED."
  );
  const writeRequests = await prisma.sales_channel_write_requests.findMany({
    where: {
      carrier_shipment_id: {
        in: carrierShipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
    include: { targets: true },
  });
  assert(
    writeRequests.length === 3 &&
      writeRequests.every(
        (request) =>
          request.request_status === "COMPLETED" &&
          request.targets.every(
            (target) =>
              target.delivery_company_code === "KGB" &&
              target.invoice_number_snapshot?.length === 11
          )
      ),
    "The immutable Coupang invoice request history is incomplete."
  );

  let missingLeaseRejected = false;
  try {
    await registrationApi.processLogenShipmentRegistrationWorks({ limit: 1 });
  } catch (error) {
    missingLeaseRejected = error?.code === "WORKER_LEASE_REQUIRED";
  }
  assert(
    missingLeaseRejected,
    "Logen registration ran without an owned worker execution token."
  );

  const normalRegistration =
    await registrationApi.processLogenShipmentRegistrationWorks({
      limit: 1,
      workerLease: registrationWorkerLease("normal"),
    });
  assert(
    normalRegistration.processedCount === 1 &&
      normalRegistration.succeededCount === 1,
    `A normal Logen registration did not complete: ${JSON.stringify(normalRegistration)}`
  );
  await fetch(`${logenMockBaseUrl}/admin/failure-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      target: "slipPrintM",
      httpStatus: 503,
      writeAppliedResponseFailureRate: 100,
      minDelayMs: 600,
      maxDelayMs: 600,
    }),
  });
  const staleLease = registrationWorkerLease("stale-submission");
  const uncertainRegistrationPromise =
    registrationApi.processLogenShipmentRegistrationWorks({
      limit: 10,
      workerLease: staleLease,
    });
  await waitForRegistrationWork({
    issueBatchId: issueBatch.issueBatchId,
    status: "SUBMITTING",
    executionToken: staleLease.leaseToken,
  });
  const manuallyQueuedCount =
    await registrationApi.queueLogenRegistrationForIssueBatch({
      issueBatchId: issueBatch.issueBatchId,
      reconcileOnly: true,
    });
  assert(
    manuallyQueuedCount === 1,
    "Manual reconciliation did not invalidate the active registration owner."
  );
  const takeoverRegistration =
    await registrationApi.processLogenShipmentRegistrationWorks({
      limit: 10,
      workerLease: registrationWorkerLease("takeover-reconciliation"),
    });
  const uncertainRegistration = await uncertainRegistrationPromise;
  assert(
    uncertainRegistration.processedCount === 1 &&
      uncertainRegistration.skippedCount === 1 &&
      takeoverRegistration.processedCount === 1 &&
      takeoverRegistration.failedCount === 1,
    `A stale Logen result was not fenced by the takeover: ${JSON.stringify({ uncertainRegistration, takeoverRegistration })}`
  );
  const reconcilingWorks =
    await prisma.carrier_shipment_registration_works.findMany({
      where: {
        issue_item: {
          carrier_invoice_issue_batch_id: issueBatch.issueBatchId,
        },
      },
    });
  assert(
    reconcilingWorks.filter((work) => work.work_status === "REGISTERED").length === 1 &&
      reconcilingWorks.filter((work) => work.work_status === "RECONCILING").length === 1,
    "An uncertain slipPrintM result was treated as safe to resend."
  );
  await fetch(`${logenMockBaseUrl}/admin/failure-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: false,
      writeAppliedResponseFailureRate: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    }),
  });
  await registrationApi.queueLogenRegistrationForIssueBatch({
    issueBatchId: issueBatch.issueBatchId,
    reconcileOnly: true,
  });
  const registration =
    await registrationApi.processLogenShipmentRegistrationWorks({
      limit: 10,
      workerLease: registrationWorkerLease("owned-reconciliation"),
    });
  assert(
    registration.processedCount === 1 && registration.succeededCount === 1,
    `Logen read-only reconciliation did not finalize each package group: ${JSON.stringify(registration)}`
  );
  const registeredShipments = await prisma.carrier_shipments.findMany({
    where: {
      carrier_shipment_id: {
        in: issueBatch.items.map((item) => item.carrierShipmentId),
      },
    },
  });
  assert(
    registeredShipments.every(
      (shipment) =>
        shipment.invoice_status === "REGISTERED" &&
        shipment.shipment_status === "REGISTERED" &&
        Boolean(shipment.carrier_registered_at)
    ),
    "Logen registration did not finalize the existing carrier shipment."
  );
  const registrationWorks =
    await prisma.carrier_shipment_registration_works.findMany({
      where: {
        carrier_shipment_id: {
          in: registeredShipments.map((shipment) => shipment.carrier_shipment_id),
        },
      },
      orderBy: { carrier_shipment_registration_work_id: "asc" },
    });
  assert(
    registrationWorks.length === 2 &&
      registrationWorks.every(
        (work) =>
          work.work_status === "REGISTERED" &&
          work.execution_token === null &&
          work.goods_amount_snapshot > 0 &&
          work.receiver_branch_code
      ),
    "The durable Logen registration work snapshot is incomplete."
  );
  const firstGroupWork = registrationWorks.find(
    (work) => work.package_group_id === firstGroup
  );
  assert(
    firstGroupWork?.goods_name_snapshot?.includes("외 1건"),
    "Co-packaged goods were not represented by one physical parcel summary."
  );
  const slipPrintLogs = await prisma.carrier_api_call_logs.findMany({
    where: {
      api_name: "slipPrintM",
      carrier_shipment_id: {
        in: registeredShipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
  });
  assert(
    slipPrintLogs.length === 2 &&
      new Set(slipPrintLogs.map((log) => log.processed_status)).has("SUCCEEDED") &&
      new Set(slipPrintLogs.map((log) => log.processed_status)).has("RECONCILED"),
    "Logen slipPrintM was not called exactly once per package group."
  );
  const reconciliations = await prisma.carrier_reconciliation_works.findMany({
    where: {
      operation_type: "slipPrintM",
      lookup_key_value: {
        in: registeredShipments.map((shipment) => shipment.tracking_number),
      },
    },
  });
  assert(
    reconciliations.length === 1 &&
      reconciliations.every(
        (work) => work.reconciliation_status === "RESOLVED" && work.resolved_at
      ),
    "Read-only reconciliation did not close its durable review records."
  );
  const repeatedRegistration =
    await registrationApi.processLogenShipmentRegistrationWorks({
      limit: 10,
      workerLease: registrationWorkerLease("repeat"),
    });
  assert(
    repeatedRegistration.processedCount === 0 &&
      (await prisma.carrier_api_call_logs.count({
        where: { api_name: "slipPrintM" },
      })) === slipPrintLogs.length,
    "Repeating the Logen worker resent a completed registration."
  );

  const readyLabels = await labelApi.getLogenLabelPrintView({
    issueBatchId: issueBatch.issueBatchId,
  });
  assert(
    readyLabels.ready &&
      readyLabels.labels.length === issueBatch.requestedPackageGroupCount &&
      readyLabels.labels[0].parcel.packageMemberCount === 2,
    "The existing package-group snapshot did not produce one ready label per parcel."
  );
  assert(
    readyLabels.labels.every(
      (label) =>
        label.sender.customerCode &&
        label.sender.name &&
        label.classification.branchCode &&
        label.classification.classCode
    ),
    "The registration work did not preserve the required label snapshots."
  );

  const firstPrint = await labelApi.startLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    printerName: "TSC DA200 Test Queue",
    userId: null,
  });
  const duplicateStart = await labelApi.startLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    printerName: "TSC DA200 Test Queue",
    userId: null,
  });
  assert(
    firstPrint.requestKey === duplicateStart.requestKey,
    "Repeating an active label request created a duplicate physical print key."
  );
  await labelApi.recordLogenLabelPrintSpooled({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: firstPrint.requestKey,
    payloadHash: firstPrint.payloadHash,
    expectedPrintAttemptCount: firstPrint.printAttemptCount,
  });
  const firstSpoolCounts = await prisma.carrier_invoice_issue_items.findMany({
    where: {
      carrier_invoice_issue_batch_id: issueBatch.issueBatchId,
      label_print_attempt_no: firstPrint.printAttemptCount,
    },
    orderBy: { issue_sequence: "asc" },
    select: { label_print_count: true },
  });
  const firstSpoolLogCount = await prisma.employee_activity_logs.count({
    where: {
      action_type: "LOGEN_LABEL_PRINT_SPOOLED",
      target_id: String(issueBatch.issueBatchId),
    },
  });
  await labelApi.recordLogenLabelPrintSpooled({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: firstPrint.requestKey,
    payloadHash: firstPrint.payloadHash,
    expectedPrintAttemptCount: firstPrint.printAttemptCount,
  });
  const repeatedSpoolCounts = await prisma.carrier_invoice_issue_items.findMany({
    where: {
      carrier_invoice_issue_batch_id: issueBatch.issueBatchId,
      label_print_attempt_no: firstPrint.printAttemptCount,
    },
    orderBy: { issue_sequence: "asc" },
    select: { label_print_count: true },
  });
  assert(
    JSON.stringify(repeatedSpoolCounts) === JSON.stringify(firstSpoolCounts),
    "Repeating the same spool result incremented a physical print count twice."
  );
  assert(
    (await prisma.employee_activity_logs.count({
      where: {
        action_type: "LOGEN_LABEL_PRINT_SPOOLED",
        target_id: String(issueBatch.issueBatchId),
      },
    })) === firstSpoolLogCount,
    "Repeating the same spool result appended a duplicate activity log."
  );

  const failedIssueItemId = firstPrint.labels[1].issueItemId;
  const partial = await labelApi.confirmLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: firstPrint.requestKey,
    payloadHash: firstPrint.payloadHash,
    expectedPrintAttemptCount: firstPrint.printAttemptCount,
    failedIssueItemIds: [failedIssueItemId],
  });
  assert(
    partial.labelPrintStatus === "PARTIAL" &&
      partial.targetIssueItemIds.length === 1 &&
      partial.targetIssueItemIds[0] === failedIssueItemId,
    "A partial physical print did not isolate the failed label for recovery."
  );
  let lateFailureRejected = false;
  try {
    await labelApi.failLogenLabelPrint({
      issueBatchId: issueBatch.issueBatchId,
      requestKey: firstPrint.requestKey,
      payloadHash: firstPrint.payloadHash,
      expectedPrintAttemptCount: firstPrint.printAttemptCount,
      uncertain: true,
    });
  } catch (error) {
    lateFailureRejected =
      error instanceof labelApi.LogenLabelPrintError &&
      error.code === "LABEL_PRINT_REQUEST_STALE";
  }
  assert(
    lateFailureRejected,
    "A late unknown result was allowed to overwrite a completed confirmation."
  );

  const recovery = await labelApi.startLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    printerName: "TSC DA200 Test Queue",
  });
  assert(
    recovery.labels.length === 1 &&
      recovery.labels[0].issueItemId === failedIssueItemId,
    "Recovery printing included labels that were already confirmed."
  );
  const unknown = await labelApi.failLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: recovery.requestKey,
    payloadHash: recovery.payloadHash,
    expectedPrintAttemptCount: recovery.printAttemptCount,
    uncertain: true,
  });
  assert(
    unknown.labelPrintStatus === "UNKNOWN" &&
      !unknown.ready &&
      unknown.items.find((item) => item.issueItemId === failedIssueItemId)
        ?.printStatus === "UNKNOWN",
    "An uncertain local print result did not block automatic reprinting."
  );
  const unknownResolutionLogCount =
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "LOGEN_LABEL_PRINT_UNKNOWN_RESOLVED_NOT_PRINTED",
        target_id: String(issueBatch.issueBatchId),
      },
    });
  const concurrentUnknownResolutions = await Promise.allSettled([
    labelApi.resolveUnknownLogenLabelPrint({
      issueBatchId: issueBatch.issueBatchId,
      printed: false,
      expectedPrintAttemptCount: recovery.printAttemptCount,
    }),
    labelApi.resolveUnknownLogenLabelPrint({
      issueBatchId: issueBatch.issueBatchId,
      printed: false,
      expectedPrintAttemptCount: recovery.printAttemptCount,
    }),
  ]);
  assert(
    concurrentUnknownResolutions.some((result) => result.status === "fulfilled"),
    "Concurrent manager decisions did not commit a single unknown resolution."
  );
  const resolvedNotPrinted = await labelApi.getLogenLabelPrintView({
    issueBatchId: issueBatch.issueBatchId,
  });
  assert(
    (await prisma.employee_activity_logs.count({
      where: {
        action_type: "LOGEN_LABEL_PRINT_UNKNOWN_RESOLVED_NOT_PRINTED",
        target_id: String(issueBatch.issueBatchId),
      },
    })) === unknownResolutionLogCount + 1,
    "Concurrent manager decisions appended more than one resolution log."
  );
  assert(
    resolvedNotPrinted.labelPrintStatus === "PARTIAL" &&
      resolvedNotPrinted.targetIssueItemIds.length === 1 &&
      resolvedNotPrinted.targetIssueItemIds[0] === failedIssueItemId,
    "A manager not-printed decision did not return only the unknown label to recovery."
  );

  const retriedRecovery = await labelApi.startLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    printerName: "TSC DA200 Test Queue",
  });
  const secondUnknown = await labelApi.failLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: retriedRecovery.requestKey,
    payloadHash: retriedRecovery.payloadHash,
    expectedPrintAttemptCount: retriedRecovery.printAttemptCount,
    uncertain: true,
  });
  assert(
    secondUnknown.labelPrintStatus === "UNKNOWN",
    "A later recovery attempt did not enter the unknown review state."
  );
  let staleResolutionRejected = false;
  try {
    await labelApi.resolveUnknownLogenLabelPrint({
      issueBatchId: issueBatch.issueBatchId,
      printed: true,
      expectedPrintAttemptCount: recovery.printAttemptCount,
    });
  } catch (error) {
    staleResolutionRejected =
      error instanceof labelApi.LogenLabelPrintError &&
      error.code === "LABEL_PRINT_REQUEST_STALE";
  }
  assert(
    staleResolutionRejected,
    "A manager decision from an older attempt resolved a later unknown result."
  );
  await labelApi.resolveUnknownLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    printed: false,
    expectedPrintAttemptCount: retriedRecovery.printAttemptCount,
  });

  const finalRecovery = await labelApi.startLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    printerName: "TSC DA200 Test Queue",
  });
  await labelApi.recordLogenLabelPrintSpooled({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: finalRecovery.requestKey,
    payloadHash: finalRecovery.payloadHash,
    expectedPrintAttemptCount: finalRecovery.printAttemptCount,
  });
  const recoverySpooledView = await labelApi.getLogenLabelPrintView({
    issueBatchId: issueBatch.issueBatchId,
  });
  assert(
    recoverySpooledView.targetIssueItemIds.length === 1 &&
      recoverySpooledView.targetIssueItemIds[0] === failedIssueItemId,
    "A spooled recovery attempt lost its item-level target ownership."
  );
  let spooledFailureRejected = false;
  try {
    await labelApi.failLogenLabelPrint({
      issueBatchId: issueBatch.issueBatchId,
      requestKey: finalRecovery.requestKey,
      payloadHash: finalRecovery.payloadHash,
      expectedPrintAttemptCount: finalRecovery.printAttemptCount,
      uncertain: true,
    });
  } catch (error) {
    spooledFailureRejected =
      error instanceof labelApi.LogenLabelPrintError &&
      error.code === "LABEL_PRINT_STATE_CONFLICT";
  }
  assert(
    spooledFailureRejected,
    "A late unknown result downgraded a spooled attempt awaiting confirmation."
  );
  const confirmed = await labelApi.confirmLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: finalRecovery.requestKey,
    payloadHash: finalRecovery.payloadHash,
    expectedPrintAttemptCount: finalRecovery.printAttemptCount,
    failedIssueItemIds: [],
  });
  assert(
    confirmed.labelPrintStatus === "CONFIRMED" &&
      confirmed.items.every((item) => item.printStatus === "CONFIRMED") &&
      confirmed.items.find((item) => item.issueItemId === failedIssueItemId)
        ?.printCount === 2,
    "Recovery printing did not finish the existing issue-item print state."
  );
  const confirmedLogCount = await prisma.employee_activity_logs.count({
    where: {
      action_type: "LOGEN_LABEL_PRINT_CONFIRMED",
      target_id: String(issueBatch.issueBatchId),
    },
  });
  const repeatedConfirmation = await labelApi.confirmLogenLabelPrint({
    issueBatchId: issueBatch.issueBatchId,
    requestKey: finalRecovery.requestKey,
    payloadHash: finalRecovery.payloadHash,
    expectedPrintAttemptCount: finalRecovery.printAttemptCount,
    failedIssueItemIds: [],
  });
  assert(
    repeatedConfirmation.labelPrintStatus === "CONFIRMED",
    "Repeating the same confirmation did not return the committed result."
  );
  assert(
    (await prisma.employee_activity_logs.count({
      where: {
        action_type: "LOGEN_LABEL_PRINT_CONFIRMED",
        target_id: String(issueBatch.issueBatchId),
      },
    })) === confirmedLogCount,
    "Repeating the same confirmation appended a duplicate activity log."
  );
  assert(
    (await prisma.carrier_api_call_logs.count({
      where: { api_name: "slipPrintM" },
    })) === slipPrintLogs.length,
    "Physical label recovery called slipPrintM again."
  );

  const shipmentByGroup = new Map(
    registeredShipments.map((shipment) => [
      shipment.package_group_id,
      shipment,
    ])
  );
  const inTransitGroupId = fixture.packageGroupIds[0];
  const exceptionGroupId = fixture.packageGroupIds[1];
  const inTransitShipment = shipmentByGroup.get(inTransitGroupId);
  const exceptionShipment = shipmentByGroup.get(exceptionGroupId);
  assert(
    inTransitShipment && exceptionShipment,
    "Registered carrier shipments were not linked to each package group."
  );

  const setMockShipmentState = async (trackingNumber, state) => {
    const response = await fetch(
      `${logenMockBaseUrl}/admin/shipments/advance`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slipNo: trackingNumber, state }),
      }
    );
    const payload = await response.json();
    assert(
      response.ok && payload.ok,
      `The Logen mock state could not be changed: ${JSON.stringify(payload)}`
    );
  };

  await setMockShipmentState(
    inTransitShipment.tracking_number,
    "IN_TRANSIT"
  );
  await setMockShipmentState(
    exceptionShipment.tracking_number,
    "EXCEPTION"
  );
  const firstTrackingSync =
    await trackingApi.processLogenShipmentTracking({ limit: 10 });
  assert(
    firstTrackingSync.succeededCount === 2 &&
      firstTrackingSync.transitionedCount === 3,
    `Logen tracking did not project each package member: ${JSON.stringify(firstTrackingSync)}`
  );
  const firstProjectedInventory = await prisma.inventory.findMany({
    where: {
      pg_no: {
        in: fixture.allocations.map((allocation) => allocation.pg_no),
      },
    },
  });
  const firstStatusByPg = new Map(
    firstProjectedInventory.map((row) => [row.pg_no, row.inventory_status])
  );
  for (const allocation of fixture.allocations) {
    const expectedStatus =
      fixture.printItems.find(
        (item) => item.allocation_id === allocation.allocation_id
      )?.package_group_id === inTransitGroupId
        ? "DELIVERING"
        : "NONE_TRACKING";
    assert(
      firstStatusByPg.get(allocation.pg_no) === expectedStatus,
      `PG ${allocation.pg_no} was not projected to ${expectedStatus}.`
    );
  }

  const exceptionMembers =
    await prisma.shipment_package_group_members.findMany({
      where: {
        package_group_id: exceptionGroupId,
        removed_at: null,
      },
    });
  const coupangFallback =
    await deliveryProjectionApi.projectCoupangDeliveryStatuses({
      orders: exceptionMembers.map((member) => ({
        externalShipmentId: member.external_shipment_id,
        channelStatus: "DELIVERING",
        syncedAt: "2026-07-23 12:00:00",
      })),
    });
  assert(
    coupangFallback.transitionedCount === 0 &&
      (
        await prisma.inventory.findUniqueOrThrow({
          where: { pg_no: fixture.allocations.at(-1).pg_no },
        })
      ).inventory_status === "NONE_TRACKING",
    "The Coupang fallback incorrectly cleared a Logen delivery exception."
  );

  const trackingView = await trackingQueryApi.listInTransitPackageGroups();
  assert(
    trackingView.items.some(
      (item) =>
        item.packageGroupId === exceptionGroupId &&
        item.carrierStatus === "EXCEPTION" &&
        item.latestStatusName === "미배송" &&
        item.members.length === 1
    ),
    "The in-transit view did not expose the package-level exception evidence."
  );

  await setMockShipmentState(
    inTransitShipment.tracking_number,
    "DELIVERED"
  );
  await setMockShipmentState(
    exceptionShipment.tracking_number,
    "IN_TRANSIT"
  );
  await prisma.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: {
        in: registeredShipments.map(
          (shipment) => shipment.carrier_shipment_id
        ),
      },
    },
    data: { last_tracked_at: null },
  });
  const recoveryTrackingSync =
    await trackingApi.processLogenShipmentTracking({ limit: 10 });
  assert(
    recoveryTrackingSync.succeededCount === 2 &&
      recoveryTrackingSync.transitionedCount === 3 &&
      recoveryTrackingSync.completedCount === 1,
    `Logen completion/recovery was not projected: ${JSON.stringify(recoveryTrackingSync)}`
  );
  const finalGroup = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: inTransitGroupId },
  });
  const recoveredInventory = await prisma.inventory.findUniqueOrThrow({
    where: { pg_no: fixture.allocations.at(-1).pg_no },
  });
  assert(
    finalGroup.group_status === "COMPLETED" &&
      recoveredInventory.inventory_status === "DELIVERING",
    "Final delivery or NONE_TRACKING recovery did not update its physical package."
  );
}

async function loadSingleInvoiceWriteIdentity(issueBatchId) {
  const batch = await prisma.carrier_invoice_issue_batches.findUniqueOrThrow({
    where: { carrier_invoice_issue_batch_id: issueBatchId },
    include: {
      items: {
        include: {
          carrier_shipment: true,
          package_group: {
            include: {
              members: {
                where: { removed_at: null },
                orderBy: { member_sequence: "asc" },
              },
            },
          },
        },
      },
    },
  });
  assert(batch.items.length === 1, "The retry fixture must contain one package group.");
  const item = batch.items[0];
  const member = item.package_group.members[0];
  assert(item.carrier_shipment && member, "The retry fixture is incomplete.");
  return {
    packageGroupId: item.package_group_id,
    carrierShipmentId: item.carrier_shipment.carrier_shipment_id,
    externalOrderId: member.external_order_id,
    externalShipmentId: member.external_shipment_id,
    idempotencyKey: `COUPANG_INVOICE_UPLOAD:${item.carrier_shipment.carrier_shipment_id}:${member.external_shipment_id}`,
  };
}

async function assertInvoiceCallerRetryStatusRouting(
  issueApi,
  invoiceApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(ledgerApi, writeRules, [1]);
  const issueBatch = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem()]),
    }
  );
  const identity = await loadSingleInvoiceWriteIdentity(issueBatch.issueBatchId);
  const timestamp = at("2026-07-23 13:00:00");
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "COUPANG_INVOICE_UPLOAD",
      request_status: "REVIEW_REQUIRED",
      idempotency_key: identity.idempotencyKey,
      request_digest: "test-fixture",
      method: "POST",
      endpoint_path: "/test/invoice-upload",
      external_order_id: identity.externalOrderId,
      target_type: "SHIPMENT_BOX",
      target_external_id: identity.externalShipmentId,
      package_group_id: identity.packageGroupId,
      carrier_shipment_id: identity.carrierShipmentId,
      source_menu_key: "shipment.invoice.issue",
      source_entity_type: "CARRIER_INVOICE_ISSUE_BATCH",
      source_entity_id: String(issueBatch.issueBatchId),
      requested_at: timestamp,
      review_required_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const readOrdersheet = createCoupangOrdersheetReader();
  let readCount = 0;
  let writeCount = 0;
  const dependencies = {
    getOrdersheetByOrderId: async (...args) => {
      readCount += 1;
      return readOrdersheet(...args);
    },
    requestWrite: async () => {
      writeCount += 1;
      return {
        requestId: request.sales_channel_write_request_id,
        status: "COMPLETED",
      };
    },
  };

  for (const status of [
    "COMPLETED",
    "REVIEW_REQUIRED",
    "LOCAL_PENDING",
    "PENDING",
    "SENDING",
    "VERIFYING",
  ]) {
    await prisma.sales_channel_write_requests.update({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
      },
      data: { request_status: status, updated_at: timestamp },
    });
    const readsBefore = readCount;
    const writesBefore = writeCount;
    const result = await invoiceApi.submitCoupangInvoicesForIssueBatch(
      { issueBatchId: issueBatch.issueBatchId },
      dependencies
    );
    assert(
      readCount === readsBefore && writeCount === writesBefore,
      `Existing ${status} invoice work reached an external caller.`
    );
    assert(
      result.requests.length === 1 &&
        result.requests[0].status === status &&
        result.requests[0].skipped === true,
      `Existing ${status} invoice work was not reused.`
    );
  }

  for (const status of ["REJECTED", "NOT_APPLIED"]) {
    await prisma.sales_channel_write_requests.update({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
      },
      data: { request_status: status, updated_at: timestamp },
    });
    const readsBefore = readCount;
    const writesBefore = writeCount;
    const result = await invoiceApi.submitCoupangInvoicesForIssueBatch(
      { issueBatchId: issueBatch.issueBatchId },
      dependencies
    );
    assert(
      readCount === readsBefore + 1 && writeCount === writesBefore + 1,
      `Existing ${status} invoice work did not enter the safe retry path.`
    );
    assert(
      result.status === "COMPLETED" &&
        result.requests[0].skipped === false,
      `Existing ${status} invoice work was still skipped.`
    );
  }
}

async function assertInvoiceCallerRetriesOnlyFailedPartOfBatch(
  issueApi,
  invoiceApi,
  writeService,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(ledgerApi, writeRules, [2]);
  const issueBatch = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem()]),
    }
  );
  const batch = await prisma.carrier_invoice_issue_batches.findUniqueOrThrow({
    where: { carrier_invoice_issue_batch_id: issueBatch.issueBatchId },
    include: {
      items: {
        include: {
          carrier_shipment: true,
          package_group: {
            include: {
              members: {
                where: { removed_at: null },
                orderBy: { member_sequence: "asc" },
                include: { allocation: true },
              },
            },
          },
        },
      },
    },
  });
  const item = batch.items[0];
  const members = item.package_group.members;
  assert(
    batch.items.length === 1 && item.carrier_shipment && members.length === 2,
    "The partial retry fixture is incomplete."
  );
  const timestamp = at("2026-07-23 14:00:00");
  const requests = [];

  for (const [index, member] of members.entries()) {
    const externalOrderId = String(member.external_order_id).trim();
    const externalShipmentId = String(member.external_shipment_id).trim();
    const externalVendorItemId = String(
      member.allocation.external_vendor_item_id
    ).trim();
    const command = {
      channel: "COUPANG",
      requestType: "COUPANG_INVOICE_UPLOAD",
      idempotencyKey: `COUPANG_INVOICE_UPLOAD:${item.carrier_shipment.carrier_shipment_id}:${externalShipmentId}`,
      externalOrderId,
      targetType: "SHIPMENT_BOX",
      targetExternalId: externalShipmentId,
      packageGroupId: item.package_group_id,
      carrierShipmentId: item.carrier_shipment.carrier_shipment_id,
      expectedBeforeStatus: "INSTRUCT",
      requestedAfterStatus: "DEPARTURE",
      sourceMenuKey: "shipment.invoice.issue",
      sourceEntityType: "CARRIER_INVOICE_ISSUE_BATCH",
      sourceEntityId: String(issueBatch.issueBatchId),
      requestedByUserId: null,
      invoiceItems: [
        {
          shipmentBoxId: externalShipmentId,
          orderId: externalOrderId,
          vendorItemId: externalVendorItemId,
          deliveryCompanyCode: "KGB",
          invoiceNumber: item.carrier_shipment.tracking_number,
          splitShipping: false,
          preSplitShipped: false,
          estimatedShippingDate: "",
        },
      ],
      targets: [
        {
          targetType: "SHIPMENT_BOX",
          targetExternalId: externalShipmentId,
          allocationId: member.allocation_id,
          pgNo: member.allocation.pg_no,
          externalOrderId,
          externalShipmentId,
          externalVendorItemId,
          packageGroupId: item.package_group_id,
          carrierShipmentId: item.carrier_shipment.carrier_shipment_id,
          deliveryCompanyCode: "KGB",
          invoiceNumberSnapshot: item.carrier_shipment.tracking_number,
          splitShipping: false,
          preSplitShipped: false,
          estimatedShippingDate: "",
          expectedBeforeStatus: "INSTRUCT",
          requestedAfterStatus: "DEPARTURE",
        },
      ],
    };
    const request = await prisma.sales_channel_write_requests.create({
      data: {
        channel: "COUPANG",
        request_type: "COUPANG_INVOICE_UPLOAD",
        request_status: index === 0 ? "COMPLETED" : "NOT_APPLIED",
        idempotency_key: command.idempotencyKey,
        request_digest:
          writeService.digestSalesChannelWriteCommand(command),
        method: "POST",
        endpoint_path: "/test/invoice-upload",
        external_order_id: member.external_order_id,
        target_type: "SHIPMENT_BOX",
        target_external_id: member.external_shipment_id,
        package_group_id: item.package_group_id,
        carrier_shipment_id: item.carrier_shipment.carrier_shipment_id,
        source_menu_key: "shipment.invoice.issue",
        source_entity_type: "CARRIER_INVOICE_ISSUE_BATCH",
        source_entity_id: String(issueBatch.issueBatchId),
        requested_at: timestamp,
        completed_at: index === 0 ? timestamp : null,
        local_finalized_at: index === 0 ? timestamp : null,
        created_at: timestamp,
        updated_at: timestamp,
        targets: {
          create: {
            target_type: "SHIPMENT_BOX",
            target_external_id: member.external_shipment_id,
            allocation_id: member.allocation_id,
            pg_no: member.allocation.pg_no,
            external_order_id: member.external_order_id,
            external_shipment_id: member.external_shipment_id,
            external_vendor_item_id:
              member.allocation.external_vendor_item_id,
            package_group_id: item.package_group_id,
            carrier_shipment_id: item.carrier_shipment.carrier_shipment_id,
            delivery_company_code: "KGB",
            invoice_number_snapshot: item.carrier_shipment.tracking_number,
            quantity: 1,
            expected_before_status: "INSTRUCT",
            requested_after_status: "DEPARTURE",
            external_result_status:
              index === 0 ? "SUCCEEDED" : "NOT_APPLIED",
            retry_required: 0,
            result_received_at: timestamp,
            local_finalization_status:
              index === 0 ? "COMPLETED" : "NOT_REQUIRED",
            local_finalized_at: index === 0 ? timestamp : null,
            created_at: timestamp,
          },
        },
        attempts: {
          create: {
            attempt_no: 1,
            attempt_type: "WRITE",
            attempt_status: index === 0 ? "SUCCEEDED" : "FAILED",
            trigger_type: "INITIAL",
            method: "POST",
            endpoint_path: "/test/invoice-upload",
            started_at: timestamp,
            completed_at: timestamp,
            request_dispatched: 1,
            response_received: 1,
            created_at: timestamp,
          },
        },
      },
    });
    requests.push(request);
  }

  let readCount = 0;
  let dispatchCount = 0;
  const readOrdersheet = createCoupangOrdersheetReader();
  const result = await invoiceApi.submitCoupangInvoicesForIssueBatch(
    { issueBatchId: issueBatch.issueBatchId },
    {
      getOrdersheetByOrderId: async (...args) => {
        readCount += 1;
        return readOrdersheet(...args);
      },
      requestWrite: (command, lifecycle) =>
        writeService.requestSalesChannelWrite(command, lifecycle, {
          executeWrite: async (writeCommand) => {
            dispatchCount += 1;
            return {
              httpStatusCode: 200,
              payload: {
                code: "200",
                message: "OK",
                data: {
                  responseCode: 0,
                  responseMessage: "SUCCESS",
                  responseList: writeCommand.invoiceItems.map((invoiceItem) => ({
                    shipmentBoxId: invoiceItem.shipmentBoxId,
                    succeed: true,
                    resultCode: "OK",
                    retryRequired: false,
                    resultMessage: null,
                  })),
                },
              },
            };
          },
          verifyWrite: async () => ({
            outcome: "CONFIRMED",
            code: "TEST_CONFIRMED_APPLIED",
            message: null,
            endpointPath: "/test/invoice-upload-verification",
            targetCount: 1,
            confirmedCount: 1,
            observedStatuses: [],
          }),
        }),
    }
  );
  const group = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: item.package_group_id },
  });
  const storedRequests = await prisma.sales_channel_write_requests.findMany({
    where: {
      sales_channel_write_request_id: {
        in: requests.map((request) => request.sales_channel_write_request_id),
      },
    },
    orderBy: { sales_channel_write_request_id: "asc" },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });

  assert(
    readCount === 1 && dispatchCount === 1,
    `The completed half of an invoice batch was read or written again (reads=${readCount}, dispatches=${dispatchCount}).`
  );
  assert(
    result.status === "COMPLETED" &&
      result.completedCount === 2 &&
      group.group_status === "READY",
    "Retrying the failed half did not complete the package group."
  );
  assert(
    storedRequests[0].attempts.length === 1 &&
      storedRequests[1].attempts
        .map((attempt) => attempt.attempt_type)
        .join(",") === "WRITE,WRITE,LOCAL_FINALIZE",
    "Partial retry did not preserve completed and failed histories separately."
  );
}

async function assertInvoiceCallerConcurrentRetryUsesGatewayOwnership(
  issueApi,
  invoiceApi,
  writeService,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(ledgerApi, writeRules, [1]);
  const issueBatch = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem()]),
    }
  );
  const identity = await loadSingleInvoiceWriteIdentity(issueBatch.issueBatchId);
  const getOrdersheetByOrderId = createCoupangOrdersheetReader();
  let dispatchCount = 0;
  const requestWrite = (command, lifecycle) =>
    writeService.requestSalesChannelWrite(command, lifecycle, {
      executeWrite: async (writeCommand) => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          return {
            httpStatusCode: 200,
            payload: {
              code: "200",
              data: {
                responseCode: 99,
                responseList: writeCommand.invoiceItems.map((item) => ({
                  shipmentBoxId: item.shipmentBoxId,
                  succeed: false,
                  resultCode: "INVALID_ORDER_STATUS",
                  retryRequired: false,
                })),
              },
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          httpStatusCode: 200,
          payload: {
            code: "200",
            message: "OK",
            data: {
              responseCode: 0,
              responseMessage: "SUCCESS",
              responseList: writeCommand.invoiceItems.map((item) => ({
                shipmentBoxId: item.shipmentBoxId,
                succeed: true,
                resultCode: "OK",
                retryRequired: false,
                resultMessage: null,
              })),
            },
          },
        };
      },
      verifyWrite: async () =>
        assert(false, "An explicit invoice result must not trigger a GET."),
    });
  const dependencies = { getOrdersheetByOrderId, requestWrite };

  const first = await invoiceApi.submitCoupangInvoicesForIssueBatch(
    { issueBatchId: issueBatch.issueBatchId },
    dependencies
  );
  assert(first.status === "FAILED", "The first definitive failure was not exposed.");
  const failed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: identity.idempotencyKey },
  });
  assert(
    failed.request_status === "NOT_APPLIED",
    "The first invoice attempt was not retryable."
  );

  const retries = await Promise.all([
    invoiceApi.submitCoupangInvoicesForIssueBatch(
      { issueBatchId: issueBatch.issueBatchId },
      dependencies
    ),
    invoiceApi.submitCoupangInvoicesForIssueBatch(
      { issueBatchId: issueBatch.issueBatchId },
      dependencies
    ),
  ]);
  const completed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: identity.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });
  const requestCount = await prisma.sales_channel_write_requests.count({
    where: { idempotency_key: identity.idempotencyKey },
  });
  const group = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: identity.packageGroupId },
  });

  assert(dispatchCount === 2, "Concurrent invoice retry dispatched more than once.");
  assert(requestCount === 1, "Concurrent invoice retry created another request row.");
  assert(
    retries.some((result) => result.status === "COMPLETED") &&
      completed.request_status === "COMPLETED" &&
      group.group_status === "READY",
    "The owned invoice retry did not complete the package group."
  );
  assert(
    completed.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,WRITE,LOCAL_FINALIZE",
    "The invoice retry did not preserve one execution history per generation."
  );
}

async function assertCoupangPreflightBlocksStaleReceiver(
  issueApi,
  invoiceApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(ledgerApi, writeRules, [1]);
  const issueBatch = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem()]),
    }
  );
  const allocation = fixture.allocations[0];
  let writeCallCount = 0;
  let blocked = false;

  try {
    await invoiceApi.submitCoupangInvoicesForIssueBatch(
      { issueBatchId: issueBatch.issueBatchId },
      {
        getOrdersheetByOrderId: async () => ({
          httpStatusCode: 200,
          payload: {
            code: "SUCCESS",
            data: [
              {
                orderId: allocation.external_order_id,
                shipmentBoxId: allocation.external_shipment_id,
                status: "INSTRUCT",
                receiver: {
                  name: "변경된 수취인",
                  addr1: `${fixture.prefix}-address-0`,
                  addr2: "101",
                  postCode: "10000",
                },
                splitShipping: false,
                orderItems: [
                  {
                    vendorItemId: allocation.external_vendor_item_id,
                    shippingCount: 1,
                    holdCountForCancel: 0,
                    cancelCount: 0,
                    canceled: false,
                  },
                ],
              },
            ],
          },
        }),
        requestWrite: async () => {
          writeCallCount += 1;
          throw new Error("write must not be called");
        },
      }
    );
  } catch (error) {
    blocked =
      error instanceof invoiceApi.CoupangInvoiceSubmissionError &&
      error.code === "RECEIVER_CHANGED";
  }

  assert(blocked, "A receiver change was not caught by the batch preflight.");
  assert(writeCallCount === 0, "Coupang was written before the full preflight passed.");
}

async function assertConcurrentRequestIsIdempotent(
  issueApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1, 1]
  );
  let callCount = 0;
  const allocator = async () => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return allocationCall([allocationItem(), allocationItem()]);
  };
  const [first, second] = await Promise.all([
    issueApi.issueCarrierInvoicesForShipmentBatch(
      { shipmentListPrintBatchId: fixture.batchId },
      { allocateTrackingNumbers: allocator }
    ),
    issueApi.issueCarrierInvoicesForShipmentBatch(
      { shipmentListPrintBatchId: fixture.batchId },
      { allocateTrackingNumbers: allocator }
    ),
  ]);

  assert(callCount === 1, "Concurrent idempotent requests called Logen twice.");
  assert(
    first.issueBatchId === second.issueBatchId,
    "Concurrent requests did not converge on one issue batch."
  );
}

function assertOfficialLogenResponseShapeIsParsed(workflowApi) {
  const firstTrackingNumber = nextTrackingNumber();
  const secondTrackingNumber = nextTrackingNumber();
  const parsed = workflowApi.parseLogenTrackingNumberAllocation({
    carrierCode: "LOGEN",
    mode: "mock",
    source: "mock:/getSlipNo",
    apiName: "getSlipNo",
    requestPath: "/lrm02b-edi/edi/getSlipNo",
    method: "POST",
    operationType: "WRITE",
    httpStatusCode: 200,
    requestHash: "request",
    responseHash: "response",
    payload: {
      sttsCd: "SUCCESS",
      sttsMsg: "ok",
      data: {
        startSlipNo: firstTrackingNumber,
        closeSlipNo: secondTrackingNumber,
        data1: [
          { slipNo: firstTrackingNumber, resultCd: "TRUE", resultMsg: "" },
          { slipNo: secondTrackingNumber, resultCd: "TRUE", resultMsg: "" },
        ],
      },
    },
  });

  assert(parsed.items.length === 2, "Logen data.data1 was not parsed.");
  assert(
    parsed.items[0].trackingNumber === firstTrackingNumber &&
      parsed.items[1].trackingNumber === secondTrackingNumber,
    "The parser inferred a range instead of preserving data.data1 order."
  );
}

async function assertUncertainOutcomeIsLocked(issueApi, ledgerApi, writeRules) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1, 1]
  );
  let callCount = 0;
  const allocator = async () => {
    callCount += 1;
    throw new Error("simulated timeout after dispatch");
  };
  const first = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    { allocateTrackingNumbers: allocator }
  );
  const repeated = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    { allocateTrackingNumbers: allocator }
  );

  assert(first.status === "REVIEW_REQUIRED", "Timeout was not held for review.");
  assert(repeated.status === "REVIEW_REQUIRED", "Review hold was not preserved.");
  assert(callCount === 1, "An uncertain allocation was automatically retried.");
}

async function assertPartialAndShortResponsesArePreserved(
  issueApi,
  ledgerApi,
  writeRules
) {
  const partialFixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1, 1]
  );
  const partialTrackingNumber = nextTrackingNumber();
  const partial = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: partialFixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall(
          [
            allocationItem(partialTrackingNumber),
            {
              trackingNumber: null,
              resultCode: "FALSE",
              resultMessage: "simulated item failure",
              succeeded: false,
            },
          ],
          { statusCode: "PARTIAL SUCCESS" }
        ),
    }
  );
  assert(partial.status === "REVIEW_REQUIRED", "Partial success was not held.");
  assert(
    partial.allocatedPackageGroupCount === 1 &&
      partial.items[0].trackingNumber === partialTrackingNumber,
    "The successful part of a partial allocation was not preserved."
  );

  const shortFixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1, 1]
  );
  const shortTrackingNumber = nextTrackingNumber();
  const short = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: shortFixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem(shortTrackingNumber)]),
    }
  );
  assert(
    short.status === "REVIEW_REQUIRED" &&
      short.errorCode === "ALLOCATION_RESPONSE_COUNT_MISMATCH",
    "A short allocation response was not held for review."
  );
  assert(
    short.items[0].trackingNumber === shortTrackingNumber &&
      short.items[1].status === "MISSING_RESPONSE",
    "A short response did not preserve its successful item and missing slot."
  );

  const extraFixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  const extraNumbers = [nextTrackingNumber(), nextTrackingNumber()];
  const extra = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: extraFixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall(extraNumbers.map(allocationItem)),
    }
  );
  assert(
    extra.status === "REVIEW_REQUIRED" &&
      extra.unmatchedResponseItems[0]?.trackingNumber === extraNumbers[1],
    "An extra allocated tracking number was not preserved for review."
  );
}

async function assertDefinitiveFailureCanRetry(issueApi, ledgerApi, writeRules) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  let callCount = 0;
  const allocator = async () => {
    callCount += 1;
    if (callCount === 1) {
      return allocationCall(
        [
          {
            trackingNumber: null,
            resultCode: "FALSE",
            resultMessage: "simulated rejection",
            succeeded: false,
          },
        ],
        { statusCode: "FAIL", statusMessage: "simulated rejection" }
      );
    }
    return allocationCall([allocationItem()]);
  };

  const failed = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    { allocateTrackingNumbers: allocator }
  );
  const retried = await issueApi.retryFailedCarrierInvoiceIssueBatch(
    { issueBatchId: failed.issueBatchId },
    { allocateTrackingNumbers: allocator }
  );
  assert(failed.status === "FAILED", "A definitive rejection was not retryable.");
  assert(retried.status === "ALLOCATED", "A safe retry did not allocate.");
  assert(callCount === 2, "A definitive rejection did not make exactly one retry.");
}

async function assertConcurrentFailedRetryHasSingleOwner(
  issueApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  const failed = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall(
          [
            {
              trackingNumber: null,
              resultCode: "FALSE",
              resultMessage: "simulated rejection",
              succeeded: false,
            },
          ],
          { statusCode: "FAIL", statusMessage: "simulated rejection" }
        ),
    }
  );
  const enteredAllocator = deferred();
  const releaseAllocator = deferred();
  let retryAllocationCalls = 0;
  const retryDependencies = {
    allocateTrackingNumbers: async () => {
      retryAllocationCalls += 1;
      enteredAllocator.resolve();
      await releaseAllocator.promise;
      return allocationCall([allocationItem()]);
    },
  };

  const ownedRetry = issueApi.retryFailedCarrierInvoiceIssueBatch(
    { issueBatchId: failed.issueBatchId },
    retryDependencies
  );
  await enteredAllocator.promise;
  const concurrentRetry = await issueApi.retryFailedCarrierInvoiceIssueBatch(
    { issueBatchId: failed.issueBatchId },
    retryDependencies
  );
  releaseAllocator.resolve();
  const completedRetry = await ownedRetry;
  const stored = await prisma.carrier_invoice_issue_batches.findUniqueOrThrow({
    where: { carrier_invoice_issue_batch_id: failed.issueBatchId },
  });

  assert(
    concurrentRetry.status === "ALLOCATING",
    "A concurrent retry did not return the active allocation."
  );
  assert(
    completedRetry.status === "ALLOCATED",
    "The owned retry did not complete the allocation."
  );
  assert(
    retryAllocationCalls === 1,
    "Concurrent failed retries called Logen more than once."
  );
  assert(
    stored.attempt_count === 2 &&
      stored.allocation_request_dispatched === 1,
    "The failed retry did not preserve one owned execution generation."
  );
}

async function assertLateAllocationCannotOverwriteRecovery(
  issueApi,
  recoveryApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  const enteredAllocator = deferred();
  const releaseAllocator = deferred();
  let allocationCalls = 0;
  const dependencies = {
    allocateTrackingNumbers: async () => {
      allocationCalls += 1;
      enteredAllocator.resolve();
      await releaseAllocator.promise;
      return allocationCall([allocationItem()]);
    },
  };

  const operation = issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    dependencies
  );
  await enteredAllocator.promise;
  const recovery = await recoveryApi.recoverInterruptedCarrierInvoiceIssues({
    now: new Date("2030-01-01T00:00:00.000Z"),
    staleAfterMinutes: 1,
  });
  releaseAllocator.resolve();
  const result = await operation;
  const stored = await prisma.carrier_invoice_issue_batches.findUniqueOrThrow({
    where: { carrier_invoice_issue_batch_id: result.issueBatchId },
    include: { items: true },
  });
  const shipmentCount = await prisma.carrier_shipments.count({
    where: { package_group_id: fixture.packageGroupIds[0] },
  });
  const repeated = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    dependencies
  );

  assert(
    recovery.recoveredCount === 1 && recovery.reviewRequiredCount === 1,
    "A dispatched stale allocation was not recovered for review."
  );
  assert(
    result.status === "REVIEW_REQUIRED" &&
      repeated.status === "REVIEW_REQUIRED",
    "A recovered allocation was automatically reissued."
  );
  assert(
    stored.batch_status === "REVIEW_REQUIRED" &&
      stored.error_code ===
        "PROCESS_INTERRUPTED_AFTER_ALLOCATION_DISPATCH" &&
      stored.items.every(
        (item) =>
          item.item_status === "MISSING_RESPONSE" &&
          item.result_code === "OUTCOME_UNCERTAIN"
      ),
    "The recovered allocation evidence was overwritten by a late response."
  );
  assert(
    shipmentCount === 0 && allocationCalls === 1,
    "A late allocation response created a shipment or triggered another call."
  );
}

async function assertReplacementCandidateDoesNotSwitchCurrent(
  issueApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  const initialNumber = nextTrackingNumber();
  const initial = await issueApi.issueCarrierInvoicesForShipmentBatch(
    { shipmentListPrintBatchId: fixture.batchId },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem(initialNumber)]),
    }
  );
  const packageGroupId = initial.items[0].packageGroupId;
  const oldShipmentId = initial.items[0].carrierShipmentId;
  await prisma.shipment_package_groups.update({
    where: { package_group_id: packageGroupId },
    data: { group_status: "ON_HOLD" },
  });

  const candidateNumber = nextTrackingNumber();
  const candidate = await issueApi.allocateCarrierInvoiceReplacementCandidate(
    {
      shipmentListPrintBatchId: fixture.batchId,
      packageGroupId,
      requestKey: "candidate-current-invariant",
    },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem(candidateNumber)]),
    }
  );
  const group = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: packageGroupId },
  });
  const history = await prisma.carrier_shipments.findMany({
    where: { package_group_id: packageGroupId },
    orderBy: { revision_no: "asc" },
  });

  assert(candidate.status === "ALLOCATED", "Replacement candidate was not allocated.");
  assert(history.length === 2, "Replacement candidate revision was not preserved.");
  assert(
    group.current_carrier_shipment_id === oldShipmentId,
    "Candidate allocation changed the current invoice before Coupang confirmation."
  );
  assert(
    history[0].invoice_status !== "REPLACED",
    "Candidate allocation marked the old invoice replaced too early."
  );
  assert(
    history[1].tracking_number === candidateNumber &&
      history[1].carrier_shipment_id === candidate.items[0].carrierShipmentId,
    "Replacement candidate shipment was not linked to the issue item."
  );
}

async function assertReissueKeepsHistory(
  issueApi,
  successfulAllocation
) {
  const packageGroupId =
    successfulAllocation.issueBatch.items[0].packageGroupId;
  const oldShipmentId =
    successfulAllocation.issueBatch.items[0].carrierShipmentId;
  const replacementNumber = nextTrackingNumber();
  const reissue = await issueApi.reissueCarrierInvoicesForPackageGroups(
    {
      shipmentListPrintBatchId: successfulAllocation.fixture.batchId,
      packageGroupIds: [packageGroupId],
      requestKey: "integration-reissue-1",
    },
    {
      allocateTrackingNumbers: async () =>
        allocationCall([allocationItem(replacementNumber)]),
    }
  );
  const history = await prisma.carrier_shipments.findMany({
    where: { package_group_id: packageGroupId },
    orderBy: { revision_no: "asc" },
  });
  const group = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: packageGroupId },
  });

  assert(reissue.status === "ALLOCATED", "Reissue did not allocate a new number.");
  assert(history.length === 2, "Reissue overwrote the previous invoice history.");
  assert(
    history[0].carrier_shipment_id === oldShipmentId &&
      history[0].invoice_status === "REPLACED",
    "The previous invoice was not retained as replaced."
  );
  assert(
    history[1].revision_no === 2 &&
      history[1].replaces_carrier_shipment_id === oldShipmentId &&
      history[1].tracking_number === replacementNumber,
    "The replacement invoice revision chain is incomplete."
  );
  assert(
    group.current_carrier_shipment_id === history[1].carrier_shipment_id,
    "The package group does not point to the replacement invoice."
  );
}

async function assertPreflightBlocksExternalCall(issueApi, ledgerApi, writeRules) {
  const returnFixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  const allocation = returnFixture.allocations[0];
  const returnRaw = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: `${returnFixture.prefix}-RETURN`,
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      cancel_type: "RETURN",
      return_receipt_status: "RU",
      return_release_status: "N",
      cancel_count: 1,
      synced_at: returnFixture.timestamp,
      created_at: returnFixture.timestamp,
      updated_at: returnFixture.timestamp,
    },
  });
  await prisma.coupang_return_raw_item.create({
    data: {
      coupang_return_raw_id: returnRaw.coupang_return_raw_id,
      external_receipt_id: returnRaw.external_receipt_id,
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      external_vendor_item_id: allocation.external_vendor_item_id,
      vendor_item_name: allocation.external_vendor_item_id,
      cancel_count: 1,
      created_at: returnFixture.timestamp,
      updated_at: returnFixture.timestamp,
    },
  });
  let returnConflictCalls = 0;
  let returnConflictBlocked = false;
  try {
    await issueApi.issueCarrierInvoicesForShipmentBatch(
      { shipmentListPrintBatchId: returnFixture.batchId },
      {
        allocateTrackingNumbers: async () => {
          returnConflictCalls += 1;
          return allocationCall([allocationItem()]);
        },
      }
    );
  } catch (error) {
    returnConflictBlocked =
      error instanceof Error &&
      "code" in error &&
      error.code === "RETURN_PROCESSING_REQUIRED";
  }
  assert(returnConflictBlocked, "An active return did not block allocation.");
  assert(returnConflictCalls === 0, "Logen was called before return preflight passed.");

  const invalidFixture = await createConfirmedShipmentBatch(
    ledgerApi,
    writeRules,
    [1]
  );
  await prisma.shipment_package_groups.update({
    where: { package_group_id: invalidFixture.packageGroupIds[0] },
    data: { group_status: "ON_HOLD" },
  });
  let invalidGroupCalls = 0;
  let invalidGroupBlocked = false;
  try {
    await issueApi.issueCarrierInvoicesForShipmentBatch(
      { shipmentListPrintBatchId: invalidFixture.batchId },
      {
        allocateTrackingNumbers: async () => {
          invalidGroupCalls += 1;
          return allocationCall([allocationItem()]);
        },
      }
    );
  } catch (error) {
    invalidGroupBlocked =
      error instanceof issueApi.CarrierInvoiceIssueError &&
      error.code === "PACKAGE_GROUP_NOT_FROZEN";
  }
  assert(invalidGroupBlocked, "A non-frozen package group was not blocked.");
  assert(invalidGroupCalls === 0, "Logen was called before group preflight passed.");
}

async function assertInvoiceOperationReadModels(
  queryApi,
  successfulAllocation
) {
  const carrierShipmentId =
    successfulAllocation.issueBatch.items[0].carrierShipmentId;
  const trackingNumber =
    successfulAllocation.issueBatch.items[0].trackingNumber;
  const history = await queryApi.listCarrierInvoiceHistory({
    search: trackingNumber,
    limit: 20,
  });
  assert(
    history.items.some(
      (item) => item.carrierShipmentId === carrierShipmentId
    ),
    "Invoice history read model did not return the allocated shipment."
  );
  const detail = await queryApi.getCarrierInvoiceHistoryDetail({
    carrierShipmentId,
  });
  assert(
    detail.revisions.length >= 2,
    "Invoice history detail did not preserve the reissue revision chain."
  );
  const manualCandidates =
    await queryApi.listCarrierInvoiceManualCandidates({ limit: 100 });
  assert(
    manualCandidates.items.some(
      (item) => item.status === "REVIEW_REQUIRED"
    ),
    "Manual invoice candidate read model omitted a review-required allocation."
  );
}

async function assertShipmentDeliverySearchReadModel(
  deliverySearchApi,
  successfulAllocation
) {
  const packageGroupId =
    successfulAllocation.issueBatch.items[0].packageGroupId;
  const history = await prisma.carrier_shipments.findMany({
    where: { package_group_id: packageGroupId },
    orderBy: { revision_no: "asc" },
  });
  assert(
    history.length >= 2,
    "Delivery search fixture does not contain a reissued invoice."
  );
  const oldTrackingNumber = history[0].tracking_number;
  const currentTrackingNumber = history.at(-1).tracking_number;
  const result = await deliverySearchApi.searchShipmentDeliveryPackages({
    search: oldTrackingNumber,
    limit: 20,
  });
  const row = result.items.find(
    (item) => item.packageGroupId === packageGroupId
  );

  assert(
    result.items.length === 1 && row,
    "A previous tracking number did not resolve to one current physical parcel."
  );
  assert(
    row.trackingNumber === currentTrackingNumber &&
      row.reissued &&
      row.revisionNo >= 2,
    "Delivery search did not expose the current invoice revision."
  );
  assert(
    row.packingType === "COMBINED" &&
      row.memberCount === 2 &&
      row.printLineNumbers.length === 2,
    "Delivery search did not preserve the co-packaged parcel summary."
  );

  const detail =
    await deliverySearchApi.getShipmentDeliveryPackageDetail({
      packageGroupId,
    });
  assert(
    detail.revisions.length >= 2 &&
      detail.revisions.filter((revision) => revision.isCurrent).length === 1 &&
      detail.members.length === 2,
    "Delivery search detail lost invoice revisions or package members."
  );
  assert(
    detail.receiver.maskedPhone &&
      !detail.receiver.maskedPhone.includes("010-1234"),
    "Delivery search detail exposed the receiver phone number."
  );

  await prisma.carrier_reconciliation_works.create({
    data: {
      carrier_code: "LOGEN",
      operation_type: "DELIVERY_SEARCH_TEST",
      lookup_key_type: "PACKAGE_GROUP_ID",
      lookup_key_value: String(packageGroupId),
      reconciliation_status: "PENDING",
      reason: "delivery search review filter",
    },
  });
  const reviewResult =
    await deliverySearchApi.searchShipmentDeliveryPackages({
      review: "REQUIRED",
      search: currentTrackingNumber,
      limit: 20,
    });
  assert(
    reviewResult.items.some(
      (item) =>
        item.packageGroupId === packageGroupId &&
        item.reviewRequired &&
        item.reviewCount > 0
    ),
    "Delivery search omitted an unresolved carrier review."
  );

  const completed = await prisma.shipment_package_groups.findFirst({
    where: { group_status: "COMPLETED" },
  });
  if (completed) {
    const deliveredResult =
      await deliverySearchApi.searchShipmentDeliveryPackages({
        stage: "DELIVERED",
        limit: 300,
      });
    assert(
      deliveredResult.items.some(
        (item) =>
          item.packageGroupId === completed.package_group_id &&
          item.deliveryStage === "DELIVERED"
      ),
      "Delivery search omitted a completed physical parcel."
    );
  }

  let invalidRangeBlocked = false;
  try {
    await deliverySearchApi.searchShipmentDeliveryPackages({
      from: "2026-07-24",
      to: "2026-07-23",
    });
  } catch (error) {
    invalidRangeBlocked =
      error instanceof deliverySearchApi.ShipmentDeliverySearchValidationError;
  }
  assert(invalidRangeBlocked, "An invalid delivery search date range was accepted.");
}

try {
  await waitForLogenMock();
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const issueApi = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const writeRules = await import(
    "@/quickhack_shared/inventory/inventory-write-rules"
  );
  const workflowApi = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/workflow-service"
  );
  const invoiceApi = await import(
    "@/quickhack_server/shipment/carrier-integration/coupang-invoice-upload-service"
  );
  const writeService = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-service"
  );
  const verificationService = await import(
    "@/quickhack_server/sales-channel/coupang/write-verification-service"
  );
  const registrationApi = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/shipment-registration-service"
  );
  const labelApi = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/label-print-service"
  );
  const trackingApi = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/tracking-sync-service"
  );
  const deliveryProjectionApi = await import(
    "@/quickhack_server/shipment/delivery-status-projection-service"
  );
  const trackingQueryApi = await import(
    "@/quickhack_server/shipment/shipment-tracking-query-service"
  );
  const invoiceOperationQueryApi = await import(
    "@/quickhack_server/shipment/carrier-integration/invoice-operation-query-service"
  );
  const deliverySearchApi = await import(
    "@/quickhack_server/shipment/shipment-delivery-search-service"
  );
  const recoveryApi = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-recovery-service"
  );

  assertOfficialLogenResponseShapeIsParsed(workflowApi);
  const successfulAllocation = await assertSuccessfulIdempotentAllocation(
    issueApi,
    ledgerApi,
    writeRules
  );
  await assertConcurrentRequestIsIdempotent(issueApi, ledgerApi, writeRules);
  await assertUncertainOutcomeIsLocked(issueApi, ledgerApi, writeRules);
  await assertPartialAndShortResponsesArePreserved(
    issueApi,
    ledgerApi,
    writeRules
  );
  await assertDefinitiveFailureCanRetry(issueApi, ledgerApi, writeRules);
  await assertConcurrentFailedRetryHasSingleOwner(
    issueApi,
    ledgerApi,
    writeRules
  );
  await assertLateAllocationCannotOverwriteRecovery(
    issueApi,
    recoveryApi,
    ledgerApi,
    writeRules
  );
  await assertReplacementCandidateDoesNotSwitchCurrent(
    issueApi,
    ledgerApi,
    writeRules
  );
  await assertReissueKeepsHistory(issueApi, successfulAllocation);
  await assertPreflightBlocksExternalCall(issueApi, ledgerApi, writeRules);
  await assertInvoiceOperationReadModels(
    invoiceOperationQueryApi,
    successfulAllocation
  );
  await assertCoupangInvoiceUploadFlow(
    issueApi,
    invoiceApi,
    writeService,
    verificationService,
    ledgerApi,
    writeRules,
    registrationApi,
    labelApi,
    trackingApi,
    deliveryProjectionApi,
    trackingQueryApi
  );
  await assertInvoiceCallerRetryStatusRouting(
    issueApi,
    invoiceApi,
    ledgerApi,
    writeRules
  );
  await assertInvoiceCallerRetriesOnlyFailedPartOfBatch(
    issueApi,
    invoiceApi,
    writeService,
    ledgerApi,
    writeRules
  );
  await assertInvoiceCallerConcurrentRetryUsesGatewayOwnership(
    issueApi,
    invoiceApi,
    writeService,
    ledgerApi,
    writeRules
  );
  await assertCoupangPreflightBlocksStaleReceiver(
    issueApi,
    invoiceApi,
    ledgerApi,
    writeRules
  );
  await assertShipmentDeliverySearchReadModel(
    deliverySearchApi,
    successfulAllocation
  );
  console.log("Carrier invoice issue flow verified.");
} finally {
  await prisma?.$disconnect();
  if (logenMock.exitCode === null && logenMock.signalCode === null) {
    logenMock.kill();
    await new Promise((resolve) => {
      logenMock.once("exit", resolve);
      setTimeout(resolve, 2000).unref?.();
    });
    if (logenMock.exitCode === null && logenMock.signalCode === null) {
      logenMock.kill("SIGKILL");
      await new Promise((resolve) => logenMock.once("exit", resolve));
    }
  }
  temporaryDatabase.cleanup();
  logenMockDatabase.cleanup();
}
