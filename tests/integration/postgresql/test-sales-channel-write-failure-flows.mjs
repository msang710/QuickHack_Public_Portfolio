import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  SALES_CHANNEL_WRITE_FAILURE_SCENARIO,
  runSalesChannelWriteFailureScenarios,
} from "./sales-channel-write-failure-scenario-registry.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-write-failure-flows-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
const WRITE_RESPONSE_BODY_MARKER =
  "QH_WRITE_RESPONSE_SECRET=do-not-persist";

function successResponse(command) {
  let payload;

  if (
    command.requestType === "ORDER_STATUS_INSTRUCT" ||
    command.requestType === "COUPANG_INVOICE_UPLOAD" ||
    command.requestType === "COUPANG_INVOICE_UPDATE"
  ) {
    const shipmentBoxIds =
      command.requestType === "ORDER_STATUS_INSTRUCT"
        ? command.shipmentBoxIds
        : command.invoiceItems.map((item) => item.shipmentBoxId);
    payload = {
      code: "200",
      message: WRITE_RESPONSE_BODY_MARKER,
      data: {
        responseCode: 0,
        responseMessage: WRITE_RESPONSE_BODY_MARKER,
        responseList: shipmentBoxIds.map((shipmentBoxId) => ({
          shipmentBoxId,
          succeed: true,
          resultCode: "OK",
          retryRequired: false,
          resultMessage: WRITE_RESPONSE_BODY_MARKER,
        })),
      },
    };
  } else if (
    command.requestType === "COUPANG_INVENTORY_QUANTITY_UPDATE"
  ) {
    payload = { code: "SUCCESS", message: WRITE_RESPONSE_BODY_MARKER };
  } else {
    payload = { code: "200", message: WRITE_RESPONSE_BODY_MARKER };
  }

  return {
    mode: "mock",
    source: "integration-test",
    requestPath: "/integration-test",
    httpStatusCode: 200,
    responseHash: "integration-test-response",
    auth: {},
    payload,
  };
}

async function verificationResult(outcome, message = null, requestId) {
  const activeRequest = requestId
    ? await prisma.sales_channel_write_requests.findUnique({
        where: { sales_channel_write_request_id: requestId },
        select: {
          sales_channel_write_request_id: true,
          request_type: true,
          target_external_id: true,
        },
      })
    : await prisma.sales_channel_write_requests.findFirst({
        where: { request_status: "VERIFYING" },
        orderBy: { sales_channel_write_request_id: "desc" },
        select: {
          sales_channel_write_request_id: true,
          request_type: true,
          target_external_id: true,
        },
      });
  if (!activeRequest) {
    throw new Error("No active write request was available for verification.");
  }
  const targets = await prisma.sales_channel_write_request_targets.findMany({
    where: {
      sales_channel_write_request_id:
        activeRequest.sales_channel_write_request_id,
    },
    orderBy: { target_position: "asc" },
  });
  const grouped = new Map();
  for (const target of targets) {
    const groupKey = activeRequest.request_type.startsWith("RETURN_")
      ? `RETURN:${activeRequest.target_external_id}`
      : `SHIPMENT:${
          target.external_shipment_id ?? target.target_external_id
        }`;
    const group = grouped.get(groupKey) ?? [];
    group.push(target.sales_channel_write_request_target_id);
    grouped.set(groupKey, group);
  }
  return {
    outcome,
    code: outcome === "CONFIRMED" ? "TEST_CONFIRMED" : "TEST_UNKNOWN",
    message,
    endpointPath: "/integration-test/verification",
    targetCount: targets.length,
    confirmedCount: outcome === "CONFIRMED" ? targets.length : 0,
    targetGroups: [...grouped].map(([groupKey, targetIds]) => ({
      groupKey,
      targetIds,
      outcome,
      code: outcome === "CONFIRMED" ? "TEST_CONFIRMED" : "TEST_UNKNOWN",
    })),
    observedStatuses: [],
  };
}

function orderInstructCommand(input) {
  const expectedBeforeStatus = input.expectedBeforeStatus ?? "ACCEPT";
  const requestedAfterStatus = input.requestedAfterStatus ?? "INSTRUCT";

  return {
    channel: "COUPANG",
    requestType: "ORDER_STATUS_INSTRUCT",
    idempotencyKey: input.idempotencyKey,
    externalOrderId: input.externalOrderId ?? null,
    allocationId: input.requestAllocationId ?? null,
    pgNo: input.requestPgNo ?? null,
    targetType: input.requestTargetType ?? "SHIPMENT_BATCH",
    targetExternalId: input.requestTargetExternalId ?? input.shipmentId,
    packageGroupId: input.requestPackageGroupId ?? null,
    carrierShipmentId: input.requestCarrierShipmentId ?? null,
    expectedBeforeStatus,
    requestedAfterStatus,
    sourceMenuKey: input.sourceMenuKey ?? "integration-test",
    sourceEntityType:
      input.sourceEntityType ?? "COUPANG_SHIPMENT_BATCH",
    sourceEntityId: input.sourceEntityId ?? input.shipmentId,
    requestedByUserId: input.userId ?? null,
    workerJobId: input.workerJobId ?? null,
    shipmentBoxIds: [input.shipmentId],
    targets: [
      {
        targetType: input.targetType ?? "SHIPMENT_BOX",
        targetExternalId: input.targetExternalId ?? input.shipmentId,
        allocationId: input.allocationId ?? null,
        pgNo: input.pgNo ?? null,
        externalOrderId: input.externalOrderId ?? null,
        externalShipmentId: input.externalShipmentId ?? input.shipmentId,
        externalVendorItemId: input.externalVendorItemId ?? null,
        packageGroupId: input.packageGroupId ?? null,
        carrierShipmentId: input.carrierShipmentId ?? null,
        deliveryCompanyCode: input.deliveryCompanyCode ?? null,
        invoiceNumberSnapshot: input.invoiceNumberSnapshot ?? null,
        splitShipping: input.splitShipping ?? null,
        preSplitShipped: input.preSplitShipped ?? null,
        estimatedShippingDate: input.estimatedShippingDate ?? null,
        supplyConsumptionEventId: input.supplyConsumptionEventId ?? null,
        quantity: input.quantity ?? 1,
        expectedBeforeStatus,
        requestedAfterStatus,
        inspectionResult: input.inspectionResult ?? null,
        appearanceGrade: input.appearanceGrade ?? null,
        appearanceDefect: input.appearanceDefect ?? null,
        functionDefect: input.functionDefect ?? null,
        inspectionNote: input.inspectionNote ?? null,
      },
    ],
  };
}

async function withCommittedFinalizationAcknowledgementLoss(
  run,
  afterCommit = async () => undefined,
  committedStatuses = ["COMPLETED", "PARTIALLY_COMPLETED"]
) {
  const originalTransaction = prisma.$transaction;
  let injected = false;

  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    if (!injected && committedStatuses.includes(result)) {
      injected = true;
      await afterCommit(result);
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

async function withCommittedHandoffAcknowledgementLoss(run) {
  const originalTransaction = prisma.$transaction;
  let injected = false;

  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    if (
      !injected &&
      result &&
      typeof result === "object" &&
      Number.isInteger(result.finalizeAttemptId) &&
      Array.isArray(result.targetIds) &&
      result.targetIds.length > 0
    ) {
      injected = true;
      throw new Error("forced local-finalization handoff acknowledgement loss");
    }
    return result;
  };

  try {
    const result = await run();
    assert(injected, "The handoff acknowledgement loss was not injected.");
    return result;
  } finally {
    prisma.$transaction = originalTransaction;
  }
}

async function withCommittedZeroTargetSettlementAcknowledgementLoss(
  run,
  afterCommit = async () => undefined
) {
  const originalTransaction = prisma.$transaction;
  let injected = false;

  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    if (
      !injected &&
      result &&
      typeof result === "object" &&
      result.finalizeAttemptId === undefined &&
      Array.isArray(result.targetIds) &&
      result.targetIds.length === 0 &&
      ["NOT_APPLIED", "REVIEW_REQUIRED"].includes(result.requestStatus)
    ) {
      injected = true;
      await afterCommit(result);
      throw new Error("forced zero-target settlement acknowledgement loss");
    }
    return result;
  };

  try {
    return await run();
  } finally {
    prisma.$transaction = originalTransaction;
    assert(
      injected,
      "The zero-target settlement acknowledgement loss was not injected."
    );
  }
}

async function withCommittedReviewFinalizationAcknowledgementLoss(
  requestId,
  run
) {
  const originalTransaction = prisma.$transaction;
  let injected = false;

  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    if (!injected) {
      const committedAttempt =
        await prisma.sales_channel_write_request_attempts.findFirst({
          where: {
            sales_channel_write_request_id: requestId,
            attempt_type: "LOCAL_FINALIZE",
            attempt_status: "SUCCEEDED",
            trigger_type: "MANUAL_LOCAL_RETRY",
            completed_at: { not: null },
          },
        });
      if (committedAttempt) {
        injected = true;
        throw new Error("forced review finalization acknowledgement loss");
      }
    }
    return result;
  };

  try {
    const result = await run();
    assert(
      injected,
      "The review finalization acknowledgement loss was not injected."
    );
    return result;
  } finally {
    prisma.$transaction = originalTransaction;
  }
}

function assertOrderCommandSnapshot(request, command, context) {
  assert(
    request.channel === command.channel &&
      request.request_type === command.requestType &&
      request.external_order_id === (command.externalOrderId ?? null) &&
      request.allocation_id === (command.allocationId ?? null) &&
      request.pg_no === (command.pgNo ?? null) &&
      request.target_type === (command.targetType ?? null) &&
      request.target_external_id === (command.targetExternalId ?? null) &&
      request.package_group_id === (command.packageGroupId ?? null) &&
      request.carrier_shipment_id === (command.carrierShipmentId ?? null) &&
      request.cancel_count === (command.cancelCount ?? null) &&
      request.expected_before_status ===
        (command.expectedBeforeStatus ?? null) &&
      request.requested_after_status ===
        (command.requestedAfterStatus ?? null) &&
      request.source_menu_key === command.sourceMenuKey &&
      request.source_entity_type === command.sourceEntityType &&
      request.source_entity_id === command.sourceEntityId &&
      request.requested_by_user_id ===
        (command.requestedByUserId ?? null) &&
      request.worker_job_id === (command.workerJobId ?? null),
    `${context}: the request snapshot does not match the current command.`
  );
  assert(
    request.method === "PATCH" &&
      request.endpoint_path.endsWith("/ordersheets/acknowledgement"),
    `${context}: the request endpoint snapshot is incorrect.`
  );
  assert(
    request.targets.length === command.targets.length &&
      command.targets.length === 1,
    `${context}: the request target count is incorrect.`
  );

  const actual = request.targets[0];
  const expected = command.targets[0];

  assert(
    actual.target_type === expected.targetType &&
      actual.target_external_id === (expected.targetExternalId ?? null) &&
      actual.allocation_id === (expected.allocationId ?? null) &&
      actual.pg_no === (expected.pgNo ?? null) &&
      actual.external_order_id === (expected.externalOrderId ?? null) &&
      actual.external_shipment_id ===
        (expected.externalShipmentId ?? null) &&
      actual.external_vendor_item_id ===
        (expected.externalVendorItemId ?? null) &&
      actual.package_group_id === (expected.packageGroupId ?? null) &&
      actual.carrier_shipment_id ===
        (expected.carrierShipmentId ?? null) &&
      actual.delivery_company_code ===
        (expected.deliveryCompanyCode ?? null) &&
      actual.invoice_number_snapshot ===
        (expected.invoiceNumberSnapshot ?? null) &&
      actual.split_shipping ===
        (expected.splitShipping == null
          ? null
          : expected.splitShipping
            ? 1
            : 0) &&
      actual.pre_split_shipped ===
        (expected.preSplitShipped == null
          ? null
          : expected.preSplitShipped
            ? 1
            : 0) &&
      actual.estimated_shipping_date ===
        (expected.estimatedShippingDate ?? null) &&
      actual.supply_consumption_event_id ===
        (expected.supplyConsumptionEventId ?? null) &&
      actual.quantity === (expected.quantity ?? null) &&
      actual.expected_before_status ===
        (expected.expectedBeforeStatus ?? null) &&
      actual.requested_after_status ===
        (expected.requestedAfterStatus ?? null) &&
      actual.inspection_result === (expected.inspectionResult ?? null) &&
      actual.appearance_grade === (expected.appearanceGrade ?? null) &&
      actual.appearance_defect === (expected.appearanceDefect ?? null) &&
      actual.function_defect === (expected.functionDefect ?? null) &&
      actual.inspection_note === (expected.inspectionNote ?? null),
    `${context}: the target snapshot does not match the current command.`
  );
}

async function createNotAppliedOrderRequest(api, command) {
  const definitiveFailure = new Error("forced definitive order rejection");
  let executeCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;
  let caughtError;

  try {
    await api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        executeWrite: async () => {
          executeCalls += 1;
          throw definitiveFailure;
        },
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult("CONFIRMED");
        },
      }
    );
  } catch (error) {
    caughtError = error;
  }

  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });

  assert(caughtError === definitiveFailure, "The setup rejection was replaced.");
  assert(executeCalls === 1, "The setup rejection was not dispatched once.");
  assert(
    verificationCalls === 0,
    "A definitive order rejection was unexpectedly verified."
  );
  assert(
    finalizationCalls === 0,
    "A definitive order rejection was unexpectedly finalized."
  );
  assert(
    request.request_status === "NOT_APPLIED" &&
      request.attempts.length === 1 &&
      request.attempts[0].attempt_type === "WRITE" &&
      request.attempts[0].attempt_status === "FAILED",
    "The setup request did not reach NOT_APPLIED."
  );
  assertOrderCommandSnapshot(request, command, "NOT_APPLIED setup");

  return request;
}

