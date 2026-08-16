import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-write-review-ownership-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
const FIXTURE_AT = new Date("2026-08-07T01:00:00.000Z");

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

function unknownObservation(targetId, shipmentId, message) {
  return {
    result: {
      outcome: "UNKNOWN",
      code: "TEST_NOT_CONFIRMED",
      message,
      endpointPath: "/integration-test/recheck",
      targetCount: 1,
      confirmedCount: 0,
      targetGroups: [
        {
          groupKey: `SHIPMENT:${shipmentId}`,
          targetIds: [targetId],
          outcome: "UNKNOWN",
          code: "TEST_NOT_CONFIRMED",
        },
      ],
      observedStatuses: [],
    },
    observedAt: FIXTURE_AT,
    orderSnapshots: [],
    returnSnapshots: [],
    inventoryObservation: null,
  };
}

function notAppliedObservation(targetId, shipmentId) {
  return {
    result: {
      outcome: "NOT_APPLIED",
      code: "TEST_NOT_APPLIED",
      message: "The target was not applied.",
      endpointPath: "/integration-test/recheck",
      targetCount: 1,
      confirmedCount: 0,
      targetGroups: [
        {
          groupKey: `SHIPMENT:${shipmentId}`,
          targetIds: [targetId],
          outcome: "NOT_APPLIED",
          code: "TEST_NOT_APPLIED",
        },
      ],
      observedStatuses: [],
    },
    observedAt: FIXTURE_AT,
    orderSnapshots: [],
    returnSnapshots: [],
    inventoryObservation: null,
  };
}

async function createOperator(username) {
  return prisma.users.create({
    data: {
      username,
      password_hash: "integration-test",
      role: "LEADER",
      created_at: FIXTURE_AT,
      updated_at: FIXTURE_AT,
    },
  });
}

async function createReviewRequest(input) {
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: input.status ?? "REVIEW_REQUIRED",
      failure_stage:
        input.failureStage ??
        (input.status === "LOCAL_PENDING"
          ? "LOCAL_FINALIZATION"
          : "EXTERNAL_VERIFICATION"),
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      external_order_id: input.orderId,
      target_type: "SHIPMENT_BATCH",
      target_external_id: input.shipmentId,
      idempotency_key: `TEST:WRITE-REVIEW-OWNERSHIP:${input.orderId}`,
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/integration-test/write",
      expected_before_status: "ACCEPT",
      requested_after_status: "INSTRUCT",
      source_menu_key: "integration-test",
      source_entity_type: "COUPANG_SHIPMENT_BATCH",
      source_entity_id: input.shipmentId,
      requested_by_user_id: input.userId,
      requested_at: FIXTURE_AT,
      review_required_at: FIXTURE_AT,
      created_at: FIXTURE_AT,
      updated_at: FIXTURE_AT,
    },
  });
  const target = await prisma.sales_channel_write_request_targets.create({
    data: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
      target_type: "SHIPMENT_BOX",
      target_external_id: input.shipmentId,
      external_order_id: input.orderId,
      external_shipment_id: input.shipmentId,
      external_result_status:
        input.status === "LOCAL_PENDING" ? "SUCCEEDED" : "UNKNOWN",
      local_finalization_status:
        input.status === "LOCAL_PENDING" ? "FAILED" : "PENDING",
      target_position: 0,
      created_at: FIXTURE_AT,
    },
  });
  return { ...request, target };
}

async function captureError(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }

  return null;
}

