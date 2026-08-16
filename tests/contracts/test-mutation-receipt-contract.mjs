import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createMutationReceipt,
  settleOptionalMutationRefresh,
  settleOptionalWorkerWake,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";
import {
  MUTATION_RECEIPT_OUTCOMES,
  MUTATION_WARNING_CODES,
} from "@/quickhack_shared/core/mutation-receipt";

const projectRoot = process.cwd();
const read = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const stableId = stableMutationOperationId("Account Profile", [17, 4]);
assert.equal(stableId, stableMutationOperationId("Account Profile", [17, 4]));
assert.notEqual(stableId, stableMutationOperationId("Account Profile", [17, 5]));
assert.match(stableId, /^account-profile:[a-f0-9]{32}$/);

const committed = createMutationReceipt(
  { id: 17, revision: 4 },
  {
    operationId: stableId,
    committedAt: new Date("2026-08-17T12:00:00.000Z"),
  }
);
assert.deepEqual(committed, {
  operationId: stableId,
  outcome: MUTATION_RECEIPT_OUTCOMES.committed,
  committedAt: "2026-08-17T12:00:00.000Z",
  result: { id: 17, revision: 4 },
  refreshRequired: false,
  warnings: [],
});

const invalidTimestampReceipt = createMutationReceipt(
  { id: 18 },
  { operationId: "invalid-timestamp", committedAt: "not-a-timestamp" }
);
assert.ok(Number.isFinite(Date.parse(invalidTimestampReceipt.committedAt)));

const refreshed = await settleOptionalMutationRefresh(committed, async () => [
  "current",
]);
assert.equal(refreshed.completed, true);
assert.deepEqual(refreshed.value, ["current"]);
assert.equal(refreshed.receipt, committed);

const sensitiveError =
  "postgresql://quickhack:do-not-expose@127.0.0.1/db raw customer note";
const deferred = await settleOptionalMutationRefresh(committed, async () => {
  throw new Error(sensitiveError);
});
assert.equal(deferred.completed, false);
assert.equal(deferred.receipt.refreshRequired, true);
assert.deepEqual(deferred.receipt.warnings, [
  { code: MUTATION_WARNING_CODES.refreshDeferred, retryable: true },
]);
assert.doesNotMatch(JSON.stringify(deferred.receipt), /do-not-expose|customer note/);

const wakeDeferred = await settleOptionalWorkerWake(
  deferred.receipt,
  async () => {
    throw sensitiveError;
  }
);
assert.equal(wakeDeferred.refreshRequired, true);
assert.deepEqual(
  wakeDeferred.warnings.map((warning) => warning.code),
  [
    MUTATION_WARNING_CODES.refreshDeferred,
    MUTATION_WARNING_CODES.workerWakeDeferred,
  ]
);
assert.doesNotMatch(JSON.stringify(wakeDeferred), /do-not-expose|customer note/);

const duplicateWake = await settleOptionalWorkerWake(wakeDeferred, () => {
  throw new Error("another raw error");
});
assert.equal(duplicateWake.warnings.length, 2);

const { beginWorkerShutdown } = await import(
  "@/quickhack_server/workers/shutdown-runtime"
);
const { wakeWorkerManager } = await import(
  "@/quickhack_server/workers/manager"
);
beginWorkerShutdown("mutation-receipt-contract");
const shutdownWake = await settleOptionalWorkerWake(committed, () =>
  wakeWorkerManager()
);
assert.equal(shutdownWake.refreshRequired, false);
assert.deepEqual(shutdownWake.warnings, [
  { code: MUTATION_WARNING_CODES.workerWakeDeferred, retryable: true },
]);

for (const routePath of [
  "quickhack_server/api/auth/me.ts",
  "quickhack_server/api/inbound/batches.ts",
  "quickhack_server/api/inbound/purchase-prices.ts",
  "quickhack_server/api/catalog/product-criteria.ts",
  "quickhack_server/api/supplies/supplies.ts",
]) {
  const source = read(routePath);
  assert.match(source, /createMutationReceipt/);
  assert.match(source, /settleOptionalMutationRefresh/);
}

for (const routePath of [
  "quickhack_server/api/invoices/manual-candidates.ts",
  "quickhack_server/api/invoices/issue-batch-carrier-registration.ts",
  "quickhack_server/api/invoices/issue-batch-channel-submit.ts",
  "quickhack_server/api/invoices/issue-batches.ts",
  "quickhack_server/api/admin/sales-channel-write-requests.ts",
]) {
  const source = read(routePath);
  assert.match(source, /createMutationReceipt/);
  assert.match(source, /settleOptionalWorkerWake/);
  assert.ok(
    source.indexOf("createMutationReceipt") <
      source.lastIndexOf("settleOptionalWorkerWake"),
    `${routePath} must establish the authoritative receipt before optional wake`
  );
}

const adminUsers = read("quickhack_server/api/admin/users.ts");
assert.doesNotMatch(adminUsers, /loadUserSnapshot/);
assert.match(adminUsers, /oneTimeResultDelivered: true/);
assert.match(adminUsers, /recoveryCodes: generated\.recoveryCodes/);

const manualCandidates = read(
  "quickhack_server/api/invoices/manual-candidates.ts"
);
const submissionIndex = manualCandidates.indexOf("channelSubmission = await");
const submissionCatchIndex = manualCandidates.indexOf(
  "} catch (error)",
  submissionIndex
);
const wakeSettlementIndex = manualCandidates.lastIndexOf(
  "settleOptionalWorkerWake"
);
assert.ok(
  submissionIndex >= 0 &&
    submissionIndex < submissionCatchIndex &&
    submissionCatchIndex < wakeSettlementIndex
);

for (const clientPath of [
  "quickhack_client/components/app-shell/device-workspace.tsx",
  "quickhack_client/components/inbound/inbound-batch-plan-view.tsx",
  "quickhack_client/components/inbound/purchase-price-criteria-rate-view.tsx",
  "quickhack_client/components/catalog/product-criteria-manager-view.tsx",
  "quickhack_client/components/supplies/supplies-management-view.tsx",
]) {
  assert.match(read(clientPath), /refreshRequired/);
}

for (const clientPath of [
  "quickhack_client/components/invoice/invoice-manual-issue-view.tsx",
  "quickhack_client/components/invoice/invoice-replacement-recovery.ts",
  "quickhack_client/components/shipment/shipment-order-list-view.tsx",
  "quickhack_client/components/admin/sales-channel-write-review-view.tsx",
  "quickhack_client/components/admin/sales-channel-sync-check-view.tsx",
]) {
  assert.match(read(clientPath), /mutationWakeDeferred/);
}

console.log("Mutation receipt contract passed.");