function stoppedShipmentCommand(input) {
  return {
    channel: "COUPANG",
    requestType: "RETURN_STOPPED_SHIPMENT",
    idempotencyKey: input.idempotencyKey,
    externalOrderId: input.externalOrderId,
    targetType: "COUPANG_RETURN_RECEIPT",
    targetExternalId: input.receiptId,
    cancelCount: 1,
    expectedBeforeStatus: "N",
    requestedAfterStatus: "S",
    sourceMenuKey: "return-before-shipment",
    sourceEntityType: "COUPANG_RETURN_RECEIPT",
    sourceEntityId: input.receiptId,
    requestedByUserId: null,
    receiptId: input.receiptId,
    targets: [],
  };
}

function returnStateConflictError(coupangApi) {
  return new coupangApi.CoupangApiResponseError({
    httpStatusCode: 400,
    externalResponseCode: "INVALID_RETURN_ACTION",
    transient: false,
  });
}

async function assertReturnStateConflictIsVerified(
  api,
  coupangApi,
  outcome
) {
  const command = stoppedShipmentCommand({
    idempotencyKey: `TEST:WRITE:RETURN-STATE-CONFLICT:${outcome}`,
    receiptId: `RECEIPT-STATE-CONFLICT-${outcome}`,
    externalOrderId: `ORDER-STATE-CONFLICT-${outcome}`,
  });
  let adapterCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;
  let caughtError;

  try {
    await api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        executeWrite: async () => {
          adapterCalls += 1;
          throw returnStateConflictError(coupangApi);
        },
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult(
            outcome,
            outcome === "CONFIRMED"
              ? "Return release status S confirmed."
              : "Return release status could not be confirmed."
          );
        },
      }
    );
  } catch (error) {
    caughtError = error;
  }

  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });
  const writeAttempt = request.attempts[0];
  const verifyAttempt = request.attempts[1];

  assert(adapterCalls === 1, "The conflicting return write was resent.");
  assert(
    verificationCalls === 1,
    "The conflicting return write was not verified exactly once."
  );
  assert(
    writeAttempt.attempt_status === "AMBIGUOUS" &&
      writeAttempt.http_status_code === 400 &&
      writeAttempt.external_response_code === "INVALID_RETURN_ACTION" &&
      writeAttempt.external_response_message === null &&
      writeAttempt.request_dispatched === 1 &&
      writeAttempt.response_received === 1 &&
      writeAttempt.external_applied_unknown === 1,
    "The return state conflict evidence was not preserved."
  );
  assert(
    verifyAttempt.trigger_type === "IMMEDIATE_VERIFY_AFTER_STATE_CONFLICT",
    "The return state conflict verification trigger is incorrect."
  );

  if (outcome === "CONFIRMED") {
    assert(caughtError === undefined, "A confirmed return recovery still failed.");
    assert(
      request.request_status === "COMPLETED" &&
        request.attempts
          .map((attempt) => attempt.attempt_type)
          .join(",") === "WRITE,VERIFY_READ,LOCAL_FINALIZE",
      `A confirmed return state conflict did not complete: ${request.request_status}/${request.attempts.map((attempt) => attempt.attempt_type).join(",")}.`
    );
    assert(
      finalizationCalls === 1,
      "A confirmed return state conflict did not finalize exactly once."
    );
    return;
  }

  assert(
    caughtError instanceof api.SalesChannelWriteReviewRequiredError,
    "An unconfirmed return state conflict did not require review."
  );
  assert(
    request.request_status === "REVIEW_REQUIRED" &&
      request.failure_stage === "EXTERNAL_VERIFICATION",
    "An unconfirmed return state conflict did not remain visible for review."
  );
  assert(
    finalizationCalls === 0,
    "An unconfirmed return state conflict finalized local data."
  );
}

async function assertDefinitiveReturnRejectionStaysNotApplied(api, coupangApi) {
  const command = stoppedShipmentCommand({
    idempotencyKey: "TEST:WRITE:RETURN-DEFINITIVE-REJECTION",
    receiptId: "RECEIPT-DEFINITIVE-REJECTION",
    externalOrderId: "ORDER-DEFINITIVE-REJECTION",
  });
  const rejection = new coupangApi.CoupangApiResponseError({
    httpStatusCode: 400,
    externalResponseCode: "INVALID_CANCEL_COUNT",
    transient: false,
  });
  let verificationCalls = 0;
  let caughtError;

  try {
    await api.requestSalesChannelWrite(
      command,
      { finalize: async () => undefined },
      {
        executeWrite: async () => {
          throw rejection;
        },
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult("CONFIRMED");
        },
      }
    );
  } catch (error) {
    caughtError = error;
  }

  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: true },
  });

  assert(caughtError === rejection, "The definitive rejection was replaced.");
  assert(
    verificationCalls === 0,
    "A definitive return rejection triggered a state verification."
  );
  assert(
      request.request_status === "NOT_APPLIED" &&
      request.failure_stage === "WRITE_RESPONSE" &&
      request.error_code === "INVALID_CANCEL_COUNT" &&
      request.error_message === "Coupang API response error (400).",
    "A definitive return rejection was not recorded as NOT_APPLIED."
  );
  assert(
    request.attempts[0].external_response_code === "INVALID_CANCEL_COUNT" &&
      request.attempts[0].external_response_message === null,
    "The definitive rejection response fields were not preserved."
  );
}

async function assertCredentialContextIsShared(api) {
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:CREDENTIAL-CONTEXT",
    shipmentId: "SHIP-CREDENTIAL-CONTEXT-1",
    externalOrderId: "ORDER-CREDENTIAL-CONTEXT-1",
  });
  const credentialContext = { id: "write-and-refresh-context" };
  let openCount = 0;
  let writeContext = null;
  let verificationCalls = 0;

  await api.requestSalesChannelWrite(
    command,
    { finalize: async () => undefined },
    {
      openCredentialContext: () => {
        openCount += 1;
        return credentialContext;
      },
      executeWrite: async (_command, context) => {
        writeContext = context;
        return successResponse(_command);
      },
      verifyWrite: async () => {
        verificationCalls += 1;
        return verificationResult("CONFIRMED");
      },
    }
  );

  assert(openCount === 1, "The write flow reopened the credential context.");
  assert(
    verificationCalls === 0,
    "A full success response still triggered read-after-write verification."
  );
  assert(
    writeContext === credentialContext,
    "The write did not use the opened credential context."
  );
}

async function assertSuccessfulGatewayDoesNotRunPostSuccessReads(api) {
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:POST-SUCCESS-REFRESH-FAILURE",
    shipmentId: "SHIP-POST-SUCCESS-REFRESH-FAILURE",
    externalOrderId: "ORDER-POST-SUCCESS-REFRESH-FAILURE",
  });
  let verificationCalls = 0;
  let finalizationCalls = 0;

  const result = await api.requestSalesChannelWrite(
    command,
    {
      finalize: async () => {
        finalizationCalls += 1;
      },
    },
    {
      executeWrite: async (writeCommand) => successResponse(writeCommand),
      verifyWrite: async () => {
        verificationCalls += 1;
        return verificationResult("CONFIRMED");
      },
    }
  );
  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });

  assert(
    verificationCalls === 0,
    "A full success response triggered a gateway-owned read."
  );
  assert(finalizationCalls === 1, "The successful write was not finalized.");
  assert(
    result.confirmation.source === "WRITE_RESPONSE" &&
      result.verification === null &&
      !("postSuccessRefresh" in result),
    "The response-authoritative result contract is incorrect."
  );
  assert(
    request.request_status === "COMPLETED" &&
      request.failure_stage === null &&
      request.attempts
        .map((attempt) => attempt.attempt_type)
        .join(",") === "WRITE,LOCAL_FINALIZE",
    "The completed response-authoritative write has an invalid attempt chain."
  );
}

async function assertCredentialOpenFailureIsNotDispatched(api) {
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:CREDENTIAL-OPEN-FAILURE",
    shipmentId: "SHIP-CREDENTIAL-OPEN-FAILURE-1",
    externalOrderId: "ORDER-CREDENTIAL-OPEN-FAILURE-1",
  });
  let executeCalls = 0;
  let verificationCalls = 0;
  let caughtError;

  try {
    await api.requestSalesChannelWrite(
      command,
      { finalize: async () => undefined },
      {
        openCredentialContext: () => {
          throw new Error("forced credential context failure");
        },
        executeWrite: async (writeCommand) => {
          executeCalls += 1;
          return successResponse(writeCommand);
        },
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult("CONFIRMED");
        },
      }
    );
  } catch (error) {
    caughtError = error;
  }

  assert(
    caughtError?.message === "forced credential context failure",
    "The credential context failure was not returned to the caller."
  );
  assert(executeCalls === 0, "A write was sent after credential setup failed.");
  assert(
    verificationCalls === 0,
    "Verification ran after credential setup failed."
  );

  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: true },
  });
  const attempt = request.attempts[0];

  assert(
    request.request_status === "NOT_APPLIED" &&
      request.failure_stage === "WRITE_TRANSPORT",
    "A credential setup failure was not recorded as a pre-dispatch failure."
  );
  assert(
    attempt.request_dispatched === 0 &&
      attempt.response_received === 0 &&
      attempt.external_applied_unknown === 0,
    "A credential setup failure was incorrectly recorded as dispatched."
  );
}

async function assertAmbiguousWriteIsNotResent(api) {
  let adapterCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:AMBIGUOUS",
    shipmentId: "SHIP-AM-1",
    externalOrderId: "ORDER-AM-1",
  });

  let firstError;
  try {
    await api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult("CONFIRMED");
        },
        executeWrite: async () => {
          adapterCalls += 1;
          throw new Error("fetch failed after the channel applied the write");
        },
      }
    );
  } catch (error) {
    firstError = error;
  }

  assert(
    firstError === undefined,
    "A confirmed ambiguous write still required operator review."
  );
  assert(adapterCalls === 1, "The ambiguous write was not dispatched once.");
  assert(
    verificationCalls === 1,
    "The ambiguous write was not verified exactly once."
  );
  assert(
    finalizationCalls === 1,
    "The confirmed ambiguous write was not finalized locally."
  );

  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });
  const writeAttempt = request.attempts[0];

  assert(
    request.request_status === "COMPLETED",
    "The confirmed ambiguous request did not complete."
  );
  assert(
    request.failure_stage === null,
    "The completed ambiguous request retained a failure stage."
  );
  assert(request.targets.length === 1, "The request target snapshot is missing.");
  assert(
    request.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,VERIFY_READ,LOCAL_FINALIZE",
    "The ambiguous request attempt sequence is incorrect."
  );
  assert(writeAttempt.attempt_type === "WRITE", "The write attempt type is incorrect.");
  assert(
    writeAttempt.attempt_status === "AMBIGUOUS" &&
      writeAttempt.request_dispatched === 1 &&
      writeAttempt.response_received === 0 &&
      writeAttempt.external_applied_unknown === 1,
    "The ambiguous attempt evidence is incomplete."
  );

  let resendAdapterCalls = 0;
  let duplicateError;
  try {
    await api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => undefined,
      },
      {
        verifyWrite: async () => verificationResult("CONFIRMED"),
        executeWrite: async (writeCommand) => {
          resendAdapterCalls += 1;
          return successResponse(writeCommand);
        },
      }
    );
  } catch (error) {
    duplicateError = error;
  }

  assert(
    duplicateError instanceof api.SalesChannelWriteReviewRequiredError,
    "A repeated completed request must point to the existing request."
  );
  assert(resendAdapterCalls === 0, "An ambiguous write was sent a second time.");
  assert(
    (await prisma.sales_channel_write_requests.count({
      where: { idempotency_key: command.idempotencyKey },
    })) === 1,
    "The ambiguous request aggregate was duplicated."
  );
}

async function assertCommittedHandoffContinuesWithoutResend(api) {
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:HANDOFF-ACK-LOSS",
    shipmentId: "HANDOFF-ACK-LOSS-SHIP",
    externalOrderId: "HANDOFF-ACK-LOSS-ORDER",
  });
  let writeCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;

  const result = await withCommittedHandoffAcknowledgementLoss(() =>
    api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        executeWrite: async () => {
          writeCalls += 1;
          return successResponse(command);
        },
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult("CONFIRMED");
        },
      }
    )
  );
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });

  assert(
    result.status === "COMPLETED" && stored.request_status === "COMPLETED",
    "A committed local-finalization handoff did not continue to completion."
  );
  assert(
    writeCalls === 1 && verificationCalls === 0 && finalizationCalls === 1,
    "Handoff recovery repeated an external call or local finalization."
  );
  assert(
    stored.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,LOCAL_FINALIZE",
    "Handoff recovery created an extra execution attempt."
  );
}