async function assertConcurrentActionsAreRejected(reviewApi, responseApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-CONCURRENT-1",
    shipmentId: "SHIP-CONCURRENT-1",
    userId: user.user_id,
  });
  const observationStarted = deferred();
  const releaseObservation = deferred();
  let observeCalls = 0;
  let persistCalls = 0;
  const dependencies = {
    observeWrite: async (input) => {
      observeCalls += 1;
      observationStarted.resolve();
      await releaseObservation.promise;
      return unknownObservation(
        input.targetIds[0],
        request.target.external_shipment_id,
        "first recheck completed"
      );
    },
    persistObservation: async () => {
      persistCalls += 1;
    },
  };
  const first = reviewApi.recheckSalesChannelWriteRequest(
    { requestId: request.sales_channel_write_request_id, userId: user.user_id },
    dependencies
  );
  await observationStarted.promise;
  const activeRows = await reviewApi.listSalesChannelWriteRequests({
    status: "ALL",
  });
  const activeRow = activeRows.rows.find(
    (row) =>
      row.sales_channel_write_request_id ===
      request.sales_channel_write_request_id
  );
  assert(activeRow, "The active review request was not listed.");
  const activeDto = responseApi.presentSalesChannelWriteRequest(activeRow);

  assert(
    activeDto.reviewOperationInProgress === true &&
      activeDto.activeReviewOperation === "VERIFY_READ" &&
      Boolean(activeDto.activeReviewStartedAt),
    "The active recheck is not exposed through the review DTO."
  );

  const duplicateError = await captureError(() =>
    reviewApi.recheckSalesChannelWriteRequest(
      {
        requestId: request.sales_channel_write_request_id,
        userId: user.user_id,
      },
      dependencies
    )
  );
  const decisionError = await captureError(() =>
    reviewApi.recordManualWriteDecision({
      requestId: request.sales_channel_write_request_id,
      userId: user.user_id,
      targetId: request.target.sales_channel_write_request_target_id,
      decision: "CHANNEL_NOT_APPLIED",
      note: "A conflicting manual decision must be rejected.",
    })
  );

  assert(
    duplicateError?.code === "SALES_CHANNEL_WRITE_REVIEW_IN_PROGRESS",
    "A duplicate recheck was not rejected by the persisted owner."
  );
  assert(
    decisionError?.code === "SALES_CHANNEL_WRITE_REVIEW_IN_PROGRESS",
    "A manual decision was not rejected while recheck owned the request."
  );
  assert(observeCalls === 1, "The rejected recheck reached the external reader.");

  releaseObservation.resolve();
  const result = await first;
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { attempts: true },
  });

  assert(result.confirmed === false, "The unknown observation was confirmed.");
  assert(persistCalls === 1, "The owned observation was not persisted once.");
  assert(
    stored.active_review_attempt_id === null &&
      stored.active_review_heartbeat_at === null,
    "The completed recheck did not release ownership."
  );
  assert(
    stored.attempts.length === 1 &&
      stored.attempts[0].attempt_status === "AMBIGUOUS",
    "The recheck attempt history is incorrect."
  );
}

async function assertStaleExecutionCannotPersist(reviewApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-STALE-1",
    shipmentId: "SHIP-STALE-1",
    userId: user.user_id,
  });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let observeCalls = 0;
  let persistCalls = 0;
  const dependencies = {
    observeWrite: async (input) => {
      observeCalls += 1;

      if (observeCalls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return unknownObservation(
          input.targetIds[0],
          request.target.external_shipment_id,
          "stale first observation"
        );
      }

      return unknownObservation(
        input.targetIds[0],
        request.target.external_shipment_id,
        "replacement observation"
      );
    },
    persistObservation: async () => {
      persistCalls += 1;
    },
  };
  const first = reviewApi.recheckSalesChannelWriteRequest(
    { requestId: request.sales_channel_write_request_id, userId: user.user_id },
    dependencies
  );
  await firstStarted.promise;

  await prisma.sales_channel_write_requests.update({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    data: {
      active_review_heartbeat_at: new Date("2020-01-01T00:00:00.000Z"),
    },
  });

  const replacement = await reviewApi.recheckSalesChannelWriteRequest(
    { requestId: request.sales_channel_write_request_id, userId: user.user_id },
    dependencies
  );
  assert(replacement.confirmed === false, "The replacement result is invalid.");
  assert(persistCalls === 1, "The replacement observation was not persisted once.");

  releaseFirst.resolve();
  const staleError = await captureError(() => first);
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });

  assert(
    staleError?.code === "SALES_CHANNEL_WRITE_REVIEW_OWNERSHIP_LOST",
    "The stale execution did not report ownership loss."
  );
  assert(
    persistCalls === 1,
    "The stale execution persisted after the replacement owner completed."
  );
  assert(
    stored.error_message ===
      "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다.",
    "The stale execution overwrote the replacement result."
  );
  assert(
    stored.attempts.length === 2 &&
      stored.attempts[0].error_code ===
        "SALES_CHANNEL_WRITE_REVIEW_LEASE_EXPIRED" &&
      stored.attempts[1].attempt_status === "AMBIGUOUS",
    "Expired and replacement attempt history is incorrect."
  );
}

