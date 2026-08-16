import assert from "node:assert/strict";

const { resolveCoupangWriteTargetResults } = await import(
  "../../quickhack_server/sales-channel/coupang/write-target-result-service.ts"
);
const {
  deriveSalesChannelWriteRequestStatus,
  isCommittedSalesChannelWriteAttempt,
  isCommittedSalesChannelWriteLocalFinalization,
} = await import(
  "../../quickhack_server/sales-channel/write/sales-channel-write-target-state.ts"
);

const targets = [
  {
    sales_channel_write_request_target_id: 11,
    target_external_id: "SHIP-1",
    external_shipment_id: "SHIP-1",
  },
  {
    sales_channel_write_request_target_id: 12,
    target_external_id: "SHIP-2",
    external_shipment_id: "SHIP-2",
  },
];
const partialAssessment = {
  outcome: "PARTIAL",
  externalResponseCode: "1",
  targetCount: 2,
  succeededTargetCount: 1,
  failedTargetCount: 1,
  failedTargets: [],
  targetResults: [
    {
      externalTargetId: "SHIP-1",
      succeeded: true,
      resultCode: "OK",
      retryRequired: false,
    },
    {
      externalTargetId: "SHIP-2",
      succeeded: false,
      resultCode: "INVALID_ORDER_STATUS",
      retryRequired: true,
    },
  ],
  errorCode: "COUPANG_WRITE_PARTIAL_SUCCESS",
  summary: "partial",
};
const commandBase = {
  channel: "COUPANG",
  idempotencyKey: "TARGET-RESULT-TEST",
  sourceMenuKey: "test",
  sourceEntityType: "TEST",
  sourceEntityId: "1",
  targets: [],
};

const orderResults = resolveCoupangWriteTargetResults({
  command: {
    ...commandBase,
    requestType: "ORDER_STATUS_INSTRUCT",
    shipmentBoxIds: ["SHIP-1", "SHIP-2"],
  },
  assessment: partialAssessment,
  targets,
});
assert.deepEqual(
  orderResults.map((result) => [
    result.targetId,
    result.externalResultStatus,
    result.localFinalizationStatus,
  ]),
  [
    [11, "SUCCEEDED", "PENDING"],
    [12, "NOT_APPLIED", "NOT_REQUIRED"],
  ]
);
assert.ok(
  orderResults.every((result) => !("externalResultMessage" in result)),
  "Target settlement results must not accept provider messages."
);

const invoiceResults = resolveCoupangWriteTargetResults({
  command: {
    ...commandBase,
    requestType: "COUPANG_INVOICE_UPLOAD",
    invoiceItems: [
      {
        shipmentBoxId: "SHIP-1",
        orderId: "ORDER-1",
        vendorItemId: "VENDOR-1",
        deliveryCompanyCode: "LOGEN",
        invoiceNumber: "INV-1",
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: "",
      },
      {
        shipmentBoxId: "SHIP-1",
        orderId: "ORDER-1",
        vendorItemId: "VENDOR-2",
        deliveryCompanyCode: "LOGEN",
        invoiceNumber: "INV-1",
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: "",
      },
    ],
  },
  assessment: partialAssessment,
  targets: targets.map((target) => ({
    ...target,
    target_external_id: "SHIP-1",
    external_shipment_id: "SHIP-1",
  })),
});
assert.ok(
  invoiceResults.every(
    (result) => result.externalResultStatus === "UNKNOWN"
  ),
  "A mixed invoice response must not be attributed by response position."
);

assert.equal(
  deriveSalesChannelWriteRequestStatus(
    orderResults.map((result) => ({
      externalResultStatus: result.externalResultStatus,
      localFinalizationStatus:
        result.externalResultStatus === "SUCCEEDED"
          ? "SUCCEEDED"
          : result.localFinalizationStatus,
    }))
  ),
  "PARTIALLY_COMPLETED"
);
assert.equal(
  deriveSalesChannelWriteRequestStatus(
    invoiceResults.map((result) => ({
      externalResultStatus: result.externalResultStatus,
      localFinalizationStatus: result.localFinalizationStatus,
    }))
  ),
  "REVIEW_REQUIRED"
);

const originalAttemptExpectation = {
  requestId: 101,
  attemptId: 202,
  attemptNo: 3,
  attemptType: "LOCAL_FINALIZE",
  attemptStatus: "SUCCEEDED",
  triggerType: "AFTER_EXTERNAL_VERIFICATION",
  completedAt: "2026-08-10 09:00:00",
  requestDispatched: false,
  responseReceived: false,
  externalAppliedUnknown: false,
};
const originalAttemptState = {
  salesChannelWriteRequestId: 101,
  salesChannelWriteRequestAttemptId: 202,
  attemptNo: 3,
  attemptType: "LOCAL_FINALIZE",
  attemptStatus: "SUCCEEDED",
  triggerType: "AFTER_EXTERNAL_VERIFICATION",
  completedAt: "2026-08-10 09:00:00",
  requestDispatched: 0,
  responseReceived: 0,
  externalAppliedUnknown: 0,
};