async function assertCommittedZeroTargetSettlementUsesOriginalAttempt(api) {
  async function runCase(input) {
    const command = stoppedShipmentCommand({
      idempotencyKey: `TEST:WRITE:ZERO-TARGET-ACK-LOSS:${input.id}`,
      receiptId: `ZERO-TARGET-ACK-LOSS-${input.id}-RECEIPT`,
      externalOrderId: `ZERO-TARGET-ACK-LOSS-${input.id}-ORDER`,
    });
    let writeCalls = 0;
    let verificationCalls = 0;
    let finalizationCalls = 0;
    let caughtError;

    try {
      await withCommittedZeroTargetSettlementAcknowledgementLoss(
        () =>
          api.requestSalesChannelWrite(
            command,
            {
              finalize: async () => {
                finalizationCalls += 1;
              },
            },
            {
              executeWrite: async () => {
                writeCalls += 1;
                throw new Error("fetch failed after external application");
              },
              verifyWrite: async ({ requestId }) => {
                verificationCalls += 1;
                return verificationResult(
                  input.outcome,
                  `Original ${input.outcome} settlement.`,
                  requestId
                );
              },
            }
          ),
        async () => {
          if (!input.advanceSuccessor) return;

          const request =
            await prisma.sales_channel_write_requests.findUniqueOrThrow({
              where: { idempotency_key: command.idempotencyKey },
              include: {
                attempts: { orderBy: { attempt_no: "asc" } },
                targets: true,
              },
            });
          const successorAt = new Date("2099-01-01T00:10:00.000Z");
          await prisma.sales_channel_write_request_targets.updateMany({
            where: {
              sales_channel_write_request_id:
                request.sales_channel_write_request_id,
              external_result_status: "UNKNOWN",
            },
            data: {
              external_result_status: "NOT_APPLIED",
              external_result_code: "TEST_SUCCESSOR_NOT_APPLIED",
              result_received_at: successorAt,
              local_finalization_status: "NOT_REQUIRED",
            },
          });
          await prisma.sales_channel_write_request_attempts.create({
            data: {
              sales_channel_write_request_id:
                request.sales_channel_write_request_id,
              attempt_no:
                Math.max(
                  ...request.attempts.map((attempt) => attempt.attempt_no)
                ) + 1,
              attempt_type: "VERIFY_READ",
              attempt_status: "SUCCEEDED",
              trigger_type: "MANUAL_RECHECK",
              method: "GET",
              endpoint_path: "/integration-test/successor-recheck",
              started_at: successorAt,
              completed_at: successorAt,
              request_dispatched: 1,
              response_received: 1,
              created_at: successorAt,
            },
          });
          await prisma.sales_channel_write_requests.update({
            where: {
              sales_channel_write_request_id:
                request.sales_channel_write_request_id,
            },
            data: {
              request_status: "NOT_APPLIED",
              failure_stage: null,
              error_code: null,
              error_message: null,
              review_required_at: null,
              updated_at: successorAt,
            },
          });
        }
      );
    } catch (error) {
      caughtError = error;
    }

    const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: {
        attempts: { orderBy: { attempt_no: "asc" } },
        targets: true,
      },
    });
    const originalVerificationAttempt = stored.attempts.find(
      (attempt) =>
        attempt.attempt_type === "VERIFY_READ" &&
        attempt.trigger_type === "IMMEDIATE_VERIFY_AFTER_WRITE_UNCERTAINTY"
    );

    if (input.expectedRequestStatus === "REVIEW_REQUIRED") {
      assert(
        caughtError instanceof api.SalesChannelWriteReviewRequiredError,
        "A later NOT_APPLIED successor replaced the original REVIEW_REQUIRED result."
      );
    } else {
      assert(
        caughtError?.code === "TEST_UNKNOWN" &&
          !(caughtError instanceof api.SalesChannelWriteReviewRequiredError),
        "The committed NOT_APPLIED result did not retain its public conflict."
      );
    }
    assert(
      originalVerificationAttempt?.attempt_status ===
        (input.expectedRequestStatus === "REVIEW_REQUIRED"
          ? "AMBIGUOUS"
          : "SUCCEEDED") &&
        originalVerificationAttempt.request_dispatched === 1 &&
        originalVerificationAttempt.response_received === 1 &&
        originalVerificationAttempt.external_applied_unknown ===
          (input.expectedRequestStatus === "REVIEW_REQUIRED" ? 1 : 0),
      `${input.id}: the original verification attempt proof changed.`
    );
    assert(
      writeCalls === 1 && verificationCalls === 1 && finalizationCalls === 0,
      `${input.id}: acknowledgement recovery repeated external or local work.`
    );
    if (input.advanceSuccessor) {
      const successor = stored.attempts.at(-1);
      assert(
        stored.request_status === "NOT_APPLIED" &&
          successor?.trigger_type === "MANUAL_RECHECK" &&
          successor.attempt_status === "SUCCEEDED",
        `Recovery changed the authoritative successor operation: ${JSON.stringify({
          requestStatus: stored.request_status,
          successorTriggerType: successor?.trigger_type,
          successorStatus: successor?.attempt_status,
          attemptCount: stored.attempts.length,
        })}`
      );
    }
  }

  await runCase({
    id: "NOT-APPLIED",
    outcome: "NOT_APPLIED",
    expectedRequestStatus: "NOT_APPLIED",
  });
  await runCase({
    id: "REVIEW-WITH-SUCCESSOR",
    outcome: "UNKNOWN",
    expectedRequestStatus: "REVIEW_REQUIRED",
    advanceSuccessor: true,
  });
}

async function assertCommittedFinalizationTargetIdsAreRecovered(api) {
  async function runCase(input) {
    const firstShipmentId = `${input.id}-SHIP-1`;
    const secondShipmentId = `${input.id}-SHIP-2`;
    const command = orderInstructCommand({
      idempotencyKey: `TEST:WRITE:COMMIT-ACK-LOSS:${input.id}`,
      shipmentId: firstShipmentId,
      externalOrderId: `${input.id}-ORDER`,
    });
    command.shipmentBoxIds.push(secondShipmentId);
    command.targets.push({
      ...command.targets[0],
      targetExternalId: secondShipmentId,
      externalShipmentId: secondShipmentId,
    });

    let writeCalls = 0;
    let verificationCalls = 0;
    let finalizationCalls = 0;
    const finalizedTargetIds = [];
    const result = await withCommittedFinalizationAcknowledgementLoss(() =>
      api.requestSalesChannelWrite(
        command,
        {
          finalize: async ({ targetIds }) => {
            finalizationCalls += 1;
            finalizedTargetIds.push(...targetIds);
          },
        },
        {
          executeWrite: async () => {
            writeCalls += 1;
            return {
              ...successResponse(command),
              payload: input.payload,
            };
          },
          verifyWrite: async () => {
            verificationCalls += 1;
            return verificationResult("CONFIRMED");
          },
        }
      )
    );
    const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: {
        attempts: { orderBy: { attempt_no: "asc" } },
        targets: { orderBy: { target_position: "asc" } },
      },
    });
    const expectedTargetIds = stored.targets
      .filter(
        (target) =>
          target.external_result_status === "SUCCEEDED" &&
          target.local_finalization_status === "SUCCEEDED" &&
          target.local_finalized_at?.getTime() ===
            stored.local_finalized_at?.getTime()
      )
      .map((target) => target.sales_channel_write_request_target_id);

    assert(
      result.status === input.expectedStatus &&
        stored.request_status === input.expectedStatus,
      `${input.id}: the committed request status was not recovered.`
    );
    assert(
      JSON.stringify(result.targetIds) === JSON.stringify(expectedTargetIds) &&
        JSON.stringify(finalizedTargetIds) === JSON.stringify(expectedTargetIds),
      `${input.id}: committed target IDs were not recovered in canonical order.`
    );
    assert(
      expectedTargetIds.length === input.expectedTargetCount,
      `${input.id}: the recovered target scope is incorrect.`
    );
    assert(
      writeCalls === 1 && finalizationCalls === 1 && verificationCalls === 0,
      `${input.id}: acknowledgement recovery repeated an external or local operation.`
    );
    assert(
      stored.attempts.map((attempt) => attempt.attempt_type).join(",") ===
        "WRITE,LOCAL_FINALIZE",
      `${input.id}: acknowledgement recovery changed the attempt history.`
    );
  }

  await runCase({
    id: "COMPLETED",
    payload: successResponse({
      requestType: "ORDER_STATUS_INSTRUCT",
      shipmentBoxIds: ["COMPLETED-SHIP-1", "COMPLETED-SHIP-2"],
    }).payload,
    expectedStatus: "COMPLETED",
    expectedTargetCount: 2,
  });
  await runCase({
    id: "PARTIALLY-COMPLETED",
    payload: {
      code: "200",
      message: "partial",
      data: {
        responseCode: 1,
        responseMessage: "partial",
        responseList: [
          {
            shipmentBoxId: "PARTIALLY-COMPLETED-SHIP-1",
            succeed: true,
            resultCode: "OK",
            retryRequired: false,
          },
          {
            shipmentBoxId: "PARTIALLY-COMPLETED-SHIP-2",
            succeed: false,
            resultCode: "INVALID_ORDER_STATUS",
            retryRequired: false,
          },
        ],
      },
    },
    expectedStatus: "PARTIALLY_COMPLETED",
    expectedTargetCount: 1,
  });
}

async function assertInconsistentCommittedFinalizationFailsClosed(api) {
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:COMMIT-ACK-LOSS:INCONSISTENT",
    shipmentId: "COMMIT-ACK-LOSS-INCONSISTENT-SHIP",
    externalOrderId: "COMMIT-ACK-LOSS-INCONSISTENT-ORDER",
  });
  let writeCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;
  let caughtError;

  try {
    await withCommittedFinalizationAcknowledgementLoss(
      () =>
        api.requestSalesChannelWrite(
          command,
          {
            finalize: async () => {
              finalizationCalls += 1;
            },
          },
          {
            executeWrite: async () => {
              writeCalls += 1;
              return successResponse(command);
            },
            verifyWrite: async () => {
              verificationCalls += 1;
              return verificationResult("CONFIRMED");
            },
          }
        ),
      async () => {
        const request =
          await prisma.sales_channel_write_requests.findUniqueOrThrow({
            where: { idempotency_key: command.idempotencyKey },
            include: { targets: true },
          });
        await prisma.sales_channel_write_request_targets.update({
          where: {
            sales_channel_write_request_target_id:
              request.targets[0].sales_channel_write_request_target_id,
          },
          data: { local_finalized_at: new Date("1900-01-01T00:00:00.000Z") },
        });
      }
    );
  } catch (error) {
    caughtError = error;
  }

  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
  });
  assert(
    caughtError?.message ===
      "Sales channel write committed finalization state is inconsistent.",
    "An inconsistent committed target state was returned as an empty success."
  );
  assert(
    stored.request_status === "COMPLETED" && stored.local_finalized_at,
    "The fail-closed check rewrote the committed request."
  );
  assert(
    writeCalls === 1 && finalizationCalls === 1 && verificationCalls === 0,
    "The fail-closed check repeated an external or local operation."
  );
}

async function assertAmbiguousReturnFinalizesCompleteReceiptGroup(api) {
  const receiptId = "RECEIPT-AM-COMPLETE-GROUP";
  const externalOrderId = "ORDER-AM-COMPLETE-GROUP";
  const command = stoppedShipmentCommand({
    idempotencyKey: "TEST:WRITE:RETURN:AMBIGUOUS-COMPLETE-GROUP",
    receiptId,
    externalOrderId,
  });
  command.targets = [
    {
      targetType: "MATCH_WORKER_ALLOCATION",
      targetExternalId: "101",
      externalOrderId,
      externalShipmentId: "SHIP-AM-COMPLETE-GROUP",
      quantity: 1,
      expectedBeforeStatus: "N",
      requestedAfterStatus: "S",
    },
    {
      targetType: "MATCH_WORKER_ALLOCATION",
      targetExternalId: "102",
      externalOrderId,
      externalShipmentId: "SHIP-AM-COMPLETE-GROUP",
      quantity: 1,
      expectedBeforeStatus: "N",
      requestedAfterStatus: "S",
    },
    {
      targetType: "SUPPLY_CONSUMPTION_EVENT",
      targetExternalId: "9001",
      externalOrderId,
      externalShipmentId: "SHIP-AM-COMPLETE-GROUP",
      quantity: 1,
      expectedBeforeStatus: "N",
      requestedAfterStatus: "S",
    },
  ];
  let finalizedTargetIds = [];

  const result = await api.requestSalesChannelWrite(
    command,
    {
      finalize: async ({ targetIds }) => {
        finalizedTargetIds = [...targetIds];
      },
    },
    {
      executeWrite: async () => {
        throw new Error("fetch failed after the complete return was applied");
      },
      verifyWrite: async ({ requestId }) =>
        verificationResult("CONFIRMED", null, requestId),
    }
  );
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { targets: { orderBy: { target_position: "asc" } } },
  });
  const storedTargetIds = stored.targets.map(
    (target) => target.sales_channel_write_request_target_id
  );

  assert(
    result.status === "COMPLETED" && stored.request_status === "COMPLETED",
    "A confirmed ambiguous return did not complete."
  );
  assert(
    JSON.stringify(finalizedTargetIds) === JSON.stringify(storedTargetIds),
    "The ambiguous return did not finalize the complete receipt target group."
  );
  assert(
    stored.targets.every(
      (target) =>
        target.external_result_status === "SUCCEEDED" &&
        target.local_finalization_status === "SUCCEEDED"
    ),
    "The complete return receipt group did not settle atomically."
  );
}