async function assertLocalPendingRejectsRecheck(reviewApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-LOCAL-CONFLICT-1",
    shipmentId: "SHIP-LOCAL-CONFLICT-1",
    userId: user.user_id,
    status: "LOCAL_PENDING",
    failureStage: "LOCAL_FINALIZATION",
  });
  const recheckError = await captureError(() =>
    reviewApi.recheckSalesChannelWriteRequest({
      requestId: request.sales_channel_write_request_id,
      userId: user.user_id,
    })
  );
  assert(
    recheckError?.code === "SALES_CHANNEL_RECHECK_STATE_CONFLICT",
    "LOCAL_PENDING must allow only the scoped local-finalization retry."
  );
}

async function assertManualDecisionSettlesOnlySelectedGroup(reviewApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-GROUP-DECISION-1",
    shipmentId: "SHIP-GROUP-DECISION-1",
    userId: user.user_id,
    errorCode: "WRITE_TARGET_RESULT_UNKNOWN",
    errorMessage: "The write response left both shipment groups unknown.",
  });
  const secondTarget =
    await prisma.sales_channel_write_request_targets.create({
      data: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        target_type: "SHIPMENT_BOX",
        target_external_id: "SHIP-GROUP-DECISION-2",
        external_order_id: "ORDER-GROUP-DECISION-2",
        external_shipment_id: "SHIP-GROUP-DECISION-2",
        external_result_status: "UNKNOWN",
        local_finalization_status: "PENDING",
        target_position: 1,
        created_at: FIXTURE_AT,
      },
    });

  await reviewApi.recordManualWriteDecision({
    requestId: request.sales_channel_write_request_id,
    userId: user.user_id,
    targetId: request.target.sales_channel_write_request_target_id,
    decision: "CHANNEL_NOT_APPLIED",
    note: "The first shipment group was not applied.",
  });
  const partiallyResolved =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
      },
      include: {
        targets: { orderBy: { target_position: "asc" } },
        attempts: { orderBy: { attempt_no: "asc" } },
      },
    });
  assert(
    partiallyResolved.request_status === "REVIEW_REQUIRED" &&
      partiallyResolved.targets[0].external_result_status === "NOT_APPLIED" &&
      partiallyResolved.targets[1].external_result_status === "UNKNOWN",
    "A manual decision changed targets outside the selected group."
  );
  assert(
    partiallyResolved.failure_stage === "EXTERNAL_VERIFICATION" &&
      partiallyResolved.error_code === "TARGET_GROUP_RESULT_UNKNOWN" &&
      partiallyResolved.error_message ===
        "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다." &&
      partiallyResolved.review_required_at !== null &&
      partiallyResolved.completed_at === null,
    "A partial manual decision cleared the remaining review context."
  );
  assert(
    partiallyResolved.active_review_attempt_id === null &&
      partiallyResolved.active_review_heartbeat_at === null &&
      partiallyResolved.attempts.length === 1 &&
      partiallyResolved.attempts[0].attempt_status === "SUCCEEDED",
    "A partial manual decision did not complete and release its own review operation."
  );

  await reviewApi.recordManualWriteDecision({
    requestId: request.sales_channel_write_request_id,
    userId: user.user_id,
    targetId: secondTarget.sales_channel_write_request_target_id,
    decision: "CHANNEL_NOT_APPLIED",
    note: "The second shipment group was not applied.",
  });
  const resolved = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { targets: { orderBy: { target_position: "asc" } } },
  });
  assert(
    resolved.request_status === "NOT_APPLIED" &&
      resolved.targets.every(
        (target) =>
          target.external_result_status === "NOT_APPLIED" &&
          target.local_finalization_status === "NOT_REQUIRED"
      ),
    "The request did not derive NOT_APPLIED after every group was resolved."
  );
  assert(
    resolved.failure_stage === null &&
      resolved.error_code === null &&
      resolved.error_message === null &&
      resolved.review_required_at === null &&
      resolved.completed_at === null &&
      resolved.active_review_attempt_id === null &&
      resolved.active_review_heartbeat_at === null,
    "A fully resolved NOT_APPLIED request retained active review context."
  );
}

