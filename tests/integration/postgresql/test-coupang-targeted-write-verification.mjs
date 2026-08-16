import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-targeted-write-verification-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const timestamp = new Date("2026-07-21T12:00:00.000Z");
let prisma;

function apiResponse(payload, requestPath = "/integration-test") {
  return {
    mode: "mock",
    source: "integration-test",
    requestPath,
    httpStatusCode: 200,
    responseHash: "integration-test-response",
    auth: {},
    payload,
  };
}

function orderPayload(orderId, shipmentBoxId, status, invoiceNumber = null) {
  return {
    orderId,
    shipmentBoxId,
    status,
    orderedAt: "2026-07-21T10:00:00",
    paidAt: "2026-07-21T10:01:00",
    orderer: { name: "orderer" },
    receiver: {
      name: "receiver",
      safeNumber: "0504-0000-0000",
      addr1: "address 1",
      addr2: "address 2",
      postCode: "00000",
    },
    parcelPrintMessage: "message",
    invoiceNumber,
    deliveryCompanyCode: invoiceNumber ? "KGB" : null,
    orderItems: [],
  };
}

async function createOrderWriteRequest(input) {
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: "VERIFYING",
      idempotency_key: input.idempotencyKey,
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/ordersheets/acknowledgement",
      expected_before_status: "ACCEPT",
      requested_after_status: "INSTRUCT",
      source_menu_key: "integration-test",
      source_entity_type: "COUPANG_SHIPMENT_BATCH",
      source_entity_id: input.idempotencyKey,
      requested_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  for (const [targetPosition, target] of input.targets.entries()) {
    await prisma.sales_channel_write_request_targets.create({
      data: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        target_position: targetPosition,
        target_type: "SHIPMENT_BOX",
        target_external_id: target.shipmentId,
        external_order_id: target.orderId,
        external_shipment_id: target.shipmentId,
        quantity: 1,
        expected_before_status: "ACCEPT",
        requested_after_status: "INSTRUCT",
        created_at: timestamp,
      },
    });
  }

  return request;
}

async function createReturnWriteTargets(input) {
  await prisma.sales_channel_write_request_targets.createMany({
    data: [
      {
        sales_channel_write_request_id: input.requestId,
        target_position: 0,
        target_type: "MATCH_WORKER_ALLOCATION",
        target_external_id: "101",
        external_order_id: input.externalOrderId,
        external_shipment_id: input.shipmentId,
        expected_before_status: "N",
        requested_after_status: "S",
        created_at: timestamp,
      },
      {
        sales_channel_write_request_id: input.requestId,
        target_position: 1,
        target_type: "MATCH_WORKER_ALLOCATION",
        target_external_id: "102",
        external_order_id: input.externalOrderId,
        external_shipment_id: input.shipmentId,
        expected_before_status: "N",
        requested_after_status: "S",
        created_at: timestamp,
      },
      {
        sales_channel_write_request_id: input.requestId,
        target_position: 2,
        target_type: "SUPPLY_CONSUMPTION_EVENT",
        target_external_id: "9001",
        external_order_id: input.externalOrderId,
        external_shipment_id: input.shipmentId,
        expected_before_status: "N",
        requested_after_status: "S",
        created_at: timestamp,
      },
    ],
  });

  return prisma.sales_channel_write_request_targets.findMany({
    where: { sales_channel_write_request_id: input.requestId },
    orderBy: { target_position: "asc" },
    select: { sales_channel_write_request_target_id: true },
  });
}

