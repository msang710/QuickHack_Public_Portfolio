import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-coupang-claim-history-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function apiResponse(requestPath, payload, sequence) {
  const responsePayload = {
    code: "200",
    ...payload,
  };
  return {
    mode: "mock",
    source: `mock:${requestPath.split("?")[0]}`,
    requestPath,
    httpStatusCode: 200,
    responseHash: `claim-history-response-${sequence}`,
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "claim-history-test",
      keyFingerprint: "CLAIM-HISTORY",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload: responsePayload,
    rawPayloadText: JSON.stringify(responsePayload),
  };
}

function credentialContext() {
  return {
    context: {
      providerType: "USB_QHKEY",
      channel: "COUPANG",
      status: "ACTIVE",
      keyAlias: "claim-history-test",
      keyFingerprint: "CLAIM-HISTORY",
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
      throw new Error("Injected claim readers must not call the fake signer.");
    },
  };
}

function returnPayload(overrides = {}) {
  return {
    receiptId: "991230000000000111",
    orderId: "935770000000001111",
    receiptType: "RETURN",
    receiptStatus: "RETURNS_UNCHECKED",
    releaseStopStatus: "N",
    reasonCode: "CHANGE_MIND",
    reasonCodeText: "단순 변심",
    cancelReasonCategory1: "고객변심",
    cancelReason: "연락처 010-0000-0000 확인",
    cancelCountSum: 1,
    faultByType: "CUSTOMER",
    createdAt: "2026-07-01T10:00:00+09:00",
    modifiedAt: "2026-07-01T10:00:00+09:00",
    completeConfirmDate: "",
    completeConfirmType: "UNDEFINED",
    returnItems: [
      {
        shipmentBoxId: "884440000000001111",
        vendorItemId: "3187044096",
        sellerProductItemId: "57623797",
        vendorItemName: "테스트 상품",
        cancelCount: 1,
        releaseStatus: "N",
      },
    ],
    ...overrides,
  };
}

function exchangePayload(overrides = {}) {
  return {
    exchangeId: "881230000000000111",
    orderId: "935770000000002222",
    originalShipmentBoxId: "884440000000002222",
    exchangeStatus: "RECEIPT",
    faultType: "CUSTOMER",
    reasonCode: "EXCHANGE_REQUEST",
    reasonCodeText: "교환 요청",
    reasonEtcDetail: "색상 교환",
    createdAt: "2026-07-02T11:00:00+09:00",
    modifiedAt: "2026-07-02T11:00:00+09:00",
    exchangeItemDtoV1s: [
      {
        originalShipmentBoxId: "884440000000002222",
      },
    ],
    ...overrides,
  };
}

function withdrawalPayload(receiptId, orderId, createdAt, duty = "CUS") {
  return {
    cancelId: receiptId,
    orderId,
    refundDeliveryDuty: duty,
    createdAt,
    vendorItemIds: ["3187044096", "3187044096", "3187044097"],
  };
}

function createDependencies(input = {}) {
  const context = credentialContext();
  let credentialOpenCount = 0;
  let sequence = 0;
  let withdrawalCallCount = 0;

  return {
    dependencies: {
      openCredentialContext() {
        credentialOpenCount += 1;
        return context;
      },
      async getReturnRequests(request) {
        sequence += 1;
        return apiResponse(
          `/returnRequests?status=${request.status}`,
          { data: [], nextToken: "" },
          sequence
        );
      },
      async getExchangeRequests() {
        sequence += 1;
        return apiResponse(
          "/exchangeRequests",
          {
            data: input.exchange ? [input.exchange] : [],
            nextToken: "",
          },
          sequence
        );
      },
      async getReturnWithdrawals(request) {
        sequence += 1;
        withdrawalCallCount += 1;

        if (input.repeatPageIndex) {
          return apiResponse(
            `/returnWithdrawRequests?pageIndex=${request.pageIndex}`,
            { data: [], nextPageIndex: "1" },
            sequence
          );
        }

        if (withdrawalCallCount === 1) {
          return apiResponse(
            `/returnWithdrawRequests?pageIndex=${request.pageIndex}`,
            {
              data: [
                withdrawalPayload(
                  input.withdrawalReceiptId ?? "991230000000000111",
                  input.withdrawalOrderId ?? "935770000000001111",
                  "2026-07-03T09:00:00"
                ),
              ],
              nextPageIndex: "2",
            },
            sequence
          );
        }

        if (withdrawalCallCount === 2 && input.failWithdrawalPage2) {
          throw new Error("Injected withdrawal page 2 failure");
        }

        if (withdrawalCallCount === 2) {
          return apiResponse(
            `/returnWithdrawRequests?pageIndex=${request.pageIndex}`,
            {
              data: [
                withdrawalPayload(
                  "991230000000009999",
                  "935770000000009999",
                  "2026-07-03T09:30:00",
                  "COM"
                ),
              ],
              nextPageIndex: "",
            },
            sequence
          );
        }

        return apiResponse(
          `/returnWithdrawRequests?pageIndex=${request.pageIndex}`,
          { data: [], nextPageIndex: "" },
          sequence
        );
      },
    },
    credentialOpenCount() {
      return credentialOpenCount;
    },
  };
}

