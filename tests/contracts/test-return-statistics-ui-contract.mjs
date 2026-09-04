import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const panel = read(
  "quickhack_client/components/statistics/returns-statistics-panel.tsx"
);
const calculationScope = read(
  "quickhack_client/components/statistics/statistics-calculation-scope.tsx"
);
const view = read(
  "quickhack_client/components/statistics/statistics-view.tsx"
);
const shared = read("quickhack_shared/statistics/statistics.ts");
const koStatistics = read("quickhack_client/i18n/catalogs/ko/statistics.ts");
const koNavigation = read("quickhack_client/i18n/catalogs/ko/navigation.ts");

assert.match(shared, /export type ReturnCustomerOverview/);
assert.match(shared, /overview: ReturnCustomerOverview/);

assert.match(panel, /\/api\/statistics\/returns/);
assert.match(panel, /new AbortController\(\)/);
assert.match(panel, /requestSequence/);
assert.match(panel, /requestId !== requestSequence\.current/);
assert.match(panel, /buildStatisticsPeriodRequestQuery/);
assert.match(panel, /requestState\.requestKey === requestKey/);
assert.match(panel, /retryRevision/);
assert.match(panel, /t\("loading\.retry"\)/);
assert.match(panel, /t\("loading\.refresh"\)/);
assert.match(panel, /cache: "no-store"/);
assert.match(panel, /aria-busy=/);
assert.doesNotMatch(panel, /buildPreviewSalesStatistics/);
assert.match(panel, /StatisticsCalculationScope/);
assert.match(calculationScope, /useTranslations\("statistics\.calculationScope"\)/);
assert.match(koStatistics, /한국 시간 기준 어제까지/);

for (const section of [
  "데이터 기준과 신뢰도",
  "30일 고객 반품 요청률",
  "고객 반품 발생 개요",
  "판매 cohort 고객 반품 요청률",
  "상품별 반품 비교",
  "반품 사유",
  "사유별 검수 결과",
  "반품 검수 결과",
  "반품 연관 금액",
  "처리 소요 시간",
  "출고 전 취소",
  "교환",
]) {
  assert.match(koStatistics, new RegExp(section));
}

for (const forbiddenUserFacingConcept of [
  "손실",
  "순이익",
  "매입처 반품",
  "worker",
  "회수 위치",
  "회수 배송",
]) {
  assert.equal(
    panel.includes(forbiddenUserFacingConcept),
    false,
    `Return statistics panel contains out-of-scope concept: ${forbiddenUserFacingConcept}`
  );
}

assert.match(
  view,
  /<ReturnsStatisticsPanel[\s\S]{0,120}periodSelection=\{periodSelection\}/
);
assert.doesNotMatch(view, /SearchInput/);
assert.doesNotMatch(view, /normalizedQuery/);
assert.doesNotMatch(
  view,
  /mode === "returns"[\s\S]{0,100}<EmptyStatisticsPanel/
);
assert.match(
  koNavigation,
  /고객 반품, 출고 전 취소, 교환 통계를 확인합니다\./
);

console.log("Return statistics UI contracts verified.");
