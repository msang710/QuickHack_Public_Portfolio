import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-coupang-projection-revision-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const { prisma } = await import("@/quickhack_server/core/prisma");
const {
  normalizeOrdersheet,
  ordersheetsFromPayload,
  normalizeReturnRequest,
  persistCoupangOrderRawSnapshots,
  persistCoupangReturnRawSnapshots,
  syncCoupangAcceptOrders,
  syncCoupangAfterShipmentClaims,
} = await import("@/quickhack_server/sales-channel/coupang/sync-service");
const {
  advanceSalesChannelProjectionRevision,
  reserveSalesChannelProjectionObservation,
  SALES_CHANNEL_PROJECTION_CHANNEL,
} = await import(
  "@/quickhack_server/sales-channel/projection-revision-service"
);
const { projectConfirmedCoupangInvoiceWrite } = await import(
  "@/quickhack_server/shipment/carrier-integration/coupang-invoice-finalizer"
);
const { nowKstSqlDateTime } = await import("@/quickhack_shared/core/time");

const ORDER_ID = "935770000000008808";
const SHIPMENT_ID = "884440000000008808";
const VENDOR_ITEM_ID = "3187044808";

function credentialContext() {
  return {
    context: {
      providerType: "USB_QHKEY",
      channel: "COUPANG",
      status: "ACTIVE",
      keyAlias: "projection-revision-test",
      keyFingerprint: "PROJECTION-REVISION",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2036-01-01T00:00:00.000Z",
      warningMessage: null,
      errorMessage: null,
      readEnabled: true,
      writeEnabled: true,
      mode: "mock",
      apiHost: "http://127.0.0.1:3100",
      vendorId: "TEST-VENDOR",
      timeoutMs: 1_000,
    },
    sign() {
      throw new Error("Injected readers must not use the fake signer.");
    },
  };
}

function orderPayload(input = {}) {
  const timestamp = new Date().toISOString();
  return {
    orderId: input.orderId ?? ORDER_ID,
    shipmentBoxId: input.shipmentId ?? SHIPMENT_ID,
    status: input.status ?? "ACCEPT",
    orderedAt: timestamp,
    paidAt: timestamp,
    orderer: { name: input.ordererName ?? "Orderer" },
    receiver: {
      name: input.receiverName ?? "Receiver",
      safeNumber: "050700001234",
      addr1: "Seoul test address 1",
      addr2: "101",
      postCode: "01234",
    },
    parcelPrintMessage: "Door",
    deliveryCompanyName: input.deliveryCompanyName ?? null,
    invoiceNumber: input.invoiceNumber ?? null,
    splitShipping: false,
    deliveredDate: input.deliveredDate ?? null,
    orderItems: [
      {
        vendorItemId: input.vendorItemId ?? VENDOR_ITEM_ID,
        vendorItemName: input.vendorItemName ?? "Revision item",
        shippingCount: input.shippingCount ?? 1,
        holdCountForCancel: 0,
        cancelCount: 0,
        canceled: false,
        salesPrice: 1000,
      },
    ],
  };
}

function apiResponse(payload, hash) {
  const responsePayload = {
    code: "SUCCESS",
    data: [payload],
    nextToken: "",
  };

  return {
    mode: "mock",
    source: "mock:/ordersheets",
    requestPath: "/ordersheets?status=ACCEPT",
    httpStatusCode: 200,
    responseHash: hash,
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "projection-revision-test",
      keyFingerprint: "PROJECTION-REVISION",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload: responsePayload,
    rawPayloadText: JSON.stringify(responsePayload),
  };
}

function claimApiResponse(requestPath, payload, hash) {
  const responsePayload = { code: "200", ...payload };
  return {
    mode: "mock",
    source: `mock:${requestPath}`,
    requestPath,
    httpStatusCode: 200,
    responseHash: hash,
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "projection-revision-test",
      keyFingerprint: "PROJECTION-REVISION",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload: responsePayload,
    rawPayloadText: JSON.stringify(responsePayload),
  };
}