async function assertReturnManualDecisionSettlesCompleteReceiptGroup(
  reviewApi,
  user
) {
  const receiptId = "RECEIPT-GROUP-DECISION-1";
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "RETURN_APPROVAL",
      request_status: "REVIEW_REQUIRED",
      failure_stage: "EXTERNAL_VERIFICATION",
      external_order_id: "ORDER-RETURN-GROUP-DECISION-1",
      target_type: "COUPANG_RETURN_RECEIPT",
      target_external_id: receiptId,
      idempotency_key: "TEST:WRITE-REVIEW-OWNERSHIP:RETURN-GROUP",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/integration-test/return-write",
      expected_before_status: "RETURN_IN_PROGRESS",
      requested_after_status: "RETURNS_COMPLETED",
      source_menu_key: "integration-test",
      source_entity_type: "COUPANG_RETURN_RECEIPT",
      source_entity_id: receiptId,
      requested_by_user_id: user.user_id,
      requested_at: FIXTURE_AT,
      review_required_at: FIXTURE_AT,
      created_at: FIXTURE_AT,
      updated_at: FIXTURE_AT,
    },
  });
  await prisma.sales_channel_write_request_targets.createMany({
    data: [
      {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        target_type: "MATCH_WORKER_ALLOCATION",
        target_external_id: "101",
        external_order_id: "ORDER-RETURN-GROUP-DECISION-1",
        external_shipment_id: "SHIP-RETURN-GROUP-DECISION-1",
        external_result_status: "UNKNOWN",
        local_finalization_status: "PENDING",
        target_position: 0,
        created_at: FIXTURE_AT,
      },
      {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        target_type: "MATCH_WORKER_ALLOCATION",
        target_external_id: "102",
        external_order_id: "ORDER-RETURN-GROUP-DECISION-1",
        external_shipment_id: "SHIP-RETURN-GROUP-DECISION-1",
        external_result_status: "UNKNOWN",
        local_finalization_status: "PENDING",
        target_position: 1,
        created_at: FIXTURE_AT,
      },
      {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        target_type: "SUPPLY_CONSUMPTION_EVENT",
        target_external_id: "9001",
        external_order_id: "ORDER-RETURN-GROUP-DECISION-1",
        external_shipment_id: "SHIP-RETURN-GROUP-DECISION-1",
        external_result_status: "UNKNOWN",
        local_finalization_status: "PENDING",
        target_position: 2,
        created_at: FIXTURE_AT,
      },
    ],
  });
  const targets = await prisma.sales_channel_write_request_targets.findMany({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    orderBy: { target_position: "asc" },
  });

  await reviewApi.recordManualWriteDecision({
    requestId: request.sales_channel_write_request_id,
    userId: user.user_id,
    targetId: targets[1].sales_channel_write_request_target_id,
    decision: "CHANNEL_NOT_APPLIED",
    note: "The return receipt was not applied.",
  });
  const resolved = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { targets: { orderBy: { target_position: "asc" } } },
  });
  const targetIds = targets.map(
    (target) => target.sales_channel_write_request_target_id
  );
  assert(
    resolved.request_status === "NOT_APPLIED" &&
      resolved.targets.every(
        (target) => target.external_result_status === "NOT_APPLIED"
      ),
    "A return manual decision did not settle the complete receipt group."
  );

  const activityLog = await prisma.employee_activity_logs.findFirstOrThrow({
    where: {
      action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
      target_type: "SALES_CHANNEL_WRITE_REQUEST",
      target_id: String(request.sales_channel_write_request_id),
    },
    orderBy: { id: "desc" },
    include: { changes: true },
  });
  const changes = new Map(
    activityLog.changes.map((change) => [
      change.field_name,
      change.after_value,
    ])
  );
  assert(
    changes.get("groupKey") === `RETURN:${receiptId}` &&
      changes.get("targetIds") === targetIds.join(", "),
    "The return manual-decision audit omitted the complete receipt group."
  );
}