async function expectRejected(promise, pattern, label) {
  let caught = null;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  assert(caught, `${label} did not reject.`);
  assert(
    pattern.test(caught instanceof Error ? caught.message : String(caught)),
    `${label} rejected for an unexpected reason: ${
      caught instanceof Error ? caught.message : String(caught)
    }`
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    normalizeReturnRequest,
    persistCoupangReturnRawSnapshots,
    splitCoupangDateRange,
    syncCoupangAfterShipmentClaims,
  } = await import("@/quickhack_server/sales-channel/coupang/sync-service");
  const { reserveSalesChannelProjectionObservation } = await import(
    "@/quickhack_server/sales-channel/projection-revision-service"
  );

  const ranges = splitCoupangDateRange("2026-06-28", "2026-07-27");
  assert(ranges[0].dateFrom === "2026-06-28", "Date split lost its start.");
  assert(
    ranges.at(-1).dateTo === "2026-07-27",
    "Date split lost its end."
  );
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const days =
      (Date.parse(`${range.dateTo}T00:00:00Z`) -
        Date.parse(`${range.dateFrom}T00:00:00Z`)) /
        86_400_000 +
      1;
    assert(days <= 7, "A withdrawal interval exceeded seven calendar days.");

    if (index > 0) {
      const previous = ranges[index - 1];
      assert(
        Date.parse(`${range.dateFrom}T00:00:00Z`) -
          Date.parse(`${previous.dateTo}T00:00:00Z`) ===
          86_400_000,
        "Withdrawal intervals overlap or have a gap."
      );
    }
  }

  const firstReturn = normalizeReturnRequest(returnPayload());
  const firstPersist = await persistCoupangReturnRawSnapshots(
    [firstReturn],
    await reserveSalesChannelProjectionObservation(),
    "2026-07-27 10:00:00"
  );
  assert(firstPersist.eventCreatedCount === 1, "First return was not observed.");
  assert(firstPersist.noOpCount === 0, "First return was treated as a no-op.");

  const observed = await prisma.coupang_raw_change_event.findFirst({
    where: {
      external_receipt_id: firstReturn.externalReceiptId,
      event_type: "COUPANG_RETURN_OBSERVED",
    },
    include: { fields: true },
  });
  assert(observed?.process_status === "DONE", "Observed event is not DONE.");
  assert(observed?.api_call_log_id === null, "Targeted event has an API log.");
  assert(observed?.fields.length === 13, "Return snapshot is not complete.");
  assert(
    observed?.fields.find((field) => field.field_name === "reason_detail")
      ?.after_value === "연락처 [PHONE] 확인",
    "Return history did not mask a phone number."
  );

  const secondPersist = await persistCoupangReturnRawSnapshots(
    [firstReturn],
    await reserveSalesChannelProjectionObservation(),
    "2026-07-27 10:01:00"
  );
  assert(secondPersist.eventCreatedCount === 0, "Identical return made an event.");
  assert(secondPersist.noOpCount === 1, "Identical return was not a no-op.");

  const cancelReturn = normalizeReturnRequest(
    returnPayload({
      receiptId: "991230000000000121",
      orderId: "935770000000001121",
      receiptType: "CANCEL",
      returnItems: [
        {
          shipmentBoxId: "884440000000001121",
          vendorItemId: "3187044121",
          sellerProductItemId: "57623121",
          vendorItemName: "Cancel fixture",
          cancelCount: 1,
          releaseStatus: "N",
        },
      ],
    })
  );
  await persistCoupangReturnRawSnapshots(
    [cancelReturn],
    await reserveSalesChannelProjectionObservation(),
    "2026-07-27 10:01:30"
  );
  const cancelReceiptType = await prisma.coupang_raw_change_event_field.findFirst({
    where: {
      field_name: "receipt_type",
      after_value: "CANCEL",
      raw_change_event: {
        external_receipt_id: cancelReturn.externalReceiptId,
      },
    },
  });
  assert(cancelReceiptType, "CANCEL receipt type was not preserved separately.");

  const changedReturn = normalizeReturnRequest(
    returnPayload({
      receiptStatus: "RETURNS_COMPLETED",
      modifiedAt: "2026-07-04T12:00:00+09:00",
      completeConfirmDate: "2026-07-04T12:00:00+09:00",
      completeConfirmType: "VENDOR_CONFIRM",
      faultByType: "VENDOR",
    })
  );
  const changedPersist = await persistCoupangReturnRawSnapshots(
    [changedReturn],
    await reserveSalesChannelProjectionObservation(),
    "2026-07-27 10:02:00"
  );
  assert(changedPersist.eventCreatedCount === 1, "Changed return made no event.");

  const changedEvent = await prisma.coupang_raw_change_event.findFirst({
    where: {
      external_receipt_id: firstReturn.externalReceiptId,
      event_type: "COUPANG_RETURN_CHANGED",
    },
    include: { fields: true },
  });
  const statusChange = changedEvent?.fields.find(
    (field) => field.field_name === "receipt_status"
  );
  assert(
    statusChange?.before_value === "RETURNS_UNCHECKED" &&
      statusChange.after_value === "RETURNS_COMPLETED",
    "Return change did not preserve before and after status."
  );
  assert(changedEvent?.fields.length === 13, "Changed return is not full snapshot.");

  const invalidReturn = normalizeReturnRequest(
    returnPayload({
      receiptId: "991230000000000222",
      orderId: "935770000000001222",
      shipmentBoxId: "884440000000001222",
      createdAt: "not-a-date",
    })
  );
  assert(
    invalidReturn.externalCreatedAt === null &&
      invalidReturn.invalidTimestampCount === 1,
    "Invalid external timestamp was not counted."
  );
  const invalidPersist = await persistCoupangReturnRawSnapshots(
    [invalidReturn],
    await reserveSalesChannelProjectionObservation(),
    "2026-07-27 10:03:00"
  );
  assert(
    invalidPersist.invalidTimestampCount === 1,
    "Invalid timestamp coverage was not propagated."
  );
  const invalidCreatedAt = await prisma.coupang_raw_change_event_field.findFirst({
    where: {
      field_name: "external_created_at",
      raw_change_event: {
        external_receipt_id: invalidReturn.externalReceiptId,
      },
    },
  });
  assert(
    invalidCreatedAt?.after_value === null,
    "Invalid timestamp was not stored as null."
  );

  const pendingWithdrawalWrite = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "RETURN_STOPPED_SHIPMENT",
      request_status: "PENDING",
      target_type: "COUPANG_RETURN_RECEIPT",
      target_external_id: firstReturn.externalReceiptId,
      idempotency_key: "CLAIM-HISTORY-WITHDRAWAL-PENDING",
      request_digest: "claim-history-pending",
      method: "PUT",
      endpoint_path: `/returnRequests/${firstReturn.externalReceiptId}/stopped-shipment`,
      source_entity_type: "COUPANG_RETURN_RECEIPT",
      source_entity_id: firstReturn.externalReceiptId,
      targets: {
        create: {
          target_position: 0,
          target_type: "COUPANG_RETURN_RECEIPT",
          target_external_id: firstReturn.externalReceiptId,
        },
      },
      attempts: {
        create: {
          attempt_no: 1,
          attempt_type: "WRITE",
          attempt_status: "SENDING",
          trigger_type: "INITIAL",
          method: "PUT",
          endpoint_path: `/returnRequests/${firstReturn.externalReceiptId}/stopped-shipment`,
          request_dispatched: 0,
        },
      },
    },
  });
  const completedRaceReceiptId = "991230000000009999";
  const completedWithdrawalWrite =
    await prisma.sales_channel_write_requests.create({
      data: {
        channel: "COUPANG",
        request_type: "RETURN_APPROVAL",
        request_status: "COMPLETED",
        target_type: "COUPANG_RETURN_RECEIPT",
        target_external_id: completedRaceReceiptId,
        idempotency_key: "CLAIM-HISTORY-WITHDRAWAL-COMPLETED",
        request_digest: "claim-history-completed",
        method: "PUT",
        endpoint_path: `/returnRequests/${completedRaceReceiptId}/approval`,
        source_entity_type: "COUPANG_RETURN_RECEIPT",
        source_entity_id: completedRaceReceiptId,
        completed_at: new Date("2026-07-03T00:00:00.000Z"),
      },
    });

  const firstRun = createDependencies({ exchange: exchangePayload() });
  const firstSummary = await syncCoupangAfterShipmentClaims(
    { reason: "claim-history-test" },
    firstRun.dependencies
  );
  assert(firstRun.credentialOpenCount() === 1, "Claim context was reopened.");
  assert(
    firstSummary.exchanges.eventCreatedCount === 1,
    "Exchange observation was not recorded."
  );
  assert(
    firstSummary.withdrawals.withdrawals === 2 &&
      firstSummary.withdrawals.eventCreatedCount === 2,
    "Withdrawal pages were not recorded."
  );
  assert(
    firstSummary.withdrawals.unmatchedWithdrawalCount === 1,
    "Unmatched withdrawal count is incorrect."
  );
  const [canceledBeforeDispatch, completedWithdrawalRace] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          pendingWithdrawalWrite.sales_channel_write_request_id,
      },
      include: { targets: true, attempts: true },
    }),
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          completedWithdrawalWrite.sales_channel_write_request_id,
      },
    }),
  ]);
  assert(
    canceledBeforeDispatch.request_status === "REJECTED" &&
      canceledBeforeDispatch.error_code === "RETURN_WITHDRAWN" &&
      canceledBeforeDispatch.targets.every(
        (target) =>
          target.external_result_status === "NOT_APPLIED" &&
          target.local_finalization_status === "NOT_REQUIRED"
      ) &&
      canceledBeforeDispatch.attempts[0]?.attempt_status === "FAILED",
    "A terminal withdrawal did not atomically cancel an undispatched write."
  );
  assert(
    completedWithdrawalRace.request_status === "REVIEW_REQUIRED" &&
      completedWithdrawalRace.error_code === "RETURN_WITHDRAWAL_RACE",
    "A withdrawal observed after completed external work was auto-corrected instead of reviewed."
  );

  const exchangeObserved = await prisma.coupang_raw_change_event.findFirst({
    where: {
      external_exchange_id: "881230000000000111",
      event_type: "COUPANG_EXCHANGE_OBSERVED",
    },
    include: { fields: true },
  });
  assert(
    exchangeObserved?.fields.length === 7,
    "Exchange snapshot is not complete."
  );
  assert(
    exchangeObserved?.api_call_log_id !== null,
    "Worker observation has no API call log."
  );

  const secondRun = createDependencies({ exchange: exchangePayload() });
  const secondSummary = await syncCoupangAfterShipmentClaims(
    { reason: "claim-history-retry-test" },
    secondRun.dependencies
  );
  assert(
    secondSummary.exchanges.eventCreatedCount === 0 &&
      secondSummary.withdrawals.eventCreatedCount === 0,
    "Retry created duplicate claim events."
  );

  const changedExchangeRun = createDependencies({
    exchange: exchangePayload({
      exchangeStatus: "SUCCESS",
      faultType: "VENDOR",
      modifiedAt: "2026-07-05T14:00:00+09:00",
    }),
  });
  const changedExchangeSummary = await syncCoupangAfterShipmentClaims(
    { reason: "claim-history-exchange-change-test" },
    changedExchangeRun.dependencies
  );
  assert(
    changedExchangeSummary.exchanges.eventCreatedCount === 1,
    "Changed exchange made no event."
  );
  const exchangeChanged = await prisma.coupang_raw_change_event.findFirst({
    where: {
      external_exchange_id: "881230000000000111",
      event_type: "COUPANG_EXCHANGE_CHANGED",
    },
    include: { fields: true },
  });
  assert(
    exchangeChanged?.fields.length === 7,
    "Changed exchange is not a full snapshot."
  );
  const exchangeStatusChange = exchangeChanged?.fields.find(
    (field) => field.field_name === "exchange_status"
  );
  assert(
    exchangeStatusChange?.before_value === "RECEIPT" &&
      exchangeStatusChange.after_value === "SUCCESS",
    "Exchange change did not preserve before and after status."
  );

  const failedReceiptId = "991230000000008888";
  const failedWithdrawalPage = createDependencies({
    withdrawalReceiptId: failedReceiptId,
    withdrawalOrderId: "935770000000008888",
    failWithdrawalPage2: true,
  });
  await expectRejected(
    syncCoupangAfterShipmentClaims(
      { reason: "claim-history-page-failure-test" },
      failedWithdrawalPage.dependencies
    ),
    /Injected withdrawal page 2 failure/,
    "Withdrawal page 2 failure"
  );
  const committedFirstPageEvent =
    await prisma.coupang_raw_change_event.findFirst({
      where: {
        event_type: "COUPANG_RETURN_WITHDRAWN",
        external_receipt_id: failedReceiptId,
      },
    });
  assert(
    committedFirstPageEvent,
    "A later withdrawal page failure rolled back a completed page."
  );
  const failedSecondPageLog = await prisma.coupang_api_call_log.findFirst({
    where: {
      api_name: "returnWithdrawRequests.afterShipment",
      processed_status: "FAILED",
      error_message: {
        contains: "Injected withdrawal page 2 failure",
      },
    },
    orderBy: { coupang_api_call_log_id: "desc" },
  });
  assert(
    failedSecondPageLog,
    "Withdrawal page 2 failure did not leave a FAILED API log."
  );

  const repeatedPage = createDependencies({ repeatPageIndex: true });
  await expectRejected(
    syncCoupangAfterShipmentClaims(
      { reason: "claim-history-repeat-page-test" },
      repeatedPage.dependencies
    ),
    /nextPageIndex repeated or moved backwards/,
    "Repeated withdrawal page"
  );
  const failedWithdrawalLog = await prisma.coupang_api_call_log.findFirst({
    where: {
      api_name: "returnWithdrawRequests.afterShipment",
      processed_status: "FAILED",
    },
    orderBy: { coupang_api_call_log_id: "desc" },
  });
  assert(failedWithdrawalLog, "Repeated page did not fail its API call log.");

  const withdrawalEvents = await prisma.coupang_raw_change_event.findMany({
    where: { event_type: "COUPANG_RETURN_WITHDRAWN" },
  });
  assert(withdrawalEvents.length === 3, "Withdrawal events were duplicated.");

  const queryDatabase = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);
  try {
    const indexes = new Set(
      (
        await queryDatabase
          .prepare(`SELECT indexname AS name
                    FROM pg_catalog.pg_indexes
                    WHERE schemaname = current_schema()
                      AND tablename IN (
                        'coupang_raw_change_event',
                        'coupang_raw_change_event_field'
                      )`)
          .all()
      ).map((row) => String(row.name))
    );

    for (const indexName of [
      "idx_coupang_raw_change_event_receipt_id",
      "idx_coupang_raw_change_event_exchange_id",
      "idx_coupang_raw_change_event_type_detected",
      "idx_coupang_raw_change_event_field_name_after",
    ]) {
      assert(
        indexes.has(indexName),
        `PostgreSQL baseline is missing ${indexName}.`
      );
    }
  } finally {
    await queryDatabase.close();
  }

  console.log("Coupang claim history and withdrawal sync verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
