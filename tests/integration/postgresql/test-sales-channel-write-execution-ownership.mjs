import nodeAssert from "node:assert/strict";
import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sales-channel-write-execution-ownership-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const RECOVERY_NOW = new Date("2030-01-01T00:00:00.000Z");

let prisma;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successResponse(command) {
  return {
    mode: "mock",
    source: "execution-ownership-test",
    requestPath: "/execution-ownership-test",
    httpStatusCode: 200,
    responseHash: "execution-ownership-test-response",
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
          resultMessage: "request succeeded",
        })),
      },
    },
  };
}

async function confirmedVerification(requestId) {
  const targets = await prisma.sales_channel_write_request_targets.findMany({
    where: { sales_channel_write_request_id: requestId },
    orderBy: { target_position: "asc" },
  });
  return {
    outcome: "CONFIRMED",
    code: "TEST_CONFIRMED",
    message: null,
    endpointPath: "/execution-ownership-test/verification",
    targetCount: targets.length,
    confirmedCount: targets.length,
    targetGroups: targets.map((target) => ({
      groupKey: `SHIPMENT:${target.external_shipment_id}`,
      targetIds: [target.sales_channel_write_request_target_id],
      outcome: "CONFIRMED",
      code: "TEST_CONFIRMED",
    })),
    observedStatuses: [],
  };
}

function orderInstructCommand(id) {
  return {
    channel: "COUPANG",
    requestType: "ORDER_STATUS_INSTRUCT",
    idempotencyKey: `TEST:WRITE:EXECUTION-OWNERSHIP:${id}`,
    externalOrderId: `ORDER-${id}`,
    allocationId: null,
    pgNo: null,
    targetType: "SHIPMENT_BATCH",
    targetExternalId: `SHIPMENT-${id}`,
    packageGroupId: null,
    carrierShipmentId: null,
    expectedBeforeStatus: "ACCEPT",
    requestedAfterStatus: "INSTRUCT",
    sourceMenuKey: "execution-ownership-test",
    sourceEntityType: "COUPANG_SHIPMENT_BATCH",
    sourceEntityId: `SHIPMENT-${id}`,
    requestedByUserId: null,
    workerJobId: null,
    shipmentBoxIds: [`SHIPMENT-${id}`],
    targets: [
      {
        targetType: "SHIPMENT_BOX",
        targetExternalId: `SHIPMENT-${id}`,
        allocationId: null,
        pgNo: null,
        externalOrderId: `ORDER-${id}`,
        externalShipmentId: `SHIPMENT-${id}`,
        externalVendorItemId: null,
        packageGroupId: null,
        carrierShipmentId: null,
        deliveryCompanyCode: null,
        invoiceNumberSnapshot: null,
        splitShipping: null,
        preSplitShipped: null,
        estimatedShippingDate: null,
        supplyConsumptionEventId: null,
        quantity: 1,
        expectedBeforeStatus: "ACCEPT",
        requestedAfterStatus: "INSTRUCT",
        inspectionResult: null,
        appearanceGrade: null,
        appearanceDefect: null,
        functionDefect: null,
        inspectionNote: null,
      },
    ],
  };
}

function isExecutionOwnershipLost(error) {
  return error?.code === "SALES_CHANNEL_WRITE_EXECUTION_OWNERSHIP_LOST";
}

async function storedRequest(command) {
  return prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { idempotency_key: command.idempotencyKey },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });
}