async function assertManualDecisionRollbackIsAtomic(reviewApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-MANUAL-ROLLBACK-1",
    shipmentId: "SHIP-MANUAL-ROLLBACK-1",
    userId: user.user_id,
  });
  const originalTransaction = prisma.$transaction;
  let injected = false;
  prisma.$transaction = async (operation, ...rest) => {
    if (typeof operation !== "function") {
      return Reflect.apply(originalTransaction, prisma, [operation, ...rest]);
    }
    return Reflect.apply(originalTransaction, prisma, [
      async (tx) => {
        const result = await operation(tx);
        const stored = await tx.sales_channel_write_requests.findUnique({
          where: {
            sales_channel_write_request_id:
              request.sales_channel_write_request_id,
          },
          select: { manual_verification_status: true },
        });
        if (!injected && stored?.manual_verification_status) {
          injected = true;
          throw new Error("forced manual-decision transaction rollback");
        }
        return result;
      },
      ...rest,
    ]);
  };

  let rollbackError;
  try {
    rollbackError = await captureError(() =>
      reviewApi.recordManualWriteDecision({
        requestId: request.sales_channel_write_request_id,
        userId: user.user_id,
        targetId: request.target.sales_channel_write_request_target_id,
        decision: "CHANNEL_NOT_APPLIED",
        note: "This decision must roll back atomically.",
      })
    );
  } finally {
    prisma.$transaction = originalTransaction;
  }
  assert(injected && rollbackError, "The manual-decision rollback was not injected.");

  const [rolledBack, rolledBackLogs] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      include: { targets: true, attempts: true },
    }),
    prisma.employee_activity_logs.count({
      where: {
        action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
        target_id: String(request.sales_channel_write_request_id),
      },
    }),
  ]);
  assert(
    rolledBack.request_status === "REVIEW_REQUIRED" &&
      rolledBack.manual_verification_status === null &&
      rolledBack.active_review_attempt_id === null &&
      rolledBack.targets[0].external_result_status === "UNKNOWN" &&
      rolledBack.attempts.length === 0 &&
      rolledBackLogs === 0,
    "A rolled-back manual decision left partial request, target, ownership, or audit state."
  );

  await reviewApi.recordManualWriteDecision({
    requestId: request.sales_channel_write_request_id,
    userId: user.user_id,
    targetId: request.target.sales_channel_write_request_target_id,
    decision: "CHANNEL_NOT_APPLIED",
    note: "The retried decision is committed.",
  });
  const [resolved, resolvedLogs] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
    }),
    prisma.employee_activity_logs.count({
      where: {
        action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
        target_id: String(request.sales_channel_write_request_id),
      },
    }),
  ]);
  assert(
    resolved.request_status === "NOT_APPLIED" && resolvedLogs === 1,
    "The operator could not retry the rolled-back manual decision exactly once."
  );
}

