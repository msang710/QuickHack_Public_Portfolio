import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const panel = read(
  "quickhack_client/components/statistics/inventory-statistics-panel.tsx"
);
const presentation = read(
  "quickhack_client/components/statistics/inventory-statistics-presentation.ts"
);
const view = read(
  "quickhack_client/components/statistics/statistics-view.tsx"
);
const menu = read(
  "quickhack_client/components/app-shell/device-workspace-menu.ts"
);

assert.match(panel, /buildStatisticsPeriodRequestQuery/);
assert.match(panel, /\/api\/statistics\/inventory/);
assert.doesNotMatch(panel, /\?period=/);
assert.doesNotMatch(panel, /selectedPeriod/);
assert.match(panel, /new AbortController\(\)/);
assert.match(panel, /requestSequence/);
assert.match(panel, /requestId !== requestSequence\.current/);
assert.match(panel, /requestState\.requestKey === requestKey/);
assert.match(panel, /retryRevision/);
assert.match(panel, /cache: "no-store"/);
assert.match(panel, /aria-busy=/);
assert.match(panel, /같은 조건으로 통계를 다시 확인하고 있습니다/);
assert.match(panel, /다시 시도/);

for (const preset of ['value: "30d"', 'value: "90d"', 'value: "1y"', 'value: "all"']) {
  assert.match(presentation, new RegExp(preset));
}

for (const section of [
  "기준 재고 상태 구성",
  "집계 기준과 복원 범위",
  "재고 연령과 장기 재고 부담",
  "일별 창고 재고와 판매",
  "일별 재고 유입·이탈",
  "재고 상태 이동",
  "SKU별 판매 회전율",
]) {
  assert.match(panel, new RegExp(section));
}

assert.match(panel, /StatisticsCalculationScope calculation=\{data\.calculation\}/);
assert.match(panel, /data\.asOf\.date/);
assert.match(panel, /cutoffExcludedMovementCount/);
assert.match(panel, /asOfPriceExcludedCount/);
assert.doesNotMatch(panel, /data\.current/);

for (const availability of [
  '"READY"',
  '"EMPTY"',
  '"PARTIAL"',
]) {
  assert.match(presentation, new RegExp(availability));
}

for (const forbiddenPanelConcept of [
  "devices",
  "filteredDevices",
  "IMEI",
  "operation_key",
  "movementId",
]) {
  assert.equal(
    panel.includes(forbiddenPanelConcept),
    false,
    `Inventory statistics panel contains raw concept: ${forbiddenPanelConcept}`
  );
}

assert.doesNotMatch(view, /SearchInput/);
assert.match(
  view,
  /<InventoryStatisticsPanel[\s\S]{0,120}periodSelection=\{periodSelection\}/
);
assert.doesNotMatch(view, /const filteredDevices/);
assert.doesNotMatch(view, /label="평균 재고 기간"/);
assert.doesNotMatch(view, /title="다음 통계 후보"/);
assert.match(
  menu,
  /현재 재고 구성, 장기 재고 부담, 기간 흐름과 판매 회전율을 확인합니다\./
);

console.log("Inventory statistics UI contracts verified.");
