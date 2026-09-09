import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const panel = read(
  "quickhack_client/components/statistics/purchase-statistics-panel.tsx"
);
const calculationScope = read(
  "quickhack_client/components/statistics/statistics-calculation-scope.tsx"
);
const presentation = read(
  "quickhack_client/components/statistics/purchase-statistics-presentation.ts"
);
const commonPresentation = read(
  "quickhack_client/components/statistics/statistics-metric-presentation.ts"
);
const view = read(
  "quickhack_client/components/statistics/statistics-view.tsx"
);
const visuals = read(
  "quickhack_client/components/statistics/statistics-visuals.tsx"
);
const formLayout = read(
  "quickhack_client/components/ui/form-layout.tsx"
);
const koStatistics = read("quickhack_client/i18n/catalogs/ko/statistics.ts");

assert.match(panel, /\/api\/statistics\/purchases/);
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

for (const section of [
  "데이터 기준과 신뢰도",
  "확정 매입 회차",
  "매입처 반품률",
  "월별 매입 결과 추이",
  "월별 매입 금액",
  "상품별 매입 cohort 성과",
  "30일 판매전환",
  "60일 판매전환",
  "90일 판매전환",
  "매입처 성과",
  "고객 반품 확정률",
  "가격 정책 결과",
  "입고 검수 품질",
  "외관 하자 항목",
  "기능 하자 항목",
  "매입 처리시간",
]) {
  assert.match(koStatistics, new RegExp(section));
}

for (const forbiddenUserFacingConcept of [
  "현재 처리",
  "다음 작업",
  "worker",
  "예시값",
  "손실",
  "순이익",
  "수신인",
  "전화번호",
  "배송주소",
]) {
  assert.equal(
    panel.includes(forbiddenUserFacingConcept),
    false,
    `Purchase statistics panel contains out-of-scope concept: ${forbiddenUserFacingConcept}`
  );
}

assert.match(panel, /formatPurchaseRate\(row\.supplierReturnRate\)/);
assert.match(panel, /row\.customerReturnConfirmationRate/);
assert.match(panel, /maturityPending: true/);
assert.match(panel, /formatPurchaseAmount\(row\.purchaseAmount\)/);
assert.match(panel, /StatisticsCoverageItem/);
assert.match(panel, /StatisticsCalculationScope/);
assert.match(calculationScope, /useTranslations\("statistics\.calculationScope"\)/);
assert.match(koStatistics, /기본 90일/);
assert.match(koStatistics, /직접 지정/);
assert.match(panel, /minWidth=\{1480\}/);
assert.match(panel, /maxHeight=\{560\}/);
assert.match(panel, /gridTemplateColumns=/);
assert.match(
  panel,
  /2xl:grid-cols-\[minmax\(0,1\.15fr\)_minmax\(520px,0\.85fr\)\]/
);
assert.match(
  panel,
  /md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5/
);

assert.match(
  presentation,
  /unavailableValue: options\.maturityPending \? t\("observing"\) : "-"/
);
for (const label of ["기준가 적용", "기준가 조정", "수동 입력", "과거 미기록"]) {
  assert.match(koStatistics, new RegExp(label));
}
assert.match(commonPresentation, /metric\.value === null/);
assert.match(commonPresentation, /metric\.amount === null/);
assert.match(commonPresentation, /metric\.sampleCount === 0/);

assert.match(visuals, /export function StatisticsCoverageItem/);
assert.match(visuals, /description\?: string/);
assert.match(visuals, /description=\{description\}/);
assert.match(visuals, /maxHeight\?: number \| string/);
assert.match(visuals, /sticky top-0 z-10/);
assert.match(
  formLayout,
  /flex min-h-0 min-w-0 flex-col gap-3/
);

assert.match(
  view,
  /<PurchaseStatisticsPanel[\s\S]{0,120}periodSelection=\{periodSelection\}/
);
assert.doesNotMatch(view, /SearchInput/);
assert.doesNotMatch(view, /normalizedQuery/);
assert.doesNotMatch(
  view,
  /mode === "purchase"[\s\S]{0,100}<EmptyStatisticsPanel/
);

console.log("Purchase statistics UI contracts verified.");
