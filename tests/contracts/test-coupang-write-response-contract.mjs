import assert from "node:assert/strict";

const {
  assessCoupangWriteResponse,
  COUPANG_WRITE_RESPONSE_ERROR_CODE,
  COUPANG_WRITE_RESPONSE_OUTCOME,
  CoupangWriteResponseContractError,
} = await import(
  "@/quickhack_server/sales-channel/coupang/write-response-contract"
);

function baseCommand(requestType, id) {
  return {
    channel: "COUPANG",
    requestType,
    idempotencyKey: `TEST:COUPANG:WRITE-RESPONSE:${id}`,
    sourceMenuKey: "contract-test",
    sourceEntityType: "CONTRACT_TEST",
    sourceEntityId: id,
    targets: [],
  };
}

function orderCommand(...shipmentBoxIds) {
  return {
    ...baseCommand("ORDER_STATUS_INSTRUCT", shipmentBoxIds.join("-")),
    shipmentBoxIds,
  };
}

function invoiceCommand(...shipmentBoxIds) {
  return {
    ...baseCommand("COUPANG_INVOICE_UPLOAD", shipmentBoxIds.join("-")),
    invoiceItems: shipmentBoxIds.map((shipmentBoxId, index) => ({
      shipmentBoxId,
      orderId: `ORDER-${index}`,
      vendorItemId: `VENDOR-${index}`,
      deliveryCompanyCode: "KGB",
      invoiceNumber: `1234567890${index}`,
      splitShipping: false,
      preSplitShipped: false,
      estimatedShippingDate: "",
    })),
  };
}

function returnCommand() {
  return {
    ...baseCommand("RETURN_RECEIVE_CONFIRMATION", "RETURN-1"),
    receiptId: "RETURN-1",
  };
}

function inventoryCommand() {
  return {
    ...baseCommand("COUPANG_INVENTORY_QUANTITY_UPDATE", "VENDOR-1"),
    verificationStateId: 1,
    vendorItemId: "VENDOR-1",
    desiredVersion: 1,
    mismatchSince: "2026-08-08 00:00:00",
    projectionBasisHash: "test-hash",
    ledgerQuantity: 3,
    pendingOrderQuantity: 0,
    expectedChannelQuantity: 3,
    observedChannelQuantity: 2,
  };
}

function result(shipmentBoxId, succeed, resultCode) {
  return {
    shipmentBoxId,
    succeed,
    resultCode,
    retryRequired: !succeed,
    resultMessage: succeed ? "request succeeded" : "request failed",
  };
}

function batchPayload(responseCode, responseList) {
  return {
    code: "200",
    message: "OK",
    data: {
      responseCode,
      responseMessage:
        responseCode === 0
          ? "SUCCESS"
          : responseCode === 1
            ? "PARTIAL_ERROR"
            : "FAILED",
      responseList,
    },
  };
}

{
  const assessment = assessCoupangWriteResponse(
    orderCommand("SHIP-1", "SHIP-2"),
    batchPayload(0, [result("SHIP-1", true, "OK"), result("SHIP-2", true, "OK")])
  );

  assert.equal(assessment.outcome, COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess);
  assert.equal(assessment.externalResponseCode, "0");
  assert.equal(assessment.succeededTargetCount, 2);
  assert.equal(assessment.failedTargetCount, 0);
}

{
  const assessment = assessCoupangWriteResponse(
    orderCommand("SHIP-1", "SHIP-2"),
    batchPayload(1, [
      result("SHIP-1", true, "OK"),
      result("SHIP-2", false, "INVALID_ORDER_STATUS"),
    ])
  );

  assert.equal(assessment.outcome, COUPANG_WRITE_RESPONSE_OUTCOME.partial);
  assert.equal(
    assessment.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.partialSuccess
  );
  assert.deepEqual(assessment.failedTargets, [
    {
      externalTargetId: "SHIP-2",
      resultCode: "INVALID_ORDER_STATUS",
      retryRequired: true,
    },
  ]);
}

{
  const assessment = assessCoupangWriteResponse(
    orderCommand("SHIP-1", "SHIP-2"),
    batchPayload(99, [
      result("SHIP-1", false, "INVALID_ORDER_STATUS"),
      result("SHIP-2", false, "NOT_FOUND_SHIPMENT_BOX"),
    ])
  );

  assert.equal(
    assessment.outcome,
    COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure
  );
  assert.equal(assessment.failedTargetCount, 2);
}

{
  const assessment = assessCoupangWriteResponse(orderCommand("SHIP-1"), {
    code: "200",
    message: "OK",
    data: { responseCode: 0, responseMessage: "SUCCESS" },
  });

  assert.equal(
    assessment.outcome,
    COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse
  );
  assert.equal(
    assessment.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed
  );
}

