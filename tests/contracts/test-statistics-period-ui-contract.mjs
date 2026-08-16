import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const toolbar = read(
  "quickhack_client/components/statistics/statistics-period-toolbar.tsx"
);
const view = read(
  "quickhack_client/components/statistics/statistics-view.tsx"
);
const workspace = read(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
const panels = [
  "purchase",
  "inventory",
  "sales",
  "returns",
].map((name) =>
  read(
    `quickhack_client/components/statistics/${name}-statistics-panel.tsx`
  )
);

assert.match(toolbar, /aria-label="통계 조회 기간"/);
assert.equal((toolbar.match(/type="date"/g) ?? []).length, 2);
assert.match(toolbar, /max=\{currentDefaultPeriod\.dataCutoffDate\}/);
assert.match(toolbar, /resolveClosedStatisticsPeriod/);
assert.match(toolbar, /기간 적용/);
assert.match(toolbar, /기본 90일로 되돌리기/);
assert.match(toolbar, /role="alert"/);
assert.match(toolbar, /kind: "custom"/);
assert.match(toolbar, /kind: "default"/);

assert.match(view, /<StatisticsPeriodToolbar/);
assert.match(view, /selection=\{periodSelection\}/);
assert.match(view, /onSelectionChange=\{onPeriodSelectionChange\}/);

assert.match(
  workspace,
  /useState<StatisticsPeriodSelection>\([\s\S]{0,120}DEFAULT_STATISTICS_PERIOD_SELECTION/
);
assert.equal(
  (
    workspace.match(
      /periodSelection=\{statisticsPeriodSelection\}/g
    ) ?? []
  ).length,
  4
);
assert.equal(
  (
    workspace.match(
      /onPeriodSelectionChange=\{setStatisticsPeriodSelection\}/g
    ) ?? []
  ).length,
  4
);
assert.match(
  workspace,
  /key=\{`\$\{selectedMenuId\}:\$\{contentRefreshRevision\}`\}/
);

for (const panel of panels) {
  assert.match(panel, /buildStatisticsPeriodRequestQuery/);
  assert.match(panel, /periodSelection: StatisticsPeriodSelection/);
  assert.match(panel, /requestKey/);
  assert.match(panel, /requestId !== requestSequence\.current/);
}

assert.doesNotMatch(panels[1], /selectedPeriod/);
assert.doesNotMatch(panels[1], /\?period=/);

console.log("Common statistics period UI contracts verified.");