assert.equal(
  isCommittedSalesChannelWriteAttempt({
    expected: originalAttemptExpectation,
    attempt: originalAttemptState,
  }),
  true,
  "The exact immutable attempt must prove its transaction commit."
);

for (const [label, change] of [
  ["request", { salesChannelWriteRequestId: 999 }],
  ["attempt", { salesChannelWriteRequestAttemptId: 999 }],
  ["attempt number", { attemptNo: 4 }],
  ["type", { attemptType: "VERIFY_READ" }],
  ["status", { attemptStatus: "FAILED" }],
  ["trigger", { triggerType: "MANUAL_LOCAL_RETRY" }],
  ["completion timestamp", { completedAt: "2026-08-10 09:00:01" }],
  ["dispatch flag", { requestDispatched: 1 }],
  ["response flag", { responseReceived: 1 }],
  ["external uncertainty flag", { externalAppliedUnknown: 1 }],
]) {
  assert.equal(
    isCommittedSalesChannelWriteAttempt({
      expected: originalAttemptExpectation,
      attempt: { ...originalAttemptState, ...change },
    }),
    false,
    `A mismatched ${label} must not prove the transaction commit.`
  );
}

const originalFinalizationProof = {
  expectedAttempt: originalAttemptExpectation,
  requestStatus: "REVIEW_REQUIRED",
  expectedTargetIds: [11],
  finalizedAt: "2026-08-10 09:00:00",
  attempt: originalAttemptState,
  targets: [
    {
      salesChannelWriteRequestTargetId: 11,
      externalResultStatus: "SUCCEEDED",
      localFinalizationStatus: "SUCCEEDED",
      localFinalizedAt: "2026-08-10 09:00:00",
    },
    {
      salesChannelWriteRequestTargetId: 12,
      externalResultStatus: "UNKNOWN",
      localFinalizationStatus: "PENDING",
      localFinalizedAt: null,
    },
  ],
};

assert.equal(
  isCommittedSalesChannelWriteLocalFinalization(originalFinalizationProof),
  true,
  "The exact committed attempt and target snapshot must prove finalization."
);
assert.equal(
  isCommittedSalesChannelWriteLocalFinalization({
    ...originalFinalizationProof,
    requestStatus: "LOCAL_PENDING",
    targets: originalFinalizationProof.targets.map((target, index) =>
      index === 1
        ? {
            ...target,
            externalResultStatus: "SUCCEEDED",
            localFinalizationStatus: "PENDING",
          }
        : target
    ),
  }),
  true,
  "A successor's pending target must not invalidate the original commit proof."
);
assert.equal(
  isCommittedSalesChannelWriteLocalFinalization({
    ...originalFinalizationProof,
    requestStatus: "COMPLETED",
    targets: originalFinalizationProof.targets.map((target, index) =>
      index === 1
        ? {
            ...target,
            externalResultStatus: "SUCCEEDED",
            localFinalizationStatus: "SUCCEEDED",
            localFinalizedAt: "2026-08-10 09:01:00",
          }
        : target
    ),
  }),
  true,
  "A successor's later completion must not invalidate the original commit proof."
);

for (const [label, change] of [
  ["attempt proof", { attempt: { ...originalAttemptState, attemptNo: 4 } }],
  [
    "target timestamp",
    {
      targets: originalFinalizationProof.targets.map((target, index) =>
        index === 0
          ? { ...target, localFinalizedAt: "2026-08-10 09:00:01" }
          : target
      ),
    },
  ],
  ["target identity", { expectedTargetIds: [999] }],
  ["duplicate target identity", { expectedTargetIds: [11, 11] }],
]) {
  assert.equal(
    isCommittedSalesChannelWriteLocalFinalization({
      ...originalFinalizationProof,
      ...change,
    }),
    false,
    `A mismatched ${label} must fail closed.`
  );
}

assert.equal(
  isCommittedSalesChannelWriteLocalFinalization({
    ...originalFinalizationProof,
    requestStatus: "COMPLETED",
  }),
  false,
  "An aggregate request status that disagrees with target state must fail closed."
);

console.log(
  "Sales-channel per-target settlement, aggregate status, and immutable committed-finalization proof rules verified."
);