async function assertAmbiguousWriteFinalizesOnlyConfirmedGroups(api) {
  const firstShipmentId = "SHIP-AM-PARTIAL-1";
  const secondShipmentId = "SHIP-AM-PARTIAL-2";
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:AMBIGUOUS-PARTIAL-GROUPS",
    shipmentId: firstShipmentId,
    externalOrderId: "ORDER-AM-PARTIAL-1",
  });
  command.shipmentBoxIds = [firstShipmentId, secondShipmentId];
  command.targets = [
    command.targets[0],
    {
      ...command.targets[0],
      targetExternalId: secondShipmentId,
      externalOrderId: "ORDER-AM-PARTIAL-2",
      externalShipmentId: secondShipmentId,
    },
  ];
  let finalizedTargetIds = [];
  const result = await api.requestSalesChannelWrite(
    command,
    {
      finalize: async ({ targetIds }) => {
        finalizedTargetIds = [...targetIds];
      },
    },
    {
      executeWrite: async () => {
        throw new Error("fetch failed after partial channel application");
      },
      verifyWrite: async ({ requestId }) => {
        const targets =
          await prisma.sales_channel_write_request_targets.findMany({
            where: { sales_channel_write_request_id: requestId },
            orderBy: { target_position: "asc" },
          });
        return {
          outcome: "PARTIAL",
          code: "TEST_PARTIAL_VERIFICATION",
          message: "One shipment group was confirmed.",
          endpointPath: "/integration-test/verification",
          targetCount: 2,
          confirmedCount: 1,
          targetGroups: [
            {
              groupKey: `SHIPMENT:${firstShipmentId}`,
              targetIds: [targets[0].sales_channel_write_request_target_id],
              outcome: "CONFIRMED",
              code: "TEST_CONFIRMED",
            },
            {
              groupKey: `SHIPMENT:${secondShipmentId}`,
              targetIds: [targets[1].sales_channel_write_request_target_id],
              outcome: "UNKNOWN",
              code: "TEST_UNKNOWN",
            },
          ],
          observedStatuses: [],
        };
      },
    }
  );
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { targets: { orderBy: { target_position: "asc" } } },
  });

  assert(
    result.status === "REVIEW_REQUIRED" &&
      stored.request_status === "REVIEW_REQUIRED",
    "A partially verified write did not preserve review for the unknown group."
  );
  assert(
    finalizedTargetIds.length === 1 &&
      finalizedTargetIds[0] ===
        stored.targets[0].sales_channel_write_request_target_id,
    "The ambiguous write finalized targets outside the confirmed group."
  );
  assert(
    stored.targets[0].external_result_status === "SUCCEEDED" &&
      stored.targets[0].local_finalization_status === "SUCCEEDED" &&
      stored.targets[1].external_result_status === "UNKNOWN" &&
      stored.targets[1].local_finalization_status === "PENDING",
    "Per-group external and local settlement states were not preserved."
  );
}

async function assertCommittedFinalizationIgnoresSuccessorProgress(api) {
  async function runCase(successorState) {
    await prisma.sales_channel_write_controls.deleteMany();
    const suffix =
      successorState === "LOCAL_PENDING" ? "PENDING" : "COMPLETED";
    const firstShipmentId = `COMMIT-SUCCESSOR-${suffix}-SHIP-1`;
    const secondShipmentId = `COMMIT-SUCCESSOR-${suffix}-SHIP-2`;
    const command = orderInstructCommand({
      idempotencyKey: `TEST:WRITE:COMMIT-SUCCESSOR:${suffix}`,
      shipmentId: firstShipmentId,
      externalOrderId: `COMMIT-SUCCESSOR-${suffix}-ORDER-1`,
    });
    command.shipmentBoxIds = [firstShipmentId, secondShipmentId];
    command.targets = [
      command.targets[0],
      {
        ...command.targets[0],
        targetExternalId: secondShipmentId,
        externalOrderId: `COMMIT-SUCCESSOR-${suffix}-ORDER-2`,
        externalShipmentId: secondShipmentId,
      },
    ];

    let writeCalls = 0;
    let verificationCalls = 0;
    let finalizationCalls = 0;
    const finalizedTargetIds = [];
    const successorAt =
      successorState === "LOCAL_PENDING"
        ? new Date("2099-01-01T00:00:01.000Z")
        : new Date("2099-01-01T00:00:02.000Z");

    const result = await withCommittedFinalizationAcknowledgementLoss(
      () =>
        api.requestSalesChannelWrite(
          command,
          {
            finalize: async ({ targetIds }) => {
              finalizationCalls += 1;
              finalizedTargetIds.push(...targetIds);
            },
          },
          {
            executeWrite: async () => {
              writeCalls += 1;
              throw new Error(
                "fetch failed after forced ambiguous multi-target write"
              );
            },
            verifyWrite: async ({ requestId }) => {
              verificationCalls += 1;
              const targets =
                await prisma.sales_channel_write_request_targets.findMany({
                  where: { sales_channel_write_request_id: requestId },
                  orderBy: { target_position: "asc" },
                });
              return {
                outcome: "PARTIAL",
                code: "TEST_PARTIAL_VERIFICATION",
                message: "Only the first shipment was confirmed.",
                endpointPath: "/integration-test/verification",
                targetCount: 2,
                confirmedCount: 1,
                targetGroups: [
                  {
                    groupKey: `SHIPMENT:${firstShipmentId}`,
                    targetIds: [
                      targets[0].sales_channel_write_request_target_id,
                    ],
                    outcome: "CONFIRMED",
                    code: "TEST_CONFIRMED",
                  },
                  {
                    groupKey: `SHIPMENT:${secondShipmentId}`,
                    targetIds: [
                      targets[1].sales_channel_write_request_target_id,
                    ],
                    outcome: "UNKNOWN",
                    code: "TEST_UNKNOWN",
                  },
                ],
                observedStatuses: [],
              };
            },
          }
        ),
      async () => {
        const committed =
          await prisma.sales_channel_write_requests.findUniqueOrThrow({
            where: { idempotency_key: command.idempotencyKey },
            include: {
              attempts: { orderBy: { attempt_no: "asc" } },
              targets: { orderBy: { target_position: "asc" } },
            },
          });
        const nextAttemptNo =
          Math.max(...committed.attempts.map((attempt) => attempt.attempt_no)) +
          1;
        const unresolvedTarget = committed.targets[1];

        await prisma.sales_channel_write_request_targets.update({
          where: {
            sales_channel_write_request_target_id:
              unresolvedTarget.sales_channel_write_request_target_id,
          },
          data: {
            external_result_status: "SUCCEEDED",
            external_result_code: "TEST_SUCCESSOR_CONFIRMED",
            result_received_at: successorAt,
            ...(successorState === "COMPLETED"
              ? {
                  local_finalization_status: "SUCCEEDED",
                  local_finalized_at: successorAt,
                }
              : {}),
          },
        });
        const successorAttempt =
          await prisma.sales_channel_write_request_attempts.create({
            data: {
              sales_channel_write_request_id:
                committed.sales_channel_write_request_id,
              attempt_no: nextAttemptNo,
              attempt_type: "LOCAL_FINALIZE",
              attempt_status:
                successorState === "COMPLETED" ? "SUCCEEDED" : "SENDING",
              trigger_type: "MANUAL_LOCAL_RETRY",
              started_at: successorAt,
              completed_at:
                successorState === "COMPLETED" ? successorAt : null,
            },
          });
        await prisma.sales_channel_write_requests.update({
          where: {
            sales_channel_write_request_id:
              committed.sales_channel_write_request_id,
          },
          data:
            successorState === "COMPLETED"
              ? {
                  request_status: "COMPLETED",
                  failure_stage: null,
                  error_code: null,
                  error_message: null,
                  completed_at: successorAt,
                  local_finalized_at: successorAt,
                  updated_at: successorAt,
                }
              : {
                  request_status: "LOCAL_PENDING",
                  active_review_attempt_id:
                    successorAttempt.sales_channel_write_request_attempt_id,
                  active_review_heartbeat_at: successorAt,
                  updated_at: successorAt,
                },
        });
      },
      ["REVIEW_REQUIRED"]
    );

    const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: {
        attempts: { orderBy: { attempt_no: "asc" } },
        targets: { orderBy: { target_position: "asc" } },
      },
    });
    const originalFinalizationAttempt = stored.attempts.find(
      (attempt) =>
        attempt.attempt_type === "LOCAL_FINALIZE" &&
        attempt.trigger_type === "AFTER_EXTERNAL_VERIFICATION"
    );
    const successorAttempt = stored.attempts.find(
      (attempt) => attempt.trigger_type === "MANUAL_LOCAL_RETRY"
    );

    assert(
      result.status === "REVIEW_REQUIRED" &&
        result.targetIds.length === 1 &&
        result.targetIds[0] ===
          stored.targets[0].sales_channel_write_request_target_id,
      `${suffix}: recovery did not return the original transaction snapshot.`
    );
    assert(
      originalFinalizationAttempt?.attempt_status === "SUCCEEDED" &&
        originalFinalizationAttempt.completed_at?.getTime() ===
          stored.targets[0].local_finalized_at?.getTime(),
      `${suffix}: the original attempt and target commit proof changed.`
    );
    assert(
      successorAttempt?.attempt_status ===
        (successorState === "COMPLETED" ? "SUCCEEDED" : "SENDING") &&
        stored.request_status === successorState,
      `${suffix}: acknowledgement recovery changed the successor operation.`
    );
    assert(
      writeCalls === 1 && verificationCalls === 1 && finalizationCalls === 1,
      `${suffix}: acknowledgement recovery repeated an external or local operation.`
    );
    assert(
      JSON.stringify(finalizedTargetIds) ===
        JSON.stringify([
          stored.targets[0].sales_channel_write_request_target_id,
        ]),
      `${suffix}: local finalization escaped the original target scope.`
    );
  }

  await runCase("LOCAL_PENDING");
  await runCase("COMPLETED");
  await prisma.sales_channel_write_controls.deleteMany();
}

async function assertInvoicePartialResponseUsesOneShipmentGroupRead(api) {
  const shipmentId = "INVOICE-PARTIAL-GROUP-SHIPMENT";
  const invoiceNumber = "881234567890";
  const command = {
    channel: "COUPANG",
    requestType: "COUPANG_INVOICE_UPLOAD",
    idempotencyKey: "TEST:WRITE:INVOICE-PARTIAL-GROUP",
    externalOrderId: "INVOICE-PARTIAL-GROUP-ORDER",
    targetType: "SHIPMENT_BOX",
    targetExternalId: shipmentId,
    sourceMenuKey: "integration-test",
    sourceEntityType: "CARRIER_SHIPMENT",
    sourceEntityId: shipmentId,
    targets: ["VENDOR-ITEM-1", "VENDOR-ITEM-2"].map((vendorItemId) => ({
      targetType: "SHIPMENT_BOX",
      targetExternalId: shipmentId,
      externalOrderId: "INVOICE-PARTIAL-GROUP-ORDER",
      externalShipmentId: shipmentId,
      externalVendorItemId: vendorItemId,
      invoiceNumberSnapshot: invoiceNumber,
      quantity: 1,
    })),
    invoiceItems: ["VENDOR-ITEM-1", "VENDOR-ITEM-2"].map(
      (vendorItemId) => ({
        shipmentBoxId: shipmentId,
        orderId: "INVOICE-PARTIAL-GROUP-ORDER",
        vendorItemId,
        deliveryCompanyCode: "KGB",
        invoiceNumber,
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: "",
      })
    ),
  };
  let verificationCalls = 0;
  let finalizedTargetIds = [];
  const result = await api.requestSalesChannelWrite(
    command,
    {
      finalize: async ({ targetIds }) => {
        finalizedTargetIds = [...targetIds];
      },
    },
    {
      executeWrite: async () => ({
        ...successResponse(command),
        payload: {
          code: "200",
          data: {
            responseCode: 1,
            responseList: [
              {
                shipmentBoxId: shipmentId,
                succeed: true,
                resultCode: "OK",
                retryRequired: false,
              },
              {
                shipmentBoxId: shipmentId,
                succeed: false,
                resultCode: "TEMPORARY_FAILURE",
                retryRequired: true,
              },
            ],
          },
        },
      }),
      verifyWrite: async ({ requestId }) => {
        verificationCalls += 1;
        const targets =
          await prisma.sales_channel_write_request_targets.findMany({
            where: { sales_channel_write_request_id: requestId },
            orderBy: { target_position: "asc" },
          });
        return {
          outcome: "CONFIRMED",
          code: "INVOICE_CONFIRMED",
          message: "The shipment invoice was confirmed.",
          endpointPath: "/integration-test/ordersheets",
          targetCount: targets.length,
          confirmedCount: targets.length,
          targetGroups: [
            {
              groupKey: `SHIPMENT:${shipmentId}`,
              targetIds: targets.map(
                (target) => target.sales_channel_write_request_target_id
              ),
              outcome: "CONFIRMED",
              code: "INVOICE_CONFIRMED",
            },
          ],
          observedStatuses: [],
        };
      },
    }
  );
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { targets: true, attempts: { orderBy: { attempt_no: "asc" } } },
  });

  assert(
    result.status === "COMPLETED" && verificationCalls === 1,
    "An indivisible invoice partial response did not use one targeted GET."
  );
  assert(
    finalizedTargetIds.length === 2 &&
      stored.targets.every(
        (target) =>
          target.external_result_status === "SUCCEEDED" &&
          target.local_finalization_status === "SUCCEEDED"
      ),
    "The confirmed invoice shipment group was not finalized as a whole."
  );
  assert(
    stored.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,VERIFY_READ,LOCAL_FINALIZE",
    "The invoice partial-response recovery attempt history is incomplete."
  );
}