async function assertRecheckCommitAcknowledgementLossRecovers(reviewApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-RECHECK-ACK-LOSS-1",
    shipmentId: "SHIP-RECHECK-ACK-LOSS-1",
    userId: user.user_id,
  });
  const originalTransaction = prisma.$transaction;
  let injected = false;
  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    const stored = await prisma.sales_channel_write_requests.findUnique({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      select: { request_status: true },
    });
    if (!injected && stored?.request_status === "NOT_APPLIED") {
      injected = true;
      throw new Error("forced recheck commit acknowledgement loss");
    }
    return result;
  };

  try {
    await reviewApi.recheckSalesChannelWriteRequest(
      {
        requestId: request.sales_channel_write_request_id,
        userId: user.user_id,
      },
      {
        observeWrite: async () =>
          notAppliedObservation(
            request.target.sales_channel_write_request_target_id,
            request.target.external_shipment_id
          ),
        persistObservation: async () => undefined,
      }
    );
  } finally {
    prisma.$transaction = originalTransaction;
  }
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { attempts: true },
  });
  assert(
    injected &&
      stored.request_status === "NOT_APPLIED" &&
      stored.active_review_attempt_id === null &&
      stored.attempts.length === 1 &&
      stored.attempts[0].attempt_status === "SUCCEEDED",
    "A committed recheck was misclassified after acknowledgement loss."
  );
}

async function assertRecheckAcknowledgesOriginalCommitWithoutTouchingSuccessor(
  reviewApi,
  user
) {
  const request = await createReviewRequest({
    orderId: "ORDER-RECHECK-ACK-SUCCESSOR-1",
    shipmentId: "SHIP-RECHECK-ACK-SUCCESSOR-1",
    userId: user.user_id,
  });
  const originalTransaction = prisma.$transaction;
  let injected = false;
  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    const stored = await prisma.sales_channel_write_requests.findUnique({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      include: {
        attempts: { orderBy: { attempt_no: "asc" } },
        targets: true,
      },
    });
    const originalAttempt = stored?.attempts.find(
      (attempt) =>
        attempt.attempt_type === "VERIFY_READ" &&
        attempt.trigger_type === "MANUAL_RECHECK" &&
        attempt.attempt_status === "AMBIGUOUS" &&
        attempt.completed_at
    );
    if (!injected && stored && originalAttempt) {
      injected = true;
      const successorAt = new Date("2099-01-01T01:00:00.000Z");
      const successorVerification =
        await prisma.sales_channel_write_request_attempts.create({
          data: {
            sales_channel_write_request_id:
              stored.sales_channel_write_request_id,
            attempt_no: originalAttempt.attempt_no + 1,
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
      const successorLocal =
        await prisma.sales_channel_write_request_attempts.create({
          data: {
            sales_channel_write_request_id:
              stored.sales_channel_write_request_id,
            attempt_no: successorVerification.attempt_no + 1,
            attempt_type: "LOCAL_FINALIZE",
            attempt_status: "SENDING",
            trigger_type: "MANUAL_RECHECK_CONFIRMED",
            started_at: successorAt,
            created_at: successorAt,
          },
        });
      await prisma.sales_channel_write_request_targets.update({
        where: {
          sales_channel_write_request_target_id:
            stored.targets[0].sales_channel_write_request_target_id,
        },
        data: {
          external_result_status: "SUCCEEDED",
          external_result_code: "TEST_SUCCESSOR_CONFIRMED",
          result_received_at: successorAt,
          local_finalization_status: "PENDING",
        },
      });
      await prisma.sales_channel_write_requests.update({
        where: {
          sales_channel_write_request_id: stored.sales_channel_write_request_id,
        },
        data: {
          request_status: "LOCAL_PENDING",
          active_review_attempt_id:
            successorLocal.sales_channel_write_request_attempt_id,
          active_review_heartbeat_at: successorAt,
          updated_at: successorAt,
        },
      });
      throw new Error("forced recheck acknowledgement loss with successor");
    }
    return result;
  };

  try {
    await reviewApi.recheckSalesChannelWriteRequest(
      {
        requestId: request.sales_channel_write_request_id,
        userId: user.user_id,
      },
      {
        observeWrite: async () =>
          unknownObservation(
            request.target.sales_channel_write_request_target_id,
            request.target.external_shipment_id,
            "The original recheck remains unresolved."
          ),
        persistObservation: async () => undefined,
      }
    );
  } finally {
    prisma.$transaction = originalTransaction;
  }

  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { attempts: { orderBy: { attempt_no: "asc" } } },
  });
  assert(
    injected &&
      stored.request_status === "LOCAL_PENDING" &&
      stored.attempts.length === 3 &&
      stored.attempts[0].attempt_status === "AMBIGUOUS" &&
      stored.attempts[1].attempt_status === "SUCCEEDED" &&
      stored.attempts[2].attempt_status === "SENDING" &&
      stored.active_review_attempt_id ===
        stored.attempts[2].sales_channel_write_request_attempt_id,
    "Original recheck recovery changed or executed its legitimate successor."
  );
}

