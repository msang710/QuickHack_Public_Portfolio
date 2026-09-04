import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const panel = read(
  "quickhack_client/components/statistics/sales-statistics-panel.tsx"
);
const calculationScope = read(
  "quickhack_client/components/statistics/statistics-calculation-scope.tsx"
);
const presentation = read(
  "quickhack_client/components/statistics/sales-statistics-presentation.ts"
);
const view = read(
  "quickhack_client/components/statistics/statistics-view.tsx"
);
const api = read("quickhack_server/api/statistics/sales.ts");
const service = read(
  "quickhack_server/statistics/sales-statistics-service.ts"
);
const legacyService = read(
  "quickhack_server/statistics/statistics-service.ts"
);
const koStatistics = read("quickhack_client/i18n/catalogs/ko/statistics.ts");

assert.match(panel, /\/api\/statistics\/sales/);
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
assert.doesNotMatch(panel, /usingWorkbookPreview/);

for (const section of [
  "집계 원천과 신뢰도",
  "확정 판매",
  "판매금액",
  "상품 매출총이익",
  "평균 판매 소요",
  "월별 확정 판매량",
  "월별 판매 성과",
  "상품별 판매 성과",
  "판매 구성",
  "가격대와 판매 등급",
  "판매 소요기간 구성",
  "판매 채널 성과",
]) {
  assert.match(koStatistics, new RegExp(section));
}

for (const forbiddenConcept of [
  "예시값",
  "수신인",
  "수신인 성별",
  "지역별 주문",
  "주문 시간대",
  "순이익",
  "영업이익",
  "PG 검색",
  "IMEI",
]) {
  assert.equal(
    panel.includes(forbiddenConcept),
    false,
    `Sales statistics panel contains out-of-scope concept: ${forbiddenConcept}`
  );
}

assert.match(panel, /formatSalesGrossProfit/);
assert.match(panel, /formatSalesLeadTime/);
assert.match(panel, /StatisticsCoverageItem/);
assert.match(panel, /StatisticsCalculationScope/);
assert.match(calculationScope, /useTranslations\("statistics\.calculationScope"\)/);
for (const label of ["실시간 계산", "집계 기간", "비교 기간", "데이터 마감"]) {
  assert.match(koStatistics, new RegExp(label));
}
assert.match(panel, /minWidth=\{1700\}/);
assert.match(panel, /maxHeight=\{560\}/);
assert.match(panel, /gridTemplateColumns=/);
assert.match(
  panel,
  /md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6/
);
assert.match(presentation, /base\.formatAmount/);
assert.match(presentation, /metric\.marginPercent === null/);

assert.match(
  view,
  /<SalesStatisticsPanel[\s\S]{0,120}periodSelection=\{periodSelection\}/
);
assert.doesNotMatch(view, /SearchInput/);
assert.doesNotMatch(view, /normalizedQuery/);
assert.doesNotMatch(panel, /matchedSaleRecordCount/);

assert.match(api, /canAccessRole\(user\.role, "LEADER"\)/);
assert.match(
  api,
  /statistics\/sales-statistics-service/
);
assert.match(service, /prisma\.sales_records\.findMany/);
assert.match(service, /sale_status/);
assert.match(service, /ELIGIBLE_SALE_STATUSES/);
assert.doesNotMatch(service, /order_items/);
assert.doesNotMatch(service, /receiver/);
assert.doesNotMatch(service, /external_order_id/);
assert.doesNotMatch(legacyService, /getSalesStatisticsData/);

console.log("Sales statistics UI and source contracts verified.");