async function assertResponseContractDispositions(api) {
  async function runCase(input) {
    const command = orderInstructCommand({
      idempotencyKey: `TEST:WRITE:RESPONSE-CONTRACT:${input.id}`,
      shipmentId: `${input.id}-SHIP-1`,
      externalOrderId: `${input.id}-ORDER-1`,
    });

    if (input.secondShipmentId) {
      command.shipmentBoxIds.push(input.secondShipmentId);
      command.targets.push({
        ...command.targets[0],
        targetExternalId: input.secondShipmentId,
        externalShipmentId: input.secondShipmentId,
      });
    }

    let verificationCalls = 0;
    let finalizationCalls = 0;
    let caughtError;

    try {
      await api.requestSalesChannelWrite(
        command,
        {
          finalize: async () => {
            finalizationCalls += 1;
          },
        },
        {
          executeWrite: async () => ({
            ...successResponse(command),
            payload: input.payload,
          }),
          verifyWrite: async () => {
            verificationCalls += 1;
            return verificationResult(
              input.verificationOutcome ?? "CONFIRMED"
            );
          },
        }
      );
    } catch (error) {
      caughtError = error;
    }

    const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: {
        attempts: { orderBy: { attempt_no: "asc" } },
        targets: { orderBy: { target_position: "asc" } },
      },
    });
    const attempt = request.attempts[0];
    assert(
      !JSON.stringify(request).includes(WRITE_RESPONSE_BODY_MARKER),
      `${input.id}: an external response message reached persisted state.`
    );

    if (input.expectSuccess) {
      assert(!caughtError, `${input.id}: a settled partial result threw.`);
      assert(
        verificationCalls === 0 && finalizationCalls === 1,
        `${input.id}: successful targets were not finalized exactly once.`
      );
      assert(
        request.request_status === input.requestStatus &&
          request.failure_stage === null &&
          request.error_code === null,
        `${input.id}: the partial settlement aggregate is incorrect.`
      );
      assert(
        request.targets[0].external_result_status === "SUCCEEDED" &&
          request.targets[0].local_finalization_status === "SUCCEEDED" &&
          request.targets[1].external_result_status === "NOT_APPLIED" &&
          request.targets[1].local_finalization_status === "NOT_REQUIRED",
        `${input.id}: target results were not settled independently.`
      );
      return;
    }

    if (input.verifyAfterAmbiguousResponse) {
      assert(
        caughtError instanceof api.SalesChannelWriteReviewRequiredError,
        `${input.id}: the ambiguous response did not enter review after GET.`
      );
      assert(
        verificationCalls === 1 && finalizationCalls === 0,
        `${input.id}: the ambiguous response did not run exactly one targeted GET.`
      );
      assert(
        request.request_status === "REVIEW_REQUIRED" &&
          request.failure_stage === "EXTERNAL_VERIFICATION" &&
          request.error_code === "TEST_UNKNOWN",
        `${input.id}: the targeted GET result did not become authoritative.`
      );
      assert(
        request.attempts.length === 2 &&
          request.attempts[0].attempt_type === "WRITE" &&
          request.attempts[0].attempt_status === "AMBIGUOUS" &&
          request.attempts[1].attempt_type === "VERIFY_READ" &&
          request.attempts[1].attempt_status === "AMBIGUOUS",
        `${input.id}: the write-to-GET recovery history is incomplete.`
      );
      return;
    }

    assert(caughtError instanceof Error, `${input.id}: no error was returned.`);
    assert(
      verificationCalls === 0 && finalizationCalls === 0,
      `${input.id}: a non-success response continued downstream.`
    );
    assert(
      request.request_status === input.requestStatus &&
        request.failure_stage === "WRITE_RESPONSE" &&
        request.error_code === input.errorCode,
      `${input.id}: the request disposition is incorrect.`
    );
    assert(
      request.attempts.length === 1 &&
        attempt.attempt_type === "WRITE" &&
        attempt.attempt_status === input.attemptStatus &&
        attempt.http_status_code === 200 &&
        attempt.external_response_code === input.externalResponseCode &&
        attempt.external_response_message === null &&
        attempt.request_dispatched === 1 &&
        attempt.response_received === 1 &&
        attempt.external_applied_unknown === input.externalAppliedUnknown,
      `${input.id}: the response evidence is incomplete.`
    );

    if (input.reviewRequired) {
      assert(
        caughtError instanceof api.SalesChannelWriteReviewRequiredError,
        `${input.id}: an unsafe response did not require operator review.`
      );
    } else {
      assert(
        caughtError.name === "CoupangWriteResponseContractError",
        `${input.id}: an explicit rejection was replaced.`
      );
    }
  }

  await runCase({
    id: "PARTIAL",
    secondShipmentId: "PARTIAL-SHIP-2",
    payload: {
      code: "200",
      message: WRITE_RESPONSE_BODY_MARKER,
      data: {
        responseCode: 1,
        responseMessage: WRITE_RESPONSE_BODY_MARKER,
        responseList: [
          {
            shipmentBoxId: "PARTIAL-SHIP-1",
            succeed: true,
            resultCode: "OK",
            retryRequired: false,
            resultMessage: WRITE_RESPONSE_BODY_MARKER,
          },
          {
            shipmentBoxId: "PARTIAL-SHIP-2",
            succeed: false,
            resultCode: "INVALID_ORDER_STATUS",
            retryRequired: false,
            resultMessage: WRITE_RESPONSE_BODY_MARKER,
          },
        ],
      },
    },
    requestStatus: "PARTIALLY_COMPLETED",
    expectSuccess: true,
  });

  await runCase({
    id: "EXPLICIT-FAILURE",
    payload: {
      code: "200",
      message: WRITE_RESPONSE_BODY_MARKER,
      data: {
        responseCode: 99,
        responseMessage: WRITE_RESPONSE_BODY_MARKER,
        responseList: [
          {
            shipmentBoxId: "EXPLICIT-FAILURE-SHIP-1",
            succeed: false,
            resultCode: "INVALID_ORDER_STATUS",
            retryRequired: false,
            resultMessage: WRITE_RESPONSE_BODY_MARKER,
          },
        ],
      },
    },
    requestStatus: "NOT_APPLIED",
    attemptStatus: "FAILED",
    errorCode: "COUPANG_WRITE_EXPLICIT_FAILURE",
    externalResponseCode: "99",
    externalAppliedUnknown: 0,
    reviewRequired: false,
  });

  await runCase({
    id: "MALFORMED",
    payload: {
      code: "200",
      message: WRITE_RESPONSE_BODY_MARKER,
      data: {
        responseCode: 0,
        responseMessage: WRITE_RESPONSE_BODY_MARKER,
      },
    },
    requestStatus: "REVIEW_REQUIRED",
    attemptStatus: "AMBIGUOUS",
    errorCode: "COUPANG_WRITE_RESPONSE_MALFORMED",
    externalResponseCode: "0",
    externalAppliedUnknown: 1,
    reviewRequired: true,
    verificationOutcome: "UNKNOWN",
    verifyAfterAmbiguousResponse: true,
  });
}

async function assertManualNotAppliedCanBeResubmitted(api, reviewApi) {
  const timestamp = new Date("2026-07-19T12:30:00.000Z");
  const user = await prisma.users.create({
    data: {
      username: "write-not-applied-operator",
      password_hash: "integration-test",
      role: "LEADER",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:MANUAL-NOT-APPLIED",
    shipmentId: "SHIP-NOT-APPLIED-1",
    externalOrderId: "ORDER-NOT-APPLIED-1",
    userId: user.user_id,
  });
  let adapterCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;
  let firstError;

  try {
    await api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult(
            "UNKNOWN",
            "forced ambiguous verification"
          );
        },
        executeWrite: async () => {
          adapterCalls += 1;
          throw new Error("forced timeout after dispatch");
        },
      }
    );
  } catch (error) {
    firstError = error;
  }

  assert(
    firstError instanceof api.SalesChannelWriteReviewRequiredError,
    "An unknown verification must require operator review."
  );

  const reviewRequest =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: { targets: true },
    });

  await reviewApi.recordManualWriteDecision({
    requestId: reviewRequest.sales_channel_write_request_id,
    userId: user.user_id,
    targetId:
      reviewRequest.targets[0].sales_channel_write_request_target_id,
    decision: "CHANNEL_NOT_APPLIED",
    note: "Confirmed that the channel did not apply the request.",
  });

  const notApplied =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
    });

  assert(
    notApplied.request_status === "NOT_APPLIED" &&
      notApplied.manual_verification_status === "CHANNEL_NOT_APPLIED",
    "The manual channel-not-applied decision was not persisted."
  );

  await api.requestSalesChannelWrite(
    command,
    {
      finalize: async () => {
        finalizationCalls += 1;
      },
    },
    {
      verifyWrite: async () => {
        verificationCalls += 1;
        return verificationResult("CONFIRMED");
      },
      executeWrite: async (writeCommand) => {
        adapterCalls += 1;
        return successResponse(writeCommand);
      },
    }
  );

  const completed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });

  assert(completed.request_status === "COMPLETED", "The resubmitted write did not complete.");
  assert(adapterCalls === 2, "The confirmed not-applied write was not sent again exactly once.");
  assert(
    verificationCalls === 1,
    "Only the ambiguous first write should require verification."
  );
  assert(finalizationCalls === 1, "Only the confirmed retry may finalize locally.");
  assert(
    completed.manual_verification_status === null &&
      completed.manual_verified_by_user_id === null &&
      completed.manual_verified_at === null &&
      completed.manual_verification_note === null &&
      completed.review_required_at === null,
    "The previous manual review state was retained after resubmission."
  );
  assert(
    completed.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,VERIFY_READ,LOCAL_FINALIZE,WRITE,LOCAL_FINALIZE",
    "The resubmission attempt history is incomplete."
  );
  assert(
    (await prisma.sales_channel_write_requests.count({
      where: { idempotency_key: command.idempotencyKey },
    })) === 1,
    "Resubmission must reuse the request aggregate instead of duplicating it."
  );
}

async function assertExactRetryKeepsSnapshotAndCompletedRejectsChanges(api) {
  const timestamp = new Date("2026-07-19T12:34:00.000Z");
  const [firstUser, retryUser] = await Promise.all([
    prisma.users.create({
      data: {
        username: "write-immutable-retry-owner",
        password_hash: "integration-test",
        role: "LEADER",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
    prisma.users.create({
      data: {
        username: "write-immutable-retry-operator",
        password_hash: "integration-test",
        role: "LEADER",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  ]);
  const initialCommand = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:IMMUTABLE-RETRY",
    shipmentId: "SHIP-IMMUTABLE-RETRY",
    externalOrderId: "ORDER-IMMUTABLE-RETRY",
    userId: firstUser.user_id,
    externalVendorItemId: "IMMUTABLE-VENDOR-ITEM",
    quantity: 1,
    inspectionNote: "immutable request target",
  });
  const before = await createNotAppliedOrderRequest(api, initialCommand);
  const exactRetryCommand = structuredClone(initialCommand);
  exactRetryCommand.requestedByUserId = retryUser.user_id;
  let exactDispatchCount = 0;
  let finalizationCount = 0;
  await api.requestSalesChannelWrite(
    exactRetryCommand,
    {
      finalize: async () => {
        finalizationCount += 1;
      },
    },
    {
      executeWrite: async (command) => {
        exactDispatchCount += 1;
        return successResponse(command);
      },
      verifyWrite: async () => verificationResult("CONFIRMED"),
    }
  );

  const completed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: initialCommand.idempotencyKey },
    include: {
      targets: true,
      attempts: { orderBy: { attempt_no: "asc" } },
    },
  });
  assertOrderCommandSnapshot(completed, initialCommand, "immutable retry completion");
  assert(
    completed.request_status === "COMPLETED" &&
      completed.targets[0].sales_channel_write_request_target_id ===
        before.targets[0].sales_channel_write_request_target_id &&
      completed.targets[0].external_result_status === "SUCCEEDED" &&
      completed.targets[0].local_finalization_status === "SUCCEEDED",
    "The exact retry did not reuse and settle the immutable target row."
  );
  assert(
    exactDispatchCount === 1 && finalizationCount === 1,
    "The exact retry did not dispatch and finalize exactly once."
  );
  assert(
    completed.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,WRITE,LOCAL_FINALIZE",
    "The immutable retry attempt history is incomplete."
  );

  const changedCommand = orderInstructCommand({
    idempotencyKey: initialCommand.idempotencyKey,
    shipmentId: "SHIP-CHANGED-RETRY",
    externalOrderId: "ORDER-CHANGED-RETRY",
    userId: retryUser.user_id,
    externalVendorItemId: "CHANGED-VENDOR-ITEM",
    quantity: 2,
    inspectionNote: "must not replace a completed target",
  });
  let changedDispatchCount = 0;
  let changedError;

  try {
    await api.requestSalesChannelWrite(
      changedCommand,
      { finalize: async () => undefined },
      {
        executeWrite: async (command) => {
          changedDispatchCount += 1;
          return successResponse(command);
        },
        verifyWrite: async () => verificationResult("CONFIRMED"),
      }
    );
  } catch (error) {
    changedError = error;
  }

  assert(
    changedError instanceof api.SalesChannelWriteReviewRequiredError,
    "A changed command reused the idempotency key of a completed request."
  );
  assert(
    changedDispatchCount === 0,
    "A changed command for a completed request reached the external adapter."
  );
  const unchanged = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: initialCommand.idempotencyKey },
    include: { targets: true, attempts: true },
  });
  assertOrderCommandSnapshot(unchanged, initialCommand, "completed retry guard");
  assert(
    unchanged.request_status === "COMPLETED" &&
      unchanged.targets[0].sales_channel_write_request_target_id ===
        before.targets[0].sales_channel_write_request_target_id &&
      unchanged.attempts.length === completed.attempts.length,
    "The rejected completed-request change mutated the durable aggregate."
  );
}