async function assertOrderIdsAreDeduplicated(verificationApi) {
  const targets = [
    { orderId: "935770000000000001", shipmentId: "884440000000000001" },
    { orderId: "935770000000000001", shipmentId: "884440000000000002" },
    { orderId: "935770000000000002", shipmentId: "884440000000000003" },
  ];
  const request = await createOrderWriteRequest({
    idempotencyKey: "TEST:TARGETED:ORDER:CONFIRMED",
    targets,
  });
  const calls = [];
  const credentialContext = { id: "order-verification-context" };
  const observedContexts = [];
  let credentialContextOpenCount = 0;

  const result = await verificationApi.verifyAndRefreshCoupangWriteRequest(
    {
      requestId: request.sales_channel_write_request_id,
      triggerType: "IMMEDIATE_VERIFY",
    },
    {
      openCredentialContext: () => {
        credentialContextOpenCount += 1;
        return credentialContext;
      },
      getOrdersheetByOrderId: async (orderId, context) => {
        calls.push(String(orderId));
        observedContexts.push(context);
        const orders = targets
          .filter((target) => target.orderId === String(orderId))
          .map((target) =>
            orderPayload(target.orderId, target.shipmentId, "INSTRUCT")
          );
        return apiResponse({ code: "SUCCESS", message: "OK", data: orders });
      },
    }
  );

  assert(result.outcome === "CONFIRMED", "Order verification did not confirm.");
  assert(result.confirmedCount === 3, "Not all shipment targets were confirmed.");
  assert(
    result.targetGroups.length === 3 &&
      result.targetGroups.every((group) => group.outcome === "CONFIRMED"),
    "Order verification did not return one confirmed result per shipment group."
  );
  assert(calls.length === 2, "Duplicate order IDs caused duplicate API calls.");
  assert(new Set(calls).size === 2, "Order ID calls were not deduplicated.");
  assert(
    credentialContextOpenCount === 1,
    "Order verification reopened the credential context."
  );
  assert(
    observedContexts.every((context) => context === credentialContext),
    "Order verification did not reuse one credential context."
  );
  assert(
    (await prisma.coupang_order_raw.count({
      where: {
        external_shipment_id: { in: targets.map((target) => target.shipmentId) },
      },
    })) === 3,
    "Targeted order snapshots were not persisted."
  );
}

async function assertPartialOrderVerificationStaysUnknown(verificationApi) {
  const target = {
    orderId: "935770000000000003",
    shipmentId: "884440000000000004",
  };
  const request = await createOrderWriteRequest({
    idempotencyKey: "TEST:TARGETED:ORDER:UNKNOWN",
    targets: [target],
  });
  const result = await verificationApi.verifyAndRefreshCoupangWriteRequest(
    {
      requestId: request.sales_channel_write_request_id,
      triggerType: "IMMEDIATE_VERIFY",
    },
    {
      getOrdersheetByOrderId: async () =>
        apiResponse({
          code: "SUCCESS",
          message: "OK",
          data: [orderPayload(target.orderId, target.shipmentId, "ACCEPT")],
        }),
    }
  );

  assert(result.outcome === "UNKNOWN", "A stale order status was confirmed.");
  assert(result.confirmedCount === 0, "A stale order target was counted.");
}

async function assertMixedOrderGroupsStayIndependentlyRecoverable(
  verificationApi
) {
  const targets = [
    { orderId: "935770000000000031", shipmentId: "884440000000000041" },
    { orderId: "935770000000000032", shipmentId: "884440000000000042" },
  ];
  const request = await createOrderWriteRequest({
    idempotencyKey: "TEST:TARGETED:ORDER:PARTIAL-GROUPS",
    targets,
  });
  const result = await verificationApi.verifyAndRefreshCoupangWriteRequest(
    {
      requestId: request.sales_channel_write_request_id,
      triggerType: "IMMEDIATE_VERIFY",
    },
    {
      getOrdersheetByOrderId: async (orderId) => {
        const target = targets.find((candidate) => candidate.orderId === orderId);
        return apiResponse({
          code: "SUCCESS",
          message: "OK",
          data: [
            orderPayload(
              target.orderId,
              target.shipmentId,
              target === targets[0] ? "INSTRUCT" : "ACCEPT"
            ),
          ],
        });
      },
    }
  );

  assert(result.outcome === "PARTIAL", "Mixed shipment groups were collapsed.");
  assert(result.confirmedCount === 1, "Confirmed group count was not preserved.");
  assert(
    result.targetGroups[0]?.outcome === "CONFIRMED" &&
      result.targetGroups[1]?.outcome === "UNKNOWN",
    "Mixed shipment group outcomes were not kept independently."
  );
}