{
  const assessment = assessCoupangWriteResponse(orderCommand("SHIP-1"), {
    code: "SUCCESS",
    message: "OK",
  });

  assert.equal(
    assessment.outcome,
    COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse
  );
  assert.equal(
    assessment.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.malformed
  );
}

{
  const assessment = assessCoupangWriteResponse(
    orderCommand("SHIP-1", "SHIP-2"),
    batchPayload(0, [result("SHIP-1", true, "OK")])
  );

  assert.equal(
    assessment.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.targetMismatch
  );
}

{
  const command = invoiceCommand("SHIP-DUPLICATE", "SHIP-DUPLICATE");
  const full = assessCoupangWriteResponse(
    command,
    batchPayload(0, [
      result("SHIP-DUPLICATE", true, "OK"),
      result("SHIP-DUPLICATE", true, "OK"),
    ])
  );
  const dropped = assessCoupangWriteResponse(
    command,
    batchPayload(0, [result("SHIP-DUPLICATE", true, "OK")])
  );

  assert.equal(full.outcome, COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess);
  assert.equal(
    dropped.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.targetMismatch
  );
}

{
  const summaryConflict = assessCoupangWriteResponse(
    orderCommand("SHIP-1", "SHIP-2"),
    batchPayload(0, [
      result("SHIP-1", true, "OK"),
      result("SHIP-2", false, "INVALID_ORDER_STATUS"),
    ])
  );
  const itemConflict = assessCoupangWriteResponse(
    orderCommand("SHIP-1"),
    batchPayload(0, [result("SHIP-1", true, "INVALID_ORDER_STATUS")])
  );

  assert.equal(
    summaryConflict.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.summaryConflict
  );
  assert.equal(
    itemConflict.errorCode,
    COUPANG_WRITE_RESPONSE_ERROR_CODE.summaryConflict
  );
}

{
  const accepted = assessCoupangWriteResponse(returnCommand(), {
    code: "200",
    message: "provider-localized-success-message",
  });
  const rejected = assessCoupangWriteResponse(returnCommand(), {
    code: "400",
    message: "INVALID_RETURN_ACTION",
  });

  assert.equal(accepted.outcome, COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess);
  assert.equal(
    rejected.outcome,
    COUPANG_WRITE_RESPONSE_OUTCOME.explicitFailure
  );
}

{
  const accepted = assessCoupangWriteResponse(inventoryCommand(), {
    code: "SUCCESS",
    message: "OK",
  });
  const wrongGenericSuccess = assessCoupangWriteResponse(inventoryCommand(), {
    code: "200",
    message: "OK",
  });

  assert.equal(accepted.outcome, COUPANG_WRITE_RESPONSE_OUTCOME.fullSuccess);
  assert.equal(
    wrongGenericSuccess.outcome,
    COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse
  );
}

{
  const bodyMarker = "QH_WRITE_RESPONSE_SECRET=do-not-retain";
  const partial = assessCoupangWriteResponse(
    orderCommand("SHIP-SAFE-1", "SHIP-SAFE-2"),
    {
      code: "200",
      message: bodyMarker,
      data: {
        responseCode: 1,
        responseMessage: bodyMarker,
        responseList: [
          result("SHIP-SAFE-1", true, "OK"),
          {
            ...result("SHIP-SAFE-2", false, "FAILED"),
            resultMessage: bodyMarker,
          },
        ],
      },
    }
  );
  const error = new CoupangWriteResponseContractError({
    assessment: partial,
    httpStatusCode: 200,
  });

  assert.equal(error.code, COUPANG_WRITE_RESPONSE_ERROR_CODE.partialSuccess);
  assert.equal(error.httpStatusCode, 200);
  assert.equal("externalResponseMessage" in partial, false);
  assert.equal("externalResponseMessage" in error, false);
  assert.equal("resultMessage" in partial.failedTargets[0], false);
  assert.equal(JSON.stringify(partial).includes(bodyMarker), false);
  assert.equal(JSON.stringify(error.assessment).includes(bodyMarker), false);
  assert.equal(String(error).includes(bodyMarker), false);
}

{
  const invalidCodeMarker = "QH_INVALID_CODE=do-not-retain";
  const assessment = assessCoupangWriteResponse(returnCommand(), {
    code: invalidCodeMarker,
    message: invalidCodeMarker,
  });

  assert.equal(
    assessment.outcome,
    COUPANG_WRITE_RESPONSE_OUTCOME.unknownResponse
  );
  assert.equal(assessment.externalResponseCode, null);
  assert.equal(JSON.stringify(assessment).includes(invalidCodeMarker), false);
}

console.log(
  "Coupang endpoint-specific write response contracts and safe failure classifications verified."
);