async function assertChangedNotAppliedCommandReplacesSnapshot(api) {
  const timestamp = new Date("2026-07-19T12:35:00.000Z");
  const user = await prisma.users.create({
    data: {
      username: "write-changed-not-applied-operator",
      password_hash: "integration-test",
      role: "LEADER",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const initialCommand = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:CHANGED-NOT-APPLIED",
    shipmentId: "SHIP-CHANGED-NOT-APPLIED-A",
    externalOrderId: "ORDER-CHANGED-NOT-APPLIED-A",
    userId: user.user_id,
    sourceMenuKey: "initial-write-menu",
    externalVendorItemId: "VENDOR-ITEM-A",
    deliveryCompanyCode: "CJGLS",
    invoiceNumberSnapshot: "INVOICE-A",
    splitShipping: false,
    preSplitShipped: false,
    estimatedShippingDate: "2026-07-20",
    quantity: 1,
    inspectionResult: "INITIAL",
    inspectionNote: "initial target snapshot",
  });
  const initialRequest = await createNotAppliedOrderRequest(
    api,
    initialCommand
  );
  const initialRequestId = initialRequest.sales_channel_write_request_id;
  const initialTargetId =
    initialRequest.targets[0].sales_channel_write_request_target_id;
  const initialCreatedAt = initialRequest.created_at;
  const retryCommand = orderInstructCommand({
    idempotencyKey: initialCommand.idempotencyKey,
    shipmentId: "SHIP-CHANGED-NOT-APPLIED-B",
    externalOrderId: "ORDER-CHANGED-NOT-APPLIED-B",
    userId: user.user_id,
    sourceMenuKey: "retry-write-menu",
    sourceEntityType: "COUPANG_RETRY_SHIPMENT_BATCH",
    sourceEntityId: "RETRY-SOURCE-B",
    externalVendorItemId: "VENDOR-ITEM-B",
    deliveryCompanyCode: "HANJIN",
    invoiceNumberSnapshot: "INVOICE-B",
    splitShipping: true,
    preSplitShipped: true,
    estimatedShippingDate: "2026-07-21",
    quantity: 2,
    inspectionResult: "RETRY",
    appearanceGrade: "A",
    appearanceDefect: "NONE",
    functionDefect: "NONE",
    inspectionNote: "replacement target snapshot",
  });
  let adapterCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;

  await api.requestSalesChannelWrite(
    retryCommand,
    {
      finalize: async ({ tx, requestId, command }) => {
        finalizationCalls += 1;
        assert(
          command === retryCommand,
          "Local finalization did not receive the retry command."
        );

        const persisted = await tx.sales_channel_write_requests.findUniqueOrThrow({
          where: { sales_channel_write_request_id: requestId },
          include: { targets: true },
        });
        assertOrderCommandSnapshot(
          persisted,
          retryCommand,
          "NOT_APPLIED retry finalization"
        );
      },
    },
    {
      executeWrite: async (command) => {
        adapterCalls += 1;
        assert(
          command === retryCommand,
          "The adapter did not receive the retry command."
        );

        const persisted =
          await prisma.sales_channel_write_requests.findUniqueOrThrow({
            where: { idempotency_key: retryCommand.idempotencyKey },
            include: { targets: true },
          });
        assertOrderCommandSnapshot(
          persisted,
          retryCommand,
          "NOT_APPLIED retry dispatch"
        );

        return successResponse(command);
      },
      verifyWrite: async () => {
        verificationCalls += 1;
        return verificationResult("CONFIRMED");
      },
    }
  );

  const completed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: retryCommand.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });

  assert(
    completed.sales_channel_write_request_id === initialRequestId &&
      completed.created_at.getTime() === initialCreatedAt.getTime(),
    "The changed NOT_APPLIED retry did not preserve aggregate identity."
  );
  assertOrderCommandSnapshot(
    completed,
    retryCommand,
    "completed NOT_APPLIED retry"
  );
  assert(
    completed.targets[0].sales_channel_write_request_target_id !==
      initialTargetId,
    "The previous target row was reused instead of replaced."
  );
  assert(
    completed.request_status === "COMPLETED" &&
      completed.failure_stage === null &&
      completed.error_code === null &&
      completed.error_message === null,
    "The changed NOT_APPLIED retry retained its previous failure state."
  );
  assert(
    adapterCalls === 1 &&
      verificationCalls === 0 &&
      finalizationCalls === 1,
    "The changed NOT_APPLIED retry did not run exactly once."
  );
  assert(
    completed.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,WRITE,LOCAL_FINALIZE",
    "The changed NOT_APPLIED retry did not preserve attempt history."
  );
}

async function assertChangedRejectedCommandReplacesSnapshot(api) {
  const timestamp = new Date("2026-07-19T12:40:00.000Z");
  const initialCommand = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:CHANGED-REJECTED",
    shipmentId: "SHIP-CHANGED-REJECTED-A",
    externalOrderId: "ORDER-CHANGED-REJECTED-A",
    sourceMenuKey: "rejected-initial-menu",
    externalVendorItemId: "REJECTED-VENDOR-ITEM-A",
    inspectionNote: "rejected initial target",
  });

  await prisma.sales_channel_write_controls.upsert({
    where: {
      channel_endpoint_key: {
        channel: initialCommand.channel,
        endpoint_key: initialCommand.requestType,
      },
    },
    create: {
      channel: initialCommand.channel,
      endpoint_key: initialCommand.requestType,
      request_type: initialCommand.requestType,
      is_paused: 1,
      consecutive_failure_count: 3,
      pause_reason: "integration-test pause",
      paused_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
    update: {
      request_type: initialCommand.requestType,
      is_paused: 1,
      consecutive_failure_count: 3,
      pause_reason: "integration-test pause",
      paused_at: timestamp,
      updated_at: timestamp,
    },
  });

  let blockedAdapterCalls = 0;
  let blockedError;

  try {
    await api.requestSalesChannelWrite(
      initialCommand,
      { finalize: async () => undefined },
      {
        executeWrite: async (writeCommand) => {
          blockedAdapterCalls += 1;
          return successResponse(writeCommand);
        },
        verifyWrite: async () => verificationResult("CONFIRMED"),
      }
    );
  } catch (error) {
    blockedError = error;
  }

  const rejected = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: initialCommand.idempotencyKey },
    include: { attempts: true, targets: true },
  });
  const rejectedTargetId =
    rejected.targets[0].sales_channel_write_request_target_id;

  assert(blockedError instanceof Error, "The paused write was not rejected.");
  assert(blockedAdapterCalls === 0, "A paused write reached the adapter.");
  assert(
    rejected.request_status === "REJECTED" &&
      rejected.attempts.length === 1 &&
      rejected.attempts[0].attempt_type === "WRITE" &&
      rejected.attempts[0].attempt_status === "FAILED" &&
      rejected.attempts[0].request_dispatched === 0,
    "The paused write did not reach REJECTED before dispatch."
  );
  assertOrderCommandSnapshot(rejected, initialCommand, "REJECTED setup");

  await prisma.sales_channel_write_controls.update({
    where: {
      channel_endpoint_key: {
        channel: initialCommand.channel,
        endpoint_key: initialCommand.requestType,
      },
    },
    data: {
      is_paused: 0,
      consecutive_failure_count: 0,
      pause_reason: null,
      paused_at: null,
      resumed_at: timestamp,
      updated_at: timestamp,
    },
  });

  const retryCommand = orderInstructCommand({
    idempotencyKey: initialCommand.idempotencyKey,
    shipmentId: "SHIP-CHANGED-REJECTED-B",
    externalOrderId: "ORDER-CHANGED-REJECTED-B",
    sourceMenuKey: "rejected-retry-menu",
    sourceEntityType: "COUPANG_REJECTED_RETRY",
    sourceEntityId: "REJECTED-RETRY-SOURCE-B",
    externalVendorItemId: "REJECTED-VENDOR-ITEM-B",
    deliveryCompanyCode: "LOTTE",
    invoiceNumberSnapshot: "REJECTED-INVOICE-B",
    splitShipping: true,
    preSplitShipped: false,
    quantity: 3,
    inspectionNote: "rejected replacement target",
  });
  let adapterCalls = 0;
  let finalizationCalls = 0;

  await api.requestSalesChannelWrite(
    retryCommand,
    {
      finalize: async ({ tx, requestId, command }) => {
        finalizationCalls += 1;
        const persisted = await tx.sales_channel_write_requests.findUniqueOrThrow({
          where: { sales_channel_write_request_id: requestId },
          include: { targets: true },
        });
        assertOrderCommandSnapshot(
          persisted,
          command,
          "REJECTED retry finalization"
        );
      },
    },
    {
      executeWrite: async (command) => {
        adapterCalls += 1;
        const persisted =
          await prisma.sales_channel_write_requests.findUniqueOrThrow({
            where: { idempotency_key: command.idempotencyKey },
            include: { targets: true },
          });
        assertOrderCommandSnapshot(
          persisted,
          command,
          "REJECTED retry dispatch"
        );
        return successResponse(command);
      },
      verifyWrite: async () => verificationResult("CONFIRMED"),
    }
  );

  const completed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: retryCommand.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });

  assert(
    completed.sales_channel_write_request_id ===
      rejected.sales_channel_write_request_id,
    "The changed REJECTED retry did not preserve aggregate identity."
  );
  assertOrderCommandSnapshot(completed, retryCommand, "completed REJECTED retry");
  assert(
    completed.targets[0].sales_channel_write_request_target_id !==
      rejectedTargetId,
    "The REJECTED target snapshot was not replaced."
  );
  assert(
    completed.request_status === "COMPLETED" &&
      completed.attempts
        .map((attempt) => attempt.attempt_type)
        .join(",") === "WRITE,WRITE,LOCAL_FINALIZE",
    "The changed REJECTED retry did not complete with fresh attempts."
  );
  assert(
    adapterCalls === 1 && finalizationCalls === 1,
    "The changed REJECTED retry did not run exactly once."
  );
}

async function assertConcurrentChangedRetriesHaveOneWinner(api) {
  const initialCommand = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:CONCURRENT-CHANGED-RETRY",
    shipmentId: "SHIP-CONCURRENT-RETRY-A",
    externalOrderId: "ORDER-CONCURRENT-RETRY-A",
    sourceMenuKey: "concurrent-initial-menu",
    externalVendorItemId: "CONCURRENT-VENDOR-A",
  });
  const initialRequest = await createNotAppliedOrderRequest(
    api,
    initialCommand
  );
  const commands = [
    orderInstructCommand({
      idempotencyKey: initialCommand.idempotencyKey,
      shipmentId: "SHIP-CONCURRENT-RETRY-B",
      externalOrderId: "ORDER-CONCURRENT-RETRY-B",
      sourceMenuKey: "concurrent-retry-menu-b",
      externalVendorItemId: "CONCURRENT-VENDOR-B",
      quantity: 2,
      inspectionNote: "concurrent candidate B",
    }),
    orderInstructCommand({
      idempotencyKey: initialCommand.idempotencyKey,
      shipmentId: "SHIP-CONCURRENT-RETRY-C",
      externalOrderId: "ORDER-CONCURRENT-RETRY-C",
      sourceMenuKey: "concurrent-retry-menu-c",
      externalVendorItemId: "CONCURRENT-VENDOR-C",
      quantity: 3,
      inspectionNote: "concurrent candidate C",
    }),
  ];
  const dispatchedCommands = [];
  let finalizationCalls = 0;
  const lifecycle = {
    finalize: async ({ tx, requestId, command }) => {
      finalizationCalls += 1;
      const persisted = await tx.sales_channel_write_requests.findUniqueOrThrow({
        where: { sales_channel_write_request_id: requestId },
        include: { targets: true },
      });
      assertOrderCommandSnapshot(
        persisted,
        command,
        "concurrent retry finalization"
      );
    },
  };
  const dependencies = {
    executeWrite: async (command) => {
      dispatchedCommands.push(command);
      const persisted =
        await prisma.sales_channel_write_requests.findUniqueOrThrow({
          where: { idempotency_key: command.idempotencyKey },
          include: { targets: true },
        });
      assertOrderCommandSnapshot(
        persisted,
        command,
        "concurrent retry dispatch"
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      return successResponse(command);
    },
    verifyWrite: async () => verificationResult("CONFIRMED"),
  };

  const results = await Promise.allSettled(
    commands.map((command) =>
      api.requestSalesChannelWrite(command, lifecycle, dependencies)
    )
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert(
    fulfilled.length === 1 && rejected.length === 1,
    "Concurrent changed retries did not produce exactly one winner."
  );
  assert(
    rejected[0].reason instanceof api.SalesChannelWriteReviewRequiredError,
    "The losing changed retry was not rejected by the retry claim guard."
  );
  assert(
    dispatchedCommands.length === 1 && finalizationCalls === 1,
    "Concurrent changed retries dispatched or finalized more than once."
  );

  const completed = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: initialCommand.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });
  const winningCommand = dispatchedCommands[0];

  assert(
    completed.sales_channel_write_request_id ===
      initialRequest.sales_channel_write_request_id,
    "The concurrent retry winner created a new aggregate."
  );
  assertOrderCommandSnapshot(
    completed,
    winningCommand,
    "completed concurrent retry"
  );
  assert(
    completed.request_status === "COMPLETED" &&
      completed.attempts
        .map((attempt) => attempt.attempt_type)
        .join(",") === "WRITE,WRITE,LOCAL_FINALIZE",
    "The concurrent retry winner did not preserve the shared history."
  );
}