async function assertPostInstructAddressRefreshDoesNotJudgeOrderStatus(
  verificationApi
) {
  const target = {
    orderId: "935770000000000030",
    shipmentId: "884440000000000040",
  };
  const request = await createOrderWriteRequest({
    idempotencyKey: "TEST:REFRESH:ORDER:NON-AUTHORITATIVE",
    targets: [target],
  });
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: target.orderId,
      external_shipment_id: target.shipmentId,
      external_order_status: "DEPARTURE",
      receiver_name: "old receiver",
      receiver_safe_number: "0504-1111-1111",
      receiver_address_1: "old address 1",
      receiver_address_2: "old address 2",
      receiver_post_code: "11111",
      shipping_memo: "old message",
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  let readCount = 0;
  const result = await verificationApi.refreshCoupangOrderAddressesAfterInstruct(
    { requestId: request.sales_channel_write_request_id },
    {
      getOrdersheetByOrderId: async () => {
        readCount += 1;
        return apiResponse({
          code: "SUCCESS",
          message: "OK",
          data: [orderPayload(target.orderId, target.shipmentId, "ACCEPT")],
        });
      },
    }
  );

  assert(readCount === 1, "Post-success refresh polled the order status.");
  assert(
    result.status === "SUCCEEDED" &&
      result.refreshedTargetCount === 1 &&
      result.failedTargetCount === 0,
    "Post-success refresh treated an unexpected status as write failure."
  );
  const refreshed = await prisma.coupang_order_raw.findUnique({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: target.orderId,
        external_shipment_id: target.shipmentId,
      },
    },
  });
  assert(
    refreshed?.external_order_status === "DEPARTURE" &&
      refreshed.receiver_address_1 === "address 1" &&
      refreshed.receiver_address_2 === "address 2",
    "Address refresh overwrote workflow state or missed address fields."
  );
  assert(
    (await prisma.coupang_raw_change_event.count({
      where: {
        external_order_id: target.orderId,
        external_shipment_id: target.shipmentId,
        event_type: "SHIPMENT_ADDRESS_CHANGED",
      },
    })) === 1,
    "A departure-stage address refresh did not create a change event."
  );
}

async function assertInvoiceUpdateRequiresExpectedNumber(verificationApi) {
  const orderId = "935770000000000005";
  const shipmentId = "884440000000000006";
  const expectedInvoiceNumber = "88100000999";
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "COUPANG_INVOICE_UPDATE",
      request_status: "VERIFYING",
      idempotency_key: "TEST:TARGETED:INVOICE-UPDATE",
      request_digest: "test-fixture",
      method: "POST",
      endpoint_path: "/orders/updateInvoices",
      expected_before_status: "DEPARTURE",
      requested_after_status: "DEPARTURE",
      source_menu_key: "integration-test",
      source_entity_type: "CARRIER_INVOICE_REPLACEMENT_WORK",
      source_entity_id: "1",
      requested_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.sales_channel_write_request_targets.create({
    data: {
      sales_channel_write_request_id:
        request.sales_channel_write_request_id,
      target_type: "SHIPMENT_BOX",
      target_external_id: shipmentId,
      external_order_id: orderId,
      external_shipment_id: shipmentId,
      invoice_number_snapshot: expectedInvoiceNumber,
      expected_before_status: "DEPARTURE",
      requested_after_status: "DEPARTURE",
      created_at: timestamp,
    },
  });
  let observedInvoiceNumber = "88100000000";
  const reader = async () =>
    apiResponse({
      code: "SUCCESS",
      message: "OK",
      data: [
        orderPayload(
          orderId,
          shipmentId,
          "DEPARTURE",
          observedInvoiceNumber
        ),
      ],
    });

  const mismatch =
    await verificationApi.verifyAndRefreshCoupangWriteRequest(
      {
        requestId: request.sales_channel_write_request_id,
        triggerType: "IMMEDIATE_VERIFY",
      },
      { getOrdersheetByOrderId: reader }
    );
  assert(
    mismatch.outcome === "UNKNOWN",
    "Invoice update verification accepted the old invoice number."
  );

  observedInvoiceNumber = expectedInvoiceNumber;
  const confirmed =
    await verificationApi.verifyAndRefreshCoupangWriteRequest(
      {
        requestId: request.sales_channel_write_request_id,
        triggerType: "MANUAL_RECHECK",
      },
      { getOrdersheetByOrderId: reader }
    );
  assert(
    confirmed.outcome === "CONFIRMED",
    "Invoice update verification did not confirm the expected invoice number."
  );
}

