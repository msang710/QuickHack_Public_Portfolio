import assert from "node:assert/strict";

const { buildInvoiceIssueMutationResponse } = await import(
  "@/quickhack_server/shipment/carrier-integration/invoice-submission-response"
);

const completed = buildInvoiceIssueMutationResponse({
  issueBatch: { status: "ALLOCATED" },
  channelSubmission: {
    status: "COMPLETED",
    completedCount: 1,
    requests: [{ requestId: 11, status: "COMPLETED" }],
  },
});
assert.deepEqual(
  { ok: completed.ok, reviewRequired: completed.reviewRequired, status: completed.status },
  { ok: true, reviewRequired: false, status: 200 }
);

const partial = buildInvoiceIssueMutationResponse({
  issueBatch: { status: "ALLOCATED" },
  channelSubmission: {
    status: "PARTIAL",
    completedCount: 1,
    reviewRequiredCount: 1,
    requests: [
      { requestId: 21, status: "COMPLETED" },
      { requestId: 22, status: "REVIEW_REQUIRED" },
    ],
  },
});
assert.equal(partial.ok, false);
assert.equal(partial.reviewRequired, true);
assert.equal(partial.partial, true);
assert.equal(partial.status, 202);
assert.deepEqual(partial.requestIds, [21, 22]);

const allocating = buildInvoiceIssueMutationResponse({
  issueBatch: { status: "ALLOCATING" },
  channelSubmission: null,
});
assert.equal(allocating.ok, false);
assert.equal(allocating.reviewRequired, false);
assert.equal(allocating.status, 202);

console.log("Typed invoice issue and channel submission outcomes verified.");