async function assertRetrySnapshotFailureRollsBack(api) {
  const initialCommand = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:RETRY-SNAPSHOT-ROLLBACK",
    shipmentId: "SHIP-RETRY-ROLLBACK-A",
    externalOrderId: "ORDER-RETRY-ROLLBACK-A",
    sourceMenuKey: "rollback-initial-menu",
    externalVendorItemId: "ROLLBACK-VENDOR-A",
    quantity: 1,
    inspectionNote: "rollback original target",
  });
  const before = await createNotAppliedOrderRequest(api, initialCommand);
  const retryCommand = orderInstructCommand({
    idempotencyKey: initialCommand.idempotencyKey,
    shipmentId: "SHIP-RETRY-ROLLBACK-B",
    externalOrderId: "ORDER-RETRY-ROLLBACK-B",
    sourceMenuKey: "rollback-retry-menu",
    externalVendorItemId: "ROLLBACK-VENDOR-B",
    quantity: 2,
    inspectionNote: "rollback replacement target",
  });
  retryCommand.targets[0].allocationId = 2_147_483_000;
  let adapterCalls = 0;
  let caughtError;

  try {
    await api.requestSalesChannelWrite(
      retryCommand,
      { finalize: async () => undefined },
      {
        executeWrite: async (writeCommand) => {
          adapterCalls += 1;
          return successResponse(writeCommand);
        },
        verifyWrite: async () => verificationResult("CONFIRMED"),
      }
    );
  } catch (error) {
    caughtError = error;
  }

  assert(caughtError instanceof Error, "The invalid retry snapshot did not fail.");
  assert(adapterCalls === 0, "A failed retry snapshot reached the adapter.");

  const after = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: initialCommand.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });

  assert(
    after.sales_channel_write_request_id ===
      before.sales_channel_write_request_id &&
      after.request_status === "NOT_APPLIED" &&
      after.failure_stage === before.failure_stage &&
      after.error_code === before.error_code &&
      after.error_message === before.error_message,
    "The failed retry did not restore the previous request state."
  );
  assertOrderCommandSnapshot(after, initialCommand, "rolled-back retry");
  assert(
    after.targets[0].sales_channel_write_request_target_id ===
      before.targets[0].sales_channel_write_request_target_id,
    "The failed retry did not restore the previous target row."
  );
  assert(
    after.attempts.length === 1 &&
      after.attempts[0].sales_channel_write_request_attempt_id ===
        before.attempts[0].sales_channel_write_request_attempt_id,
    "The failed retry changed the previous attempt history."
  );
  assert(
    (await prisma.sales_channel_write_requests.count({
      where: { request_status: "RETRYING" },
    })) === 0,
    "A failed retry left an internal RETRYING state visible."
  );
}

async function assertRetryIdentityMismatchIsBlocked(api) {
  const initialCommand = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:RETRY-IDENTITY-MISMATCH",
    shipmentId: "SHIP-RETRY-IDENTITY-A",
    externalOrderId: "ORDER-RETRY-IDENTITY-A",
  });
  const before = await createNotAppliedOrderRequest(api, initialCommand);
  const mismatchedCommand = stoppedShipmentCommand({
    idempotencyKey: initialCommand.idempotencyKey,
    receiptId: "RECEIPT-RETRY-IDENTITY-B",
    externalOrderId: "ORDER-RETRY-IDENTITY-B",
  });
  let adapterCalls = 0;
  let caughtError;

  try {
    await api.requestSalesChannelWrite(
      mismatchedCommand,
      { finalize: async () => undefined },
      {
        executeWrite: async (writeCommand) => {
          adapterCalls += 1;
          return successResponse(writeCommand);
        },
        verifyWrite: async () => verificationResult("CONFIRMED"),
      }
    );
  } catch (error) {
    caughtError = error;
  }

  assert(
    caughtError instanceof api.SalesChannelWriteReviewRequiredError &&
      caughtError.requestId === before.sales_channel_write_request_id,
    "An idempotency collision with a different request type was not blocked."
  );
  assert(adapterCalls === 0, "An identity-mismatched retry reached the adapter.");

  const after = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: initialCommand.idempotencyKey },
    include: {
      attempts: { orderBy: { attempt_no: "asc" } },
      targets: true,
    },
  });

  assertOrderCommandSnapshot(after, initialCommand, "identity mismatch guard");
  assert(
    after.request_status === "NOT_APPLIED" &&
      after.attempts.length === before.attempts.length,
    "An identity-mismatched retry changed the existing aggregate."
  );
}

async function assertDuplicateConcurrentRequestIsIdempotent(api) {
  let adapterCalls = 0;
  let finalizationCalls = 0;
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:DUPLICATE",
    shipmentId: "SHIP-DUP-1",
    externalOrderId: "ORDER-DUP-1",
  });
  const lifecycle = {
    finalize: async () => {
      finalizationCalls += 1;
    },
  };
  const dependencies = {
    verifyWrite: async () => verificationResult("CONFIRMED"),
    executeWrite: async () => {
      adapterCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return successResponse(command);
    },
  };
  const results = await Promise.allSettled([
    api.requestSalesChannelWrite(command, lifecycle, dependencies),
    api.requestSalesChannelWrite(command, lifecycle, dependencies),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert(fulfilled.length === 1, "Exactly one duplicate request must complete.");
  assert(rejected.length === 1, "Exactly one duplicate request must be rejected.");
  assert(
    rejected[0].reason instanceof api.SalesChannelWriteReviewRequiredError,
    "The duplicate request did not return the existing-request guard."
  );
  assert(adapterCalls === 1, "The duplicate click dispatched more than one write.");
  assert(finalizationCalls === 1, "The duplicate click finalized more than once.");

  const request = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } }, targets: true },
  });

  assert(request.request_status === "COMPLETED", "The winning request did not complete.");
  assert(request.targets.length === 1, "The duplicate request created extra targets.");
  assert(request.attempts.length === 2, "The completed request must have two attempts.");
  assert(
    request.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,LOCAL_FINALIZE",
    "The completed request attempt sequence is incorrect."
  );
}

async function assertCircuitSuccessFailureDoesNotReclassifyWrite(api) {
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:CIRCUIT-SUCCESS-FAILURE",
    shipmentId: "SHIP-CIRCUIT-SUCCESS-FAILURE",
    externalOrderId: "ORDER-CIRCUIT-SUCCESS-FAILURE",
  });
  let adapterCalls = 0;
  let verificationCalls = 0;
  let finalizationCalls = 0;

  await prisma.sales_channel_write_controls.upsert({
    where: {
      channel_endpoint_key: {
        channel: "COUPANG",
        endpoint_key: "ORDER_STATUS_INSTRUCT",
      },
    },
    create: {
      channel: "COUPANG",
      endpoint_key: "ORDER_STATUS_INSTRUCT",
      request_type: "ORDER_STATUS_INSTRUCT",
      is_paused: 0,
      consecutive_failure_count: 2,
    },
    update: {
      is_paused: 0,
      consecutive_failure_count: 2,
      pause_reason: null,
    },
  });
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_fail_circuit_success_bookkeeping_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced circuit success bookkeeping failure';
    END;
    $$;
    CREATE TRIGGER test_fail_circuit_success_bookkeeping
    BEFORE UPDATE ON sales_channel_write_controls
    FOR EACH ROW
    WHEN (OLD.channel = 'COUPANG'
      AND OLD.endpoint_key = 'ORDER_STATUS_INSTRUCT'
      AND NEW.consecutive_failure_count = 0)
    EXECUTE FUNCTION test_fail_circuit_success_bookkeeping_fn();
  `);

  try {
    await api.requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        executeWrite: async (writeCommand) => {
          adapterCalls += 1;
          return successResponse(writeCommand);
        },
        verifyWrite: async () => {
          verificationCalls += 1;
          return verificationResult("CONFIRMED");
        },
      }
    );
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS test_fail_circuit_success_bookkeeping
        ON sales_channel_write_controls;
      DROP FUNCTION IF EXISTS test_fail_circuit_success_bookkeeping_fn();
    `);
  }

  const [request, control] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: { attempts: { orderBy: { attempt_no: "asc" } } },
    }),
    prisma.sales_channel_write_controls.findUniqueOrThrow({
      where: {
        channel_endpoint_key: {
          channel: "COUPANG",
          endpoint_key: "ORDER_STATUS_INSTRUCT",
        },
      },
    }),
  ]);

  assert(adapterCalls === 1, "Circuit bookkeeping failure resent the write.");
  assert(
    verificationCalls === 0,
    "Circuit bookkeeping failure triggered obsolete success verification."
  );
  assert(finalizationCalls === 1, "Circuit bookkeeping failure skipped local finalization.");
  assert(
    request.request_status === "COMPLETED",
    "Circuit bookkeeping failure changed the successful request outcome."
  );
  assert(
    request.attempts.map((attempt) => attempt.attempt_status).join(",") ===
      "SUCCEEDED,SUCCEEDED",
    "Circuit bookkeeping failure reclassified a completed attempt."
  );
  assert(
    control.consecutive_failure_count === 2,
    "The forced circuit failure unexpectedly committed its reset."
  );
  await prisma.sales_channel_write_controls.update({
    where: {
      channel_endpoint_key: {
        channel: "COUPANG",
        endpoint_key: "ORDER_STATUS_INSTRUCT",
      },
    },
    data: {
      is_paused: 0,
      consecutive_failure_count: 0,
      pause_reason: null,
      paused_at: null,
    },
  });
}

async function createInventoryAllocationFixture(ledgerApi, suffix = "") {
  const timestamp = new Date("2026-07-19T12:00:00.000Z");
  const user =
    (await prisma.users.findUnique({
      where: { username: "write-flow-operator" },
    })) ??
    (await prisma.users.create({
      data: {
        username: "write-flow-operator",
        password_hash: "integration-test",
        role: "LEADER",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }));
  const optionRows = {};

  for (const option of [
    { name: "model", category: "PRODUCT_MODEL", key: "TEST-MODEL", label: "TEST-MODEL" },
    { name: "storage", category: "STORAGE", key: "128GB", label: "128GB" },
    { name: "color", category: "DEVICE_COLOR", key: "BLACK", label: "Black" },
    { name: "grade", category: "SALE_GRADE", key: "A", label: "A" },
    { name: "warranty", category: "WARRANTY_GROUP", key: "2Y", label: "2 years" },
  ]) {
    optionRows[option.name] =
      (await prisma.product_criteria_options.findFirst({
        where: {
          category: option.category,
          option_key: option.key,
          parent_key: "",
        },
      })) ??
      (await prisma.product_criteria_options.create({
        data: {
          category: option.category,
          option_key: option.key,
          label: option.label,
          parent_key: "",
          created_at: timestamp,
          updated_at: timestamp,
        },
      }));
  }

  const sku =
    (await prisma.inventory_skus.findFirst({
      where: { sku_code: "QH-SKU-WRITE-FLOW" },
    })) ??
    (await prisma.inventory_skus.create({
      data: {
        sku_code: "QH-SKU-WRITE-FLOW",
        model_option_id: optionRows.model.option_id,
        storage_option_id: optionRows.storage.option_id,
        color_option_id: optionRows.color.option_id,
        sale_grade_option_id: optionRows.grade.option_id,
        created_at: timestamp,
        updated_at: timestamp,
      },
    }));
  const salesOffer =
    (await prisma.sales_offers.findFirst({
      where: { offer_code: "QH-OFFER-WRITE-FLOW" },
    })) ??
    (await prisma.sales_offers.create({
      data: {
        offer_code: "QH-OFFER-WRITE-FLOW",
        model_option_id: optionRows.model.option_id,
        storage_match_mode: "EXACT",
        storage_option_id: optionRows.storage.option_id,
        color_match_mode: "EXACT",
        color_option_id: optionRows.color.option_id,
        warranty_group_option_id: optionRows.warranty.option_id,
        created_at: timestamp,
        updated_at: timestamp,
      },
    }));
  const pgNo = `PG-WRITE-FLOW-1${suffix}`;
  const externalOrderId = `ORDER-LOCAL-1${suffix}`;
  const externalShipmentId = `SHIP-LOCAL-1${suffix}`;

  await prisma.devices.create({
    data: {
      pg_no: pgNo,
      model: optionRows.model.label,
      storage: optionRows.storage.label,
      color: optionRows.color.label,
      sale_grade: optionRows.grade.option_key,
      warranty: "2Y",
      inventory_sku_id: sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.inventory.create({
    data: {
      pg_no: pgNo,
      inventory_status: "SELLABLE",
      location: "TEST",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.$transaction((tx) =>
    ledgerApi.recordInventoryCreatedWithLedger(tx, {
      pgNo,
      inventoryStatus: "SELLABLE",
      operationKey: `integration-fixture:${pgNo}`,
      movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated,
      sourceType: "INTEGRATION_TEST",
      sourceId: pgNo,
      occurredAt: timestamp,
    })
  );
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_order_status: "ACCEPT",
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
      external_vendor_item_id: `VENDOR-LOCAL-1${suffix}`,
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: salesOffer.sales_offer_id,
      work_status: "MATCHED",
      matched_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const allocation = await prisma.match_worker_allocation.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_vendor_item_id: `VENDOR-LOCAL-1${suffix}`,
      pg_no: pgNo,
      sales_offer_id: salesOffer.sales_offer_id,
      inventory_sku_id: sku.inventory_sku_id,
      allocation_status: "ALLOCATED",
      inventory_status_before_allocation: "SELLABLE",
      allocated_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  return {
    user,
    sku,
    salesOffer,
    pgNo,
    externalOrderId,
    externalShipmentId,
    allocation,
  };
}

async function assertLocalFinalizeRetryDoesNotResend(
  api,
  reviewApi,
  ledgerApi,
  orderFinalizerApi
) {
  const fixture = await createInventoryAllocationFixture(ledgerApi);
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:LOCAL-FINALIZE",
    shipmentId: fixture.externalShipmentId,
    externalOrderId: fixture.externalOrderId,
    allocationId: fixture.allocation.allocation_id,
    pgNo: fixture.pgNo,
    userId: fixture.user.user_id,
  });
  let adapterCalls = 0;
  let initialFinalizeCalls = 0;
  let firstError;

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_fail_atomic_local_finalize_attempt_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM sales_channel_write_requests AS request
        WHERE request.sales_channel_write_request_id = OLD.sales_channel_write_request_id
          AND request.idempotency_key = 'TEST:WRITE:LOCAL-FINALIZE'
      ) THEN
        RAISE EXCEPTION 'forced local finalize attempt persistence failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_fail_atomic_local_finalize_attempt
    BEFORE UPDATE ON sales_channel_write_request_attempts
    FOR EACH ROW
    WHEN (OLD.attempt_type = 'LOCAL_FINALIZE'
      AND NEW.attempt_status = 'SUCCEEDED')
    EXECUTE FUNCTION test_fail_atomic_local_finalize_attempt_fn();
  `);

  try {
    try {
      await api.requestSalesChannelWrite(
        command,
        {
          finalize: async ({ tx, requestId, targetIds, finalizedAt }) => {
            initialFinalizeCalls += 1;
            await orderFinalizerApi.finalizePersistedCoupangOrderInstruct({
              tx,
              requestId,
              targetIds,
              finalizedAt,
            });
          },
        },
        {
          verifyWrite: async () => verificationResult("CONFIRMED"),
          executeWrite: async (writeCommand) => {
            adapterCalls += 1;
            return successResponse(writeCommand);
          },
        }
      );
    } catch (error) {
      firstError = error;
    }
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS test_fail_atomic_local_finalize_attempt
        ON sales_channel_write_request_attempts;
      DROP FUNCTION IF EXISTS test_fail_atomic_local_finalize_attempt_fn();
    `);
  }

  assert(
    firstError instanceof api.SalesChannelWriteReviewRequiredError,
    "A local finalization failure must require review."
  );
  assert(adapterCalls === 1, "The external write was not sent exactly once.");
  assert(initialFinalizeCalls === 1, "The failing finalizer did not run once.");

  const pending = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
  });
  const beforeRetryInventory = await prisma.inventory.findUniqueOrThrow({
    where: { pg_no: fixture.pgNo },
  });

  assert(pending.request_status === "LOCAL_PENDING", "The request is not LOCAL_PENDING.");
  assert(
    pending.failure_stage === "LOCAL_FINALIZATION",
    "The local failure stage is incorrect."
  );
  assert(
    beforeRetryInventory.inventory_status === "SELLABLE",
    "Failed local finalization changed inventory."
  );

  await reviewApi.retrySalesChannelLocalFinalization({
    requestId: pending.sales_channel_write_request_id,
    userId: fixture.user.user_id,
  });

  const [completed, inventory, allocation, movements] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { sales_channel_write_request_id: pending.sales_channel_write_request_id },
      include: { attempts: { orderBy: { attempt_no: "asc" } } },
    }),
    prisma.inventory.findUniqueOrThrow({ where: { pg_no: fixture.pgNo } }),
    prisma.match_worker_allocation.findUniqueOrThrow({
      where: { allocation_id: fixture.allocation.allocation_id },
    }),
    prisma.inventory_quantity_movements.findMany({
      where: { pg_no: fixture.pgNo },
      orderBy: { inventory_quantity_movement_id: "asc" },
    }),
  ]);

  assert(completed.request_status === "COMPLETED", "Local retry did not complete.");
  assert(inventory.inventory_status === "RESERVED", "Local retry did not reserve inventory.");
  assert(allocation.allocation_status === "API_ACKED", "Local retry did not ACK allocation.");
  assert(adapterCalls === 1, "Local retry resent the external write.");
  assert(
    completed.attempts.map((attempt) => attempt.attempt_type).join(",") ===
      "WRITE,LOCAL_FINALIZE,LOCAL_FINALIZE",
    "Local retry attempt history is incomplete."
  );
  assert(
    movements.length === 3 &&
      movements[1].quantity_delta === -1 &&
      movements[2].quantity_delta === 1,
    "Local retry did not write exactly one inventory status transfer."
  );

  const balances = await prisma.inventory_quantity_balances.findMany({
    where: { inventory_sku_id: fixture.sku.inventory_sku_id },
  });
  const quantityByStatus = new Map(
    balances.map((balance) => [balance.inventory_status, balance.quantity])
  );

  assert(quantityByStatus.get("SELLABLE") === 0, "SELLABLE balance is incorrect.");
  assert(quantityByStatus.get("RESERVED") === 1, "RESERVED balance is incorrect.");
}