async function assertCompletedReturnIsReadWithoutStatusFilter(verificationApi) {
  const externalOrderId = "935770000000000004";
  const receiptId = "991230000000000004";
  const shipmentId = "884440000000000005";
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "RETURN_STOPPED_SHIPMENT",
      request_status: "VERIFYING",
      external_order_id: externalOrderId,
      target_type: "COUPANG_RETURN_RECEIPT",
      target_external_id: receiptId,
      idempotency_key: "TEST:TARGETED:RETURN:CONFIRMED",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/returnRequests/stoppedShipment",
      expected_before_status: "N",
      requested_after_status: "S",
      source_menu_key: "integration-test",
      source_entity_type: "COUPANG_RETURN_RECEIPT",
      source_entity_id: receiptId,
      requested_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const persistedTargets = await createReturnWriteTargets({
    requestId: request.sales_channel_write_request_id,
    externalOrderId,
    shipmentId,
  });
  let observedInput = null;
  let pageCalls = 0;
  const credentialContext = { id: "return-verification-context" };
  const observedContexts = [];
  let credentialContextOpenCount = 0;
  const result = await verificationApi.verifyAndRefreshCoupangWriteRequest(
    {
      requestId: request.sales_channel_write_request_id,
      triggerType: "IMMEDIATE_VERIFY",
    },
    {
      openCredentialContext: () => {
        credentialContextOpenCount += 1;
        return credentialContext;
      },
      getReturnRequests: async (input, context) => {
        observedInput = input;
        observedContexts.push(context);
        pageCalls += 1;

        if (pageCalls === 1) {
          return apiResponse({
            code: "SUCCESS",
            message: "OK",
            nextToken: "RETURN-PAGE-2",
            data: [],
          });
        }

        return apiResponse({
          code: "SUCCESS",
          message: "OK",
          nextToken: null,
          data: [
            {
              receiptId,
              orderId: externalOrderId,
              receiptType: "RETURN",
              receiptStatus: "RETURNS_COMPLETED",
              releaseStopStatus: "S",
              cancelCountSum: 1,
              returnItems: [
                {
                  shipmentBoxId: shipmentId,
                  vendorItemId: "1000000001",
                  cancelCount: 1,
                  releaseStatus: "S",
                },
              ],
            },
          ],
        });
      },
    }
  );

  assert(result.outcome === "CONFIRMED", "Stopped return was not confirmed.");
  assert(
    JSON.stringify(
      result.targetGroups.map((group) => ({
        groupKey: group.groupKey,
        targetIds: group.targetIds,
      }))
    ) ===
      JSON.stringify([
        {
          groupKey: `RETURN:${receiptId}`,
          targetIds: persistedTargets.map(
            (target) => target.sales_channel_write_request_target_id
          ),
        },
      ]),
    "Return verification did not preserve the complete receipt target group."
  );
  assert(pageCalls === 2, "Return verification did not follow pagination.");
  assert(
    credentialContextOpenCount === 1,
    "Return verification reopened the credential context for another page."
  );
  assert(
    observedContexts.every((context) => context === credentialContext),
    "Return verification did not reuse one credential context across pages."
  );
  assert(observedInput?.orderId === externalOrderId, "Return read was not order-scoped.");
  assert(observedInput?.status === undefined, "Return read retained a RU status filter.");
  assert(
    (await prisma.coupang_return_raw.findUnique({
      where: { external_receipt_id: receiptId },
    }))?.return_release_status === "S",
    "Targeted return snapshot was not persisted."
  );
}

