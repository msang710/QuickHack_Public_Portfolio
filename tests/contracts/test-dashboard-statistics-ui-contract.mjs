import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const sharedContract = read("quickhack_shared/statistics/statistics.ts");
const statisticsService = read(
  "quickhack_server/statistics/statistics-service.ts"
);
const route = read("quickhack_server/api/statistics/dashboard.ts");
const workspace = read(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
const navigationKo = read("quickhack_client/i18n/catalogs/ko/navigation.ts");

for (const field of [
  "inboundBatchId: number",
  "batchDate: string",
  "linkedQuantity: number",
  "normalInboundTargetQuantity: number",
  "supplierReturnQuantity: number",
  "arrivalDifference: number",
  "shortageQuantity: number",
  "excessQuantity: number",
]) {
  assert.match(sharedContract, new RegExp(field));
}

assert.match(statisticsService, /runConsistentReadSnapshot\(/);
assert.match(statisticsService, /loadInboundReconciliationSnapshot\(client, \{/);
assert.match(statisticsService, /loadInboundInspectionEvidence\(/);
assert.match(statisticsService, /batchDate: today/);
assert.match(
  statisticsService,
  /batch\.statusCounts\[INBOUND_STATUS\.inspected\]/
);
assert.doesNotMatch(
  statisticsService,
  /expectedQuantityByBatch/,
  "대시보드가 batch_no별 예정 수량 맵을 다시 만들면 안 됩니다."
);
assert.doesNotMatch(
  statisticsService,
  /include:\s*\{\s*devices:\s*\{\s*include:\s*\{\s*inbounds:/,
  "검수 overlay가 최신 inbound를 별도로 다시 조회하면 안 됩니다."
);

assert.match(route, /setOperationTraceTargetCount\(data\.batches\.length\)/);
assert.match(route, /code: "DASHBOARD_LOAD_FAILED"/);

assert.match(workspace, /key=\{batch\.inboundBatchId\}/);
assert.match(workspace, /t\("dashboard\.batch", \{ date: batch\.batchDate, batch: batch\.batchNo \}\)/);
assert.match(workspace, /label=\{t\("dashboard\.currentlyLinked"\)\}/);
assert.match(workspace, /label=\{t\("dashboard\.normalInbound"\)\}/);
assert.match(workspace, /label=\{t\("dashboard\.supplierReturn"\)\}/);
assert.match(workspace, /t\("dashboard\.empty"\)/);
assert.match(navigationKo, /"loadFailed": "대시보드 통계를 불러오지 못했습니다\."/);
assert.match(navigationKo, /"empty": "오늘 등록된 입고 차수가 없습니다\."/);
assert.match(workspace, /!isLoading && !errorMessage && data/);
assert.doesNotMatch(
  workspace,
  /data\?\.summary\.expectedQuantity \?\? summary\.total/,
  "통계 실패를 전체 재고 수량으로 대체하면 안 됩니다."
);
assert.doesNotMatch(
  workspace,
  /data\?\.summary\.(?:inspectedToday|normalInboundCount|supplierReturnCount) \?\? 0/,
  "통계 로딩이나 실패를 정상적인 0으로 표시하면 안 됩니다."
);

console.log("Dashboard statistics UI contracts verified.");
