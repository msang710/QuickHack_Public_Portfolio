import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const view = fs.readFileSync(
  path.join(
    process.cwd(),
    "quickhack_client/components/supplies/supplies-management-view.tsx"
  ),
  "utf8"
);
const koreanCatalog = fs.readFileSync(
  path.join(process.cwd(), "quickhack_client/i18n/catalogs/ko/supplies.ts"),
  "utf8"
);

for (const contract of [
  "isForecastOutdated",
  "latestRecommendedQuantity",
  't("reorder.forecastOutdated")',
  't("reorder.latestRecommended"',
]) {
  assert(view.includes(contract), `The reorder UI is missing ${contract}.`);
}

assert(
  view.includes("reorder.isForecastOutdated") &&
    view.includes("reorder.latestRecommendedQuantity"),
  "The reorder warning is not driven by the server freshness contract."
);

assert(
  view.includes("expectedRequestStatus: reorderBaseline.requestStatus"),
  "The reorder update does not carry the selected status snapshot for CAS."
);
assert.ok(
  view.includes("expectedRevision"),
  "The reorder form does not submit revision ownership."
);
for (const contract of [
  "openReorders",
  "reorderHistory",
  "reorderHistoryPage",
  't("reorder.historyMore")',
]) {
  assert.ok(
    view.includes(contract),
    `The reorder UI is missing the open/history pagination contract: ${contract}.`
  );
}
for (const label of ["예측 갱신 필요", "최신 권장", "완료 이력 더 보기"]) {
  assert.ok(koreanCatalog.includes(label), `Missing Korean reorder label: ${label}`);
}

console.log("Supply reorder forecast freshness UI contract verified.");