async function assertManualAppliedDecisionSurvivesLocalFailure(
  api,
  reviewApi,
  ledgerApi
) {
  const fixture = await createInventoryAllocationFixture(ledgerApi, "-MANUAL");
  const command = orderInstructCommand({
    idempotencyKey: "TEST:WRITE:MANUAL-APPLIED-LOCAL-FAILURE",
    shipmentId: fixture.externalShipmentId,
    externalOrderId: fixture.externalOrderId,
    allocationId: fixture.allocation.allocation_id,
    pgNo: fixture.pgNo,
    userId: fixture.user.user_id,
  });
  let adapterCalls = 0;
  let initialError;
  try {
    await api.requestSalesChannelWrite(
      command,
      { finalize: async () => undefined },
      {
        executeWrite: async () => {
          adapterCalls += 1;
          throw new Error("forced timeout after dispatch");
        },
        verifyWrite: async () =>
          verificationResult("UNKNOWN", "forced ambiguous verification"),
      }
    );
  } catch (error) {
    initialError = error;
  }
  assert(
    initialError instanceof api.SalesChannelWriteReviewRequiredError,
    "The ambiguous write did not enter manual review."
  );
  const reviewRequest =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: { idempotency_key: command.idempotencyKey },
      include: { targets: true },
    });

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_fail_manual_applied_local_finalize_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM sales_channel_write_requests AS request
        WHERE request.sales_channel_write_request_id = OLD.sales_channel_write_request_id
          AND request.idempotency_key = 'TEST:WRITE:MANUAL-APPLIED-LOCAL-FAILURE'
      ) THEN
        RAISE EXCEPTION 'forced manual-applied local finalize failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_fail_manual_applied_local_finalize
    BEFORE UPDATE ON sales_channel_write_request_attempts
    FOR EACH ROW
    WHEN (OLD.attempt_type = 'LOCAL_FINALIZE'
      AND NEW.attempt_status = 'SUCCEEDED')
    EXECUTE FUNCTION test_fail_manual_applied_local_finalize_fn();
  `);
  let decisionError;
  try {
    try {
      await reviewApi.recordManualWriteDecision({
        requestId: reviewRequest.sales_channel_write_request_id,
        userId: fixture.user.user_id,
        targetId:
          reviewRequest.targets[0].sales_channel_write_request_target_id,
        decision: "CHANNEL_APPLIED",
        note: "The channel applied this shipment.",
      });
    } catch (error) {
      decisionError = error;
    }
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS test_fail_manual_applied_local_finalize
        ON sales_channel_write_request_attempts;
      DROP FUNCTION IF EXISTS test_fail_manual_applied_local_finalize_fn();
    `);
  }
  assert(decisionError, "The local finalization failure was not injected.");

  const [pending, decisionLogs, beforeRetryInventory] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          reviewRequest.sales_channel_write_request_id,
      },
      include: { targets: true, attempts: { orderBy: { attempt_no: "asc" } } },
    }),
    prisma.employee_activity_logs.count({
      where: {
        action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
        target_id: String(reviewRequest.sales_channel_write_request_id),
      },
    }),
    prisma.inventory.findUniqueOrThrow({ where: { pg_no: fixture.pgNo } }),
  ]);
  assert(
    pending.request_status === "LOCAL_PENDING" &&
      pending.failure_stage === "LOCAL_FINALIZATION" &&
      pending.manual_verification_status === "CHANNEL_APPLIED" &&
      pending.manual_verified_by_user_id === fixture.user.user_id &&
      pending.manual_verification_note === "The channel applied this shipment." &&
      pending.targets[0].external_result_status === "SUCCEEDED" &&
      pending.targets[0].local_finalization_status === "FAILED" &&
      decisionLogs === 1,
    "A local failure lost or duplicated the committed manual decision evidence."
  );
  assert(
    beforeRetryInventory.inventory_status === "SELLABLE",
    "The failed manual local finalization changed inventory."
  );

  await withCommittedReviewFinalizationAcknowledgementLoss(
    reviewRequest.sales_channel_write_request_id,
    () =>
      reviewApi.retrySalesChannelLocalFinalization({
        requestId: reviewRequest.sales_channel_write_request_id,
        userId: fixture.user.user_id,
      })
  );
  const [
    completed,
    inventory,
    allocation,
    finalDecisionLogs,
    finalizationLogs,
    movements,
  ] =
    await Promise.all([
      prisma.sales_channel_write_requests.findUniqueOrThrow({
        where: {
          sales_channel_write_request_id:
            reviewRequest.sales_channel_write_request_id,
        },
        include: { attempts: { orderBy: { attempt_no: "asc" } } },
      }),
      prisma.inventory.findUniqueOrThrow({ where: { pg_no: fixture.pgNo } }),
      prisma.match_worker_allocation.findUniqueOrThrow({
        where: { allocation_id: fixture.allocation.allocation_id },
      }),
      prisma.employee_activity_logs.count({
        where: {
          action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
          target_id: String(reviewRequest.sales_channel_write_request_id),
        },
      }),
      prisma.employee_activity_logs.count({
        where: {
          action_type: "SALES_CHANNEL_WRITE_MANUAL_FINALIZE",
          target_id: String(reviewRequest.sales_channel_write_request_id),
        },
      }),
      prisma.inventory_quantity_movements.findMany({
        where: { pg_no: fixture.pgNo },
        orderBy: { inventory_quantity_movement_id: "asc" },
      }),
    ]);
  assert(
    completed.request_status === "COMPLETED" &&
      inventory.inventory_status === "RESERVED" &&
      allocation.allocation_status === "API_ACKED" &&
      adapterCalls === 1 &&
      finalDecisionLogs === 1 &&
      finalizationLogs === 1 &&
      completed.attempts.at(-1)?.attempt_status === "SUCCEEDED" &&
      movements.length === 3,
    "Manual local retry acknowledgement recovery repeated work or lost its commit."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const writeApi = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-service"
  );
  const reviewApi = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-review-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const coupangApi = await import(
    "@/quickhack_server/sales-channel/coupang/api-client"
  );
  const orderFinalizerApi = await import(
    "@/quickhack_server/sales-channel/coupang/order-instruct-finalizer"
  );

  await assertCredentialContextIsShared(writeApi);
  await assertSuccessfulGatewayDoesNotRunPostSuccessReads(writeApi);
  await assertCircuitSuccessFailureDoesNotReclassifyWrite(writeApi);
  await assertCredentialOpenFailureIsNotDispatched(writeApi);
  await assertAmbiguousWriteIsNotResent(writeApi);
  await assertCommittedHandoffContinuesWithoutResend(writeApi);
  await assertCommittedZeroTargetSettlementUsesOriginalAttempt(writeApi);
  await assertCommittedFinalizationTargetIdsAreRecovered(writeApi);
  await assertInconsistentCommittedFinalizationFailsClosed(writeApi);
  await assertAmbiguousReturnFinalizesCompleteReceiptGroup(writeApi);
  await assertAmbiguousWriteFinalizesOnlyConfirmedGroups(writeApi);
  await assertCommittedFinalizationIgnoresSuccessorProgress(writeApi);
  await assertInvoicePartialResponseUsesOneShipmentGroupRead(writeApi);
  await assertResponseContractDispositions(writeApi);
  await assertReturnStateConflictIsVerified(
    writeApi,
    coupangApi,
    "CONFIRMED"
  );
  await assertReturnStateConflictIsVerified(writeApi, coupangApi, "UNKNOWN");
  await assertDefinitiveReturnRejectionStaysNotApplied(writeApi, coupangApi);
  await assertManualNotAppliedCanBeResubmitted(writeApi, reviewApi);
  await assertExactRetryKeepsSnapshotAndCompletedRejectsChanges(writeApi);
  await runSalesChannelWriteFailureScenarios(writeApi, {
    [SALES_CHANNEL_WRITE_FAILURE_SCENARIO.CHANGED_NOT_APPLIED_COMMAND_REPLACES_SNAPSHOT]:
      assertChangedNotAppliedCommandReplacesSnapshot,
    [SALES_CHANNEL_WRITE_FAILURE_SCENARIO.CHANGED_REJECTED_COMMAND_REPLACES_SNAPSHOT]:
      assertChangedRejectedCommandReplacesSnapshot,
    [SALES_CHANNEL_WRITE_FAILURE_SCENARIO.CONCURRENT_CHANGED_RETRIES_HAVE_ONE_WINNER]:
      assertConcurrentChangedRetriesHaveOneWinner,
    [SALES_CHANNEL_WRITE_FAILURE_SCENARIO.RETRY_SNAPSHOT_FAILURE_ROLLS_BACK]:
      assertRetrySnapshotFailureRollsBack,
  });
  await assertRetryIdentityMismatchIsBlocked(writeApi);
  await assertDuplicateConcurrentRequestIsIdempotent(writeApi);
  await assertLocalFinalizeRetryDoesNotResend(
    writeApi,
    reviewApi,
    ledgerApi,
    orderFinalizerApi
  );
  await assertManualAppliedDecisionSurvivesLocalFailure(
    writeApi,
    reviewApi,
    ledgerApi
  );

  console.log(
    "Sales-channel response contracts, credential context, circuit bookkeeping isolation, ambiguity, committed-finalization recovery, return state-conflict recovery, immutable-target retries, duplicate request, and atomic local retry flows verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