async function assertCompletedReceiptWithoutStoppedReleaseStaysUnknown(
  verificationApi
) {
  const externalOrderId = "935770000000000005";
  const receiptId = "991230000000000005";
  const shipmentId = "884440000000000006";
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "RETURN_STOPPED_SHIPMENT",
      request_status: "VERIFYING",
      external_order_id: externalOrderId,
      target_type: "COUPANG_RETURN_RECEIPT",
      target_external_id: receiptId,
      idempotency_key: "TEST:TARGETED:RETURN:RELEASE-NOT-CONFIRMED",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/returnRequests/stoppedShipment",
      expected_before_status: "N",
      requested_after_status: "S",
      source_menu_key: "integration-test",
      source_entity_type: "COUPANG_RETURN_RECEIPT",
      source_entity_id: receiptId,
      requested_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const persistedTargets = await createReturnWriteTargets({
    requestId: request.sales_channel_write_request_id,
    externalOrderId,
    shipmentId,
  });

  const result = await verificationApi.verifyAndRefreshCoupangWriteRequest(
    {
      requestId: request.sales_channel_write_request_id,
      triggerType: "IMMEDIATE_VERIFY",
    },
    {
      getReturnRequests: async () =>
        apiResponse({
          code: "SUCCESS",
          message: "OK",
          nextToken: null,
          data: [
            {
              receiptId,
              orderId: externalOrderId,
              receiptType: "RETURN",
              receiptStatus: "RETURNS_COMPLETED",
              releaseStopStatus: "N",
              cancelCountSum: 1,
              returnItems: [
                {
                  shipmentBoxId: shipmentId,
                  vendorItemId: "1000000002",
                  cancelCount: 1,
                  releaseStatus: "N",
                },
              ],
            },
          ],
        }),
    }
  );

  assert(
    result.outcome === "UNKNOWN",
    "A completed receipt without release stop S was incorrectly confirmed."
  );
  assert(
    JSON.stringify(result.targetGroups[0]?.targetIds) ===
      JSON.stringify(
        persistedTargets.map(
          (target) => target.sales_channel_write_request_target_id
        )
      ),
    "Unknown return verification did not retain the complete receipt target group."
  );
  assert(
    result.message.includes("접수 RETURNS_COMPLETED / 출고중지 N"),
    "The return mismatch message omitted the observed statuses."
  );
  assert(
    (await prisma.coupang_return_raw.findUnique({
      where: { external_receipt_id: receiptId },
    }))?.return_release_status === "N",
    "An unconfirmed return snapshot was not refreshed."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const verificationApi = await import(
    "@/quickhack_server/sales-channel/coupang/write-verification-service"
  );

  await assertOrderIdsAreDeduplicated(verificationApi);
  await assertPartialOrderVerificationStaysUnknown(verificationApi);
  await assertMixedOrderGroupsStayIndependentlyRecoverable(verificationApi);
  await assertPostInstructAddressRefreshDoesNotJudgeOrderStatus(
    verificationApi
  );
  await assertInvoiceUpdateRequiresExpectedNumber(verificationApi);
  await assertCompletedReturnIsReadWithoutStatusFilter(verificationApi);
  await assertCompletedReceiptWithoutStoppedReleaseStaysUnknown(verificationApi);

  console.log(
    "Coupang targeted order and return write verification passed."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
