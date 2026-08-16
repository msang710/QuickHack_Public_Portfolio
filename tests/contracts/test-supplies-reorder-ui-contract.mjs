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

for (const contract of [
  "isForecastOutdated",
  "latestRecommendedQuantity",
  "예측 갱신 필요",
  "최신 권장",
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
  "완료 이력 더 보기",
]) {
  assert.ok(
    view.includes(contract),
    `The reorder UI is missing the open/history pagination contract: ${contract}.`
  );
}

console.log("Supply reorder forecast freshness UI contract verified.");