async function recover(recoverInterruptedSalesChannelWrites) {
  return recoverInterruptedSalesChannelWrites({
    now: RECOVERY_NOW,
    staleAfterMinutes: 1,
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { requestSalesChannelWrite } = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-service"
  );
  const { recoverInterruptedSalesChannelWrites } = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-recovery-service"
  );

  {
    const command = orderInstructCommand("STALE-PENDING");
    const enteredBeforeDispatch = deferred();
    const releaseBeforeDispatch = deferred();
    let adapterCalls = 0;

    const operation = requestSalesChannelWrite(
      command,
      {
        beforeDispatch: async () => {
          enteredBeforeDispatch.resolve();
          await releaseBeforeDispatch.promise;
        },
        finalize: async () => undefined,
      },
      {
        executeWrite: async (writeCommand) => {
          adapterCalls += 1;
          return successResponse(writeCommand);
        },
        verifyWrite: async (input) => confirmedVerification(input.requestId),
      }
    );

    await enteredBeforeDispatch.promise;
    const recovery = await recover(recoverInterruptedSalesChannelWrites);
    assert(recovery.recoveredCount === 1, "The stale PENDING request was not recovered.");
    releaseBeforeDispatch.resolve();
    await nodeAssert.rejects(operation, isExecutionOwnershipLost);

    const stored = await storedRequest(command);
    assert(adapterCalls === 0, "A recovered PENDING request reached the adapter.");
    assert(stored.request_status === "NOT_APPLIED", "Late PENDING execution overwrote recovery.");
    assert(
      stored.attempts.length === 1 &&
        stored.attempts[0].attempt_status === "FAILED" &&
        stored.attempts[0].request_dispatched === 0,
      "The recovered PENDING attempt evidence is inconsistent."
    );
  }

  {
    const command = orderInstructCommand("LATE-WRITE");
    const enteredWrite = deferred();
    const releaseWrite = deferred();
    let verificationCalls = 0;
    let finalizationCalls = 0;

    const operation = requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        executeWrite: async (writeCommand) => {
          enteredWrite.resolve();
          await releaseWrite.promise;
          return successResponse(writeCommand);
        },
        verifyWrite: async (input) => {
          verificationCalls += 1;
          return confirmedVerification(input.requestId);
        },
      }
    );

    await enteredWrite.promise;
    const recovery = await recover(recoverInterruptedSalesChannelWrites);
    assert(recovery.recoveredCount === 1, "The stale SENDING request was not recovered.");
    releaseWrite.resolve();
    await nodeAssert.rejects(operation, isExecutionOwnershipLost);

    const stored = await storedRequest(command);
    assert(stored.request_status === "REVIEW_REQUIRED", "Late WRITE success overwrote recovery.");
    assert(verificationCalls === 0 && finalizationCalls === 0, "A stale WRITE execution continued downstream.");
    assert(
      stored.attempts.length === 1 &&
        stored.attempts[0].attempt_type === "WRITE" &&
        stored.attempts[0].attempt_status === "AMBIGUOUS",
      "The recovered WRITE attempt was replaced by a late response."
    );
  }

  {
    const command = orderInstructCommand("LATE-VERIFY");
    const enteredVerification = deferred();
    const releaseVerification = deferred();
    let finalizationCalls = 0;

    const operation = requestSalesChannelWrite(
      command,
      {
        finalize: async () => {
          finalizationCalls += 1;
        },
      },
      {
        executeWrite: async () => {
          throw new Error("fetch failed after dispatch");
        },
        verifyWrite: async (input) => {
          enteredVerification.resolve();
          await releaseVerification.promise;
          return confirmedVerification(input.requestId);
        },
      }
    );

    await enteredVerification.promise;
    const recovery = await recover(recoverInterruptedSalesChannelWrites);
    assert(recovery.recoveredCount === 1, "The stale VERIFYING request was not recovered.");
    releaseVerification.resolve();
    await nodeAssert.rejects(operation, isExecutionOwnershipLost);

    const stored = await storedRequest(command);
    assert(stored.request_status === "REVIEW_REQUIRED", "Late verification overwrote recovery.");
    assert(finalizationCalls === 0, "A stale verification entered local finalization.");
    assert(
      stored.attempts.map((attempt) => attempt.attempt_type).join(",") ===
        "WRITE,VERIFY_READ" &&
        stored.attempts[0].attempt_status === "AMBIGUOUS" &&
        stored.attempts[1].attempt_status === "AMBIGUOUS",
      "The recovered verification evidence was replaced by a late result."
    );
  }

  {
    const command = orderInstructCommand("LOCAL-FINALIZE-OWNERSHIP");
    let observedOwnedFinalize = false;

    await requestSalesChannelWrite(
      command,
      {
        finalize: async ({ tx, requestId }) => {
          const request = await tx.sales_channel_write_requests.findUniqueOrThrow({
            where: { sales_channel_write_request_id: requestId },
          });
          const attempt = await tx.sales_channel_write_request_attempts.findUniqueOrThrow({
            where: {
              sales_channel_write_request_attempt_id:
                request.active_review_attempt_id,
            },
          });
          observedOwnedFinalize =
            request.request_status === "LOCAL_PENDING" &&
            attempt.attempt_type === "LOCAL_FINALIZE" &&
            attempt.attempt_status === "SENDING";
        },
      },
      {
        executeWrite: async (writeCommand) => successResponse(writeCommand),
        verifyWrite: async (input) => confirmedVerification(input.requestId),
      }
    );

    const stored = await storedRequest(command);
    assert(observedOwnedFinalize, "Automatic local finalization was not bound to review ownership.");
    assert(stored.request_status === "COMPLETED", "Owned local finalization did not complete.");
    assert(stored.active_review_attempt_id === null, "Completed local finalization retained ownership.");
    assert(
      stored.attempts.map((attempt) => attempt.attempt_type).join(",") ===
        "WRITE,LOCAL_FINALIZE",
      "A full success response still created a VERIFY_READ attempt."
    );
  }

  console.log(
    "Sales-channel write execution ownership blocks stale PENDING, WRITE, and VERIFY completions and binds automatic local finalization."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