function exchangePayload(status) {
  return {
    exchangeId: "881230000000008808",
    orderId: ORDER_ID,
    originalShipmentBoxId: SHIPMENT_ID,
    exchangeStatus: status,
    faultType: "CUSTOMER",
    reasonCode: "EXCHANGE_REQUEST",
    reasonCodeText: "Exchange request",
    reasonEtcDetail: status,
    createdAt: "2026-08-08T10:00:00+09:00",
    modifiedAt: "2026-08-08T10:00:00+09:00",
    exchangeItemDtoV1s: [
      { originalShipmentBoxId: SHIPMENT_ID },
    ],
  };
}

function claimDependencies(getExchangeRequests) {
  return {
    openCredentialContext: credentialContext,
    async getReturnRequests() {
      return claimApiResponse(
        "/returnRequests",
        { data: [], nextToken: "" },
        "empty-return-response"
      );
    },
    getExchangeRequests,
    async getReturnWithdrawals() {
      return claimApiResponse(
        "/returnWithdrawRequests",
        { data: [], nextPageIndex: "" },
        "empty-withdrawal-response"
      );
    },
  };
}

function returnPayload(receiptId, status, cancelCount) {
  return {
    receiptId,
    orderId: ORDER_ID,
    shipmentBoxId: SHIPMENT_ID,
    receiptType: "RETURN",
    receiptStatus: status,
    releaseStopStatus: "N",
    reasonCode: "CHANGE_MIND",
    reasonCodeText: "Change mind",
    cancelCountSum: cancelCount,
    createdAt: "2026-08-08T10:00:00+09:00",
    modifiedAt: "2026-08-08T10:00:00+09:00",
    returnItems: [
      {
        shipmentBoxId: SHIPMENT_ID,
        vendorItemId: VENDOR_ITEM_ID,
        cancelCount,
        releaseStatus: "N",
      },
    ],
  };
}

async function expectRejected(action, pattern, label) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert(caught, `${label} did not reject.`);
  assert(
    pattern.test(caught instanceof Error ? caught.message : String(caught)),
    `${label} rejected for an unexpected reason.`
  );
}

