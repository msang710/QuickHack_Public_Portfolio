import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const visuals = read(
  "quickhack_client/components/statistics/statistics-visuals.tsx"
);
const statisticsView = read(
  "quickhack_client/components/statistics/statistics-view.tsx"
);

for (const exportedVisual of [
  "export function SummaryTile",
  "export function EmptyDataState",
  "export function StatisticsCoverageItem",
  "export function BarList",
  "export function CompactTable",
  "export function LineTrendChart",
  "export function MultiLineTrendChart",
  "export function ColumnChart",
  "export function DonutChart",
]) {
  assert.match(visuals, new RegExp(exportedVisual));
}

assert.match(visuals, /export function splitContinuousSegments/);
assert.match(visuals, /export function buildAxisLabelIndexes/);
assert.match(visuals, /if \(point === null\)/);
assert.match(visuals, /role="img"/);
assert.match(visuals, /aria-label=/);
assert.match(visuals, /className="overflow-auto rounded-md border bg-background"/);
assert.match(visuals, /gridTemplateColumns/);
assert.match(visuals, /wrapCells/);
assert.match(visuals, /maxHeight\?: number \| string/);
assert.match(visuals, /sticky top-0 z-10/);
assert.match(visuals, /description\?: string/);
assert.match(visuals, /description=\{description\}/);
assert.match(visuals, /maxAxisLabels\?: number/);
assert.match(visuals, /showPointMarkers\?: boolean/);
assert.match(visuals, /visibleLabelIndexes\.has\(index\)/);

for (const removedPrivateVisual of [
  "function SummaryTile",
  "function EmptyDataState",
  "function BarList",
  "function CompactTable",
  "function LineTrendChart",
  "function ColumnChart",
  "function DonutChart",
]) {
  assert.doesNotMatch(statisticsView, new RegExp(removedPrivateVisual));
}

assert.doesNotMatch(statisticsView, /buildPreviewSalesStatistics/);
assert.doesNotMatch(statisticsView, /usingWorkbookPreview/);
assert.match(statisticsView, /<SalesStatisticsPanel/);

console.log("Shared statistics visual contracts verified.");