async function assertManualDecisionCommitAcknowledgementLossRecovers(
  reviewApi,
  user
) {
  const request = await createReviewRequest({
    orderId: "ORDER-MANUAL-ACK-LOSS-1",
    shipmentId: "SHIP-MANUAL-ACK-LOSS-1",
    userId: user.user_id,
  });
  const originalTransaction = prisma.$transaction;
  let injected = false;
  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    const stored = await prisma.sales_channel_write_requests.findUnique({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      select: {
        request_status: true,
        manual_verification_status: true,
      },
    });
    if (
      !injected &&
      stored?.request_status === "NOT_APPLIED" &&
      stored.manual_verification_status === "CHANNEL_NOT_APPLIED"
    ) {
      injected = true;
      throw new Error("forced manual-decision commit acknowledgement loss");
    }
    return result;
  };

  try {
    await reviewApi.recordManualWriteDecision({
      requestId: request.sales_channel_write_request_id,
      userId: user.user_id,
      targetId: request.target.sales_channel_write_request_target_id,
      decision: "CHANNEL_NOT_APPLIED",
      note: "The committed manual decision must be recovered.",
    });
  } finally {
    prisma.$transaction = originalTransaction;
  }

  const [stored, decisionLogs] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      include: { attempts: true },
    }),
    prisma.employee_activity_logs.count({
      where: {
        action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
        target_id: String(request.sales_channel_write_request_id),
      },
    }),
  ]);
  assert(
    injected &&
      stored.request_status === "NOT_APPLIED" &&
      stored.active_review_attempt_id === null &&
      stored.attempts.length === 1 &&
      stored.attempts[0].attempt_type === "LOCAL_FINALIZE" &&
      stored.attempts[0].attempt_status === "SUCCEEDED" &&
      decisionLogs === 1,
    "A committed manual decision was duplicated or misclassified after acknowledgement loss."
  );
}