try {
  const providerDeliveredAt = "2026-08-07T09:15:30+09:00";
  const deliveredOrder = ordersheetsFromPayload({
    code: "200",
    data: [
      orderPayload({
        orderId: "935770000000008818",
        shipmentId: "884440000000008818",
        status: "FINAL_DELIVERY",
        deliveredDate: providerDeliveredAt,
      }),
    ],
  }).orders[0];
  await persistCoupangOrderRawSnapshots(
    [deliveredOrder],
    await reserveSalesChannelProjectionObservation(),
    "2026-08-10 12:00:00"
  );
  const deliveredRaw = await prisma.coupang_order_raw.findUniqueOrThrow({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: deliveredOrder.externalOrderId,
        external_shipment_id: deliveredOrder.externalShipmentId,
      },
    },
  });
  assert(
    deliveredRaw.delivered_at?.toISOString() === "2026-08-07T00:15:30.000Z" &&
      deliveredRaw.delivery_occurred_at?.toISOString() ===
        "2026-08-07T00:15:30.000Z" &&
      deliveredRaw.delivery_time_source === "COUPANG_DELIVERED_DATE",
    "Provider delivery time was not preserved separately from ingestion time."
  );

  let releaseOlderRead;
  let markOlderReadStarted;
  const olderReadStarted = new Promise((resolve) => {
    markOlderReadStarted = resolve;
  });
  const olderReadGate = new Promise((resolve) => {
    releaseOlderRead = resolve;
  });

  const olderSync = syncCoupangAcceptOrders(
    { reason: "projection-revision-older" },
    {
      openCredentialContext: credentialContext,
      async getOrdersheets() {
        markOlderReadStarted();
        await olderReadGate;
        return apiResponse(
          orderPayload({ receiverName: "Older receiver", shippingCount: 1 }),
          "older-response"
        );
      },
    }
  );
  await olderReadStarted;

  const newerSummary = await syncCoupangAcceptOrders(
    { reason: "projection-revision-newer" },
    {
      openCredentialContext: credentialContext,
      async getOrdersheets() {
        return apiResponse(
          orderPayload({ receiverName: "Newer receiver", shippingCount: 2 }),
          "newer-response"
        );
      },
    }
  );
  releaseOlderRead();
  const olderSummary = await olderSync;

  assert(
    newerSummary.orders === 1,
    `The newer response was not applied: ${JSON.stringify(newerSummary)}`
  );
  assert(
    olderSummary.orders === 0 && olderSummary.staleSnapshotCount === 1,
    "The older response was not classified as stale."
  );

  const [rawOrder, workItem, staleLog] = await Promise.all([
    prisma.coupang_order_raw.findUniqueOrThrow({
      where: {
        external_order_id_external_shipment_id: {
          external_order_id: ORDER_ID,
          external_shipment_id: SHIPMENT_ID,
        },
      },
    }),
    prisma.order_matching_work_queue.findUniqueOrThrow({
      where: {
        channel_external_order_id_external_shipment_id_external_vendor_item_id: {
          channel: "COUPANG",
          external_order_id: ORDER_ID,
          external_shipment_id: SHIPMENT_ID,
          external_vendor_item_id: VENDOR_ITEM_ID,
        },
      },
    }),
    prisma.coupang_api_call_log.findFirstOrThrow({
      where: { stale_snapshot_count: 1 },
    }),
  ]);
  assert(
    rawOrder.receiver_name === "Newer receiver",
    "A stale response replaced the newer raw order."
  );
  assert(
    workItem.ordered_quantity === 2,
    "A stale response changed the matching work item."
  );
  assert(
    staleLog.projection_revision !== null &&
      staleLog.skipped_row_count === 1 &&
      staleLog.processed_row_count === 0,
    "The stale API call was not recorded distinctly."
  );

  const instructObservation =
    await reserveSalesChannelProjectionObservation();
  const instructSnapshot = normalizeOrdersheet(
    orderPayload({ status: "INSTRUCT", receiverName: "Current receiver" })
  );
  await persistCoupangOrderRawSnapshots(
    [instructSnapshot],
    instructObservation
  );
  const readStartedBeforeWrite =
    await reserveSalesChannelProjectionObservation();
  await prisma.$transaction((tx) =>
    projectConfirmedCoupangInvoiceWrite({
      tx,
      mode: "UPLOAD",
      targets: [
        {
          external_order_id: ORDER_ID,
          external_shipment_id: SHIPMENT_ID,
          target_external_id: SHIPMENT_ID,
          invoice_number_snapshot: "12345678901",
        },
      ],
      finalizedAt: nowKstSqlDateTime(),
    })
  );
  const staleAfterWrite = await persistCoupangOrderRawSnapshots(
    [instructSnapshot],
    readStartedBeforeWrite
  );
  const afterWrite = await prisma.coupang_order_raw.findUniqueOrThrow({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: ORDER_ID,
        external_shipment_id: SHIPMENT_ID,
      },
    },
  });
  assert(
    staleAfterWrite.staleSnapshotCount === 1 &&
      afterWrite.external_order_status === "DEPARTURE" &&
      afterWrite.invoice_number === "12345678901",
    "A read started before the acknowledged write rolled back its projection."
  );

  const clockBeforeRollback =
    await prisma.sales_channel_projection_clocks.findUniqueOrThrow({
      where: { channel: SALES_CHANNEL_PROJECTION_CHANNEL.coupang },
    });
  await expectRejected(
    () =>
      prisma.$transaction(async (tx) => {
        await advanceSalesChannelProjectionRevision(
          tx,
          SALES_CHANNEL_PROJECTION_CHANNEL.coupang
        );
        throw new Error("forced rollback");
      }),
    /forced rollback/,
    "projection revision rollback"
  );
  const clockAfterRollback =
    await prisma.sales_channel_projection_clocks.findUniqueOrThrow({
      where: { channel: SALES_CHANNEL_PROJECTION_CHANNEL.coupang },
    });
  assert(
    clockAfterRollback.current_revision === clockBeforeRollback.current_revision,
    "A rolled-back finalizer consumed a projection revision."
  );

  const receiptId = "991230000000008808";
  const olderReturnObservation =
    await reserveSalesChannelProjectionObservation();
  const newerReturnObservation =
    await reserveSalesChannelProjectionObservation();
  const completedReturn = normalizeReturnRequest(
    returnPayload(receiptId, "RETURNS_COMPLETED", 2)
  );
  const uncheckedReturn = normalizeReturnRequest(
    returnPayload(receiptId, "RETURNS_UNCHECKED", 1)
  );
  await persistCoupangReturnRawSnapshots(
    [completedReturn],
    newerReturnObservation
  );
  const staleReturn = await persistCoupangReturnRawSnapshots(
    [uncheckedReturn],
    olderReturnObservation
  );
  const [returnRow, returnItems, returnEvents] = await Promise.all([
    prisma.coupang_return_raw.findUniqueOrThrow({
      where: { external_receipt_id: receiptId },
    }),
    prisma.coupang_return_raw_item.findMany({
      where: { external_receipt_id: receiptId },
    }),
    prisma.coupang_raw_change_event.count({
      where: { external_receipt_id: receiptId },
    }),
  ]);
  assert(
    staleReturn.returns === 0 && staleReturn.staleSnapshotCount === 1,
    "The stale return response was not skipped."
  );
  assert(
    returnRow.return_receipt_status === "RETURNS_COMPLETED" &&
      returnItems.length === 1 &&
      returnItems[0].cancel_count === 2 &&
      returnEvents === 1,
    "The stale return response changed child rows or claim history."
  );

  const mixedObservation = await reserveSalesChannelProjectionObservation();
  const existingNewerObservation =
    await reserveSalesChannelProjectionObservation();
  await persistCoupangReturnRawSnapshots(
    [completedReturn],
    existingNewerObservation
  );
  const mixedResult = await persistCoupangReturnRawSnapshots(
    [
      uncheckedReturn,
      normalizeReturnRequest(
        returnPayload("991230000000008809", "RETURNS_UNCHECKED", 1)
      ),
    ],
    mixedObservation
  );
  assert(
    mixedResult.returns === 1 && mixedResult.staleSnapshotCount === 1,
    "A mixed page was not decided independently per business entity."
  );

  let releaseOlderExchangeRead;
  let markOlderExchangeReadStarted;
  const olderExchangeReadStarted = new Promise((resolve) => {
    markOlderExchangeReadStarted = resolve;
  });
  const olderExchangeReadGate = new Promise((resolve) => {
    releaseOlderExchangeRead = resolve;
  });
  const olderClaimSync = syncCoupangAfterShipmentClaims(
    { reason: "projection-revision-older-exchange" },
    claimDependencies(async () => {
      markOlderExchangeReadStarted();
      await olderExchangeReadGate;
      return claimApiResponse(
        "/exchangeRequests",
        { data: [exchangePayload("RECEIPT")], nextToken: "" },
        "older-exchange-response"
      );
    })
  );
  await olderExchangeReadStarted;
  const newerClaimSummary = await syncCoupangAfterShipmentClaims(
    { reason: "projection-revision-newer-exchange" },
    claimDependencies(async () =>
      claimApiResponse(
        "/exchangeRequests",
        { data: [exchangePayload("SUCCESS")], nextToken: "" },
        "newer-exchange-response"
      )
    )
  );
  releaseOlderExchangeRead();
  const olderClaimSummary = await olderClaimSync;
  const [exchangeRow, exchangeEvents] = await Promise.all([
    prisma.coupang_exchange_raw.findUniqueOrThrow({
      where: { external_exchange_id: "881230000000008808" },
    }),
    prisma.coupang_raw_change_event.count({
      where: { external_exchange_id: "881230000000008808" },
    }),
  ]);
  assert(
    newerClaimSummary.exchanges.exchanges === 1 &&
      olderClaimSummary.exchanges.exchanges === 0 &&
      olderClaimSummary.exchanges.staleSnapshotCount === 1,
    "The older exchange response was not classified as stale."
  );
  assert(
    exchangeRow.exchange_status === "SUCCESS" && exchangeEvents === 1,
    "A stale exchange response changed the raw row or claim history."
  );

  await expectRejected(
    () =>
      prisma.$executeRawUnsafe(
        `UPDATE coupang_order_raw SET projection_revision = projection_revision - 1 WHERE external_order_id = '${ORDER_ID}'`
      ),
    /projection revision cannot decrease/,
    "raw projection revision regression"
  );
  await expectRejected(
    () =>
      prisma.$executeRawUnsafe(
        "UPDATE sales_channel_projection_clocks SET current_revision = current_revision + 2 WHERE channel = 'COUPANG'"
      ),
    /revision must increase by one/,
    "projection clock gap"
  );

  console.log("Coupang projection revision race tests passed.");
} finally {
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
