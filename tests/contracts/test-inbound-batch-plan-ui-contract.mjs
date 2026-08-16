import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const sharedContract = read(
  "quickhack_shared/inbound/inbound-reconciliation.ts"
);
const queryService = read(
  "quickhack_server/inbound/inbound-batch-plan-query-service.ts"
);
const route = read("quickhack_server/api/inbound/batches.ts");
const view = read(
  "quickhack_client/components/inbound/inbound-batch-plan-view.tsx"
);

assert.match(
  sharedContract,
  /export type InboundBatchPlanRowDto/
);
assert.match(
  sharedContract,
  /historicalInboundQuantity: number/
);
assert.match(sharedContract, /revision: number/);
assert.match(
  queryService,
  /loadInboundReconciliationSnapshot\(tx\)/
);
assert.match(queryService, /runConsistentReadSnapshot\(/);
assert.match(
  queryService,
  /metadataByBatch/
);
assert.doesNotMatch(
  queryService,
  /statusCounts:\s*batch\.statusCounts|devices:\s*batch\.devices/,
  "The initial batch list must not project PG details or the full status map."
);

assert.equal(
  route.match(/listInboundBatchPlanRows\(prisma\)/g)?.length,
  4,
  "GET and all three mutation responses must use the same batch plan query."
);
assert.doesNotMatch(
  route,
  /listInboundBatches\(prisma\)/,
  "The route must not fall back to the historical inbound count list."
);
assert.match(route, /operationName: "inbound\.batch\.read"/);
assert.match(route, /traceOperationSpan\("SERVICE_READ"/);

const expectedColumnOrder = [
  'key: "batchDate"',
  'key: "batchNo"',
  'key: "expectedQuantity"',
  'key: "linkedQuantity"',
  'key: "supplierReturnQuantity"',
  'key: "normalInboundTargetQuantity"',
  'key: "arrivalDifference"',
  'key: "note"',
  'key: "actions"',
];
let previousPosition = -1;

for (const column of expectedColumnOrder) {
  const position = view.indexOf(column, previousPosition + 1);
  assert.ok(position > previousPosition, `${column} is out of order.`);
  previousPosition = position;
}

assert.match(
  view,
  /import type \{ InboundBatchPlanRowDto \}/
);
assert.match(
  view,
  /batch\.historicalInboundQuantity > 0/
);
assert.match(view, /expectedRevision: editingBatchRevision/);
assert.doesNotMatch(
  view,
  /disabled=\{isSaving \|\| batch\.linkedQuantity > 0\}/,
  "Current linked quantity must not control historical deletion safety."
);
assert.match(view, /const INBOUND_BATCH_FORM_ID = "inbound\.batch-plan"/);
assert.match(view, /useUnsavedForm\(\{/);
assert.match(view, /label: "현재 연결"/);
assert.match(view, /label: "매입처 반품"/);
assert.match(view, /label: "정상 입고 대상"/);
assert.match(view, /label: "차이"/);

console.log("Inbound batch plan UI contracts verified.");