async function assertManualDecisionAcknowledgesOriginalCommitWithWriteSuccessor(
  reviewApi,
  user
) {
  const request = await createReviewRequest({
    orderId: "ORDER-MANUAL-ACK-SUCCESSOR-1",
    shipmentId: "SHIP-MANUAL-ACK-SUCCESSOR-1",
    userId: user.user_id,
  });
  const originalTransaction = prisma.$transaction;
  let injected = false;
  prisma.$transaction = async (...args) => {
    const result = await Reflect.apply(originalTransaction, prisma, args);
    const stored = await prisma.sales_channel_write_requests.findUnique({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      include: { attempts: { orderBy: { attempt_no: "asc" } } },
    });
    const originalAttempt = stored?.attempts.find(
      (attempt) =>
        attempt.attempt_type === "LOCAL_FINALIZE" &&
        attempt.trigger_type === "MANUAL_CHANNEL_NOT_APPLIED" &&
        attempt.attempt_status === "SUCCEEDED" &&
        attempt.completed_at
    );
    if (!injected && stored && originalAttempt) {
      injected = true;
      const successorAt = new Date("2099-01-01T02:00:00.000Z");
      const successor =
        await prisma.sales_channel_write_request_attempts.create({
          data: {
            sales_channel_write_request_id:
              stored.sales_channel_write_request_id,
            attempt_no: originalAttempt.attempt_no + 1,
            attempt_type: "WRITE",
            attempt_status: "SENDING",
            trigger_type: "RETRY_CHANGED_COMMAND",
            method: "PATCH",
            endpoint_path: "/integration-test/successor-write",
            started_at: successorAt,
            request_dispatched: 1,
            created_at: successorAt,
          },
        });
      await prisma.sales_channel_write_requests.update({
        where: {
          sales_channel_write_request_id: stored.sales_channel_write_request_id,
        },
        data: {
          request_status: "SENDING",
          sending_at: successorAt,
          updated_at: successorAt,
        },
      });
      assert(
        successor.attempt_status === "SENDING",
        "The write successor fixture was not created."
      );
      throw new Error(
        "forced manual-decision acknowledgement loss with write successor"
      );
    }
    return result;
  };

  try {
    await reviewApi.recordManualWriteDecision({
      requestId: request.sales_channel_write_request_id,
      userId: user.user_id,
      targetId: request.target.sales_channel_write_request_target_id,
      decision: "CHANNEL_NOT_APPLIED",
      note: "The original decision must not alter its write successor.",
    });
  } finally {
    prisma.$transaction = originalTransaction;
  }

  const [stored, decisionLogs] = await Promise.all([
    prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      include: { attempts: { orderBy: { attempt_no: "asc" } } },
    }),
    prisma.employee_activity_logs.count({
      where: {
        action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
        target_id: String(request.sales_channel_write_request_id),
      },
    }),
  ]);
  assert(
    injected &&
      stored.request_status === "SENDING" &&
      stored.attempts.length === 2 &&
      stored.attempts[0].attempt_status === "SUCCEEDED" &&
      stored.attempts[1].attempt_type === "WRITE" &&
      stored.attempts[1].attempt_status === "SENDING" &&
      decisionLogs === 1,
    "Original manual-decision recovery changed its write successor or duplicated its audit log."
  );
}

async function assertLocalPendingRetryIgnoresDiagnosticStage(reviewApi, user) {
  const request = await createReviewRequest({
    orderId: "ORDER-LOCAL-STAGE-1",
    shipmentId: "SHIP-LOCAL-STAGE-1",
    userId: user.user_id,
    status: "LOCAL_PENDING",
  });
  await prisma.sales_channel_write_requests.update({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    data: { failure_stage: null },
  });
  const retryError = await captureError(() =>
    reviewApi.retrySalesChannelLocalFinalization({
      requestId: request.sales_channel_write_request_id,
      userId: user.user_id,
    })
  );
  const stored = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: { attempts: true },
  });
  assert(
    retryError?.code !== "SALES_CHANNEL_LOCAL_RETRY_STATE_CONFLICT" &&
      stored.attempts.some(
        (attempt) => attempt.trigger_type === "MANUAL_LOCAL_RETRY"
      ),
    "LOCAL_PENDING retry still treats failure_stage as an authorization condition."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const reviewApi = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-review-service"
  );
  const responseApi = await import(
    "@/quickhack_server/sales-channel/write/sales-channel-write-review-response"
  );
  const user = await createOperator("write-review-ownership-operator");

  await assertConcurrentActionsAreRejected(reviewApi, responseApi, user);
  await assertStaleExecutionCannotPersist(reviewApi, user);
  await assertLocalPendingRejectsRecheck(reviewApi, user);
  await assertManualDecisionSettlesOnlySelectedGroup(reviewApi, user);
  await assertReturnManualDecisionSettlesCompleteReceiptGroup(reviewApi, user);
  await assertManualDecisionRollbackIsAtomic(reviewApi, user);
  await assertManualDecisionCommitAcknowledgementLossRecovers(reviewApi, user);
  await assertManualDecisionAcknowledgesOriginalCommitWithWriteSuccessor(
    reviewApi,
    user
  );
  await assertRecheckCommitAcknowledgementLossRecovers(reviewApi, user);
  await assertRecheckAcknowledgesOriginalCommitWithoutTouchingSuccessor(
    reviewApi,
    user
  );
  await assertLocalPendingRetryIgnoresDiagnosticStage(reviewApi, user);

  console.log(
    "Sales-channel write review ownership, stale takeover, and cross-action exclusion verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
