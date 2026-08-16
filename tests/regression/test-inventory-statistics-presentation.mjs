import assert from "node:assert/strict";
import {
  buildInventoryTransitionMatrix,
  formatInventoryCurrency,
  formatInventoryNumber,
  formatInventoryPurchaseCost,
  formatInventoryQuantity,
  formatInventoryTurnover,
  inventoryIntegrityMessage,
  inventoryPeriodLabel,
  inventoryStatusGroupLabel,
} from "../../quickhack_client/components/statistics/inventory-statistics-presentation.ts";

assert.equal(formatInventoryNumber(0), "0");
assert.equal(formatInventoryNumber(null), "집계 불가");
assert.equal(formatInventoryQuantity(0), "0대");
assert.equal(formatInventoryQuantity(null), "집계 불가");
assert.equal(formatInventoryCurrency(0), "₩0");
assert.equal(formatInventoryCurrency(null), "집계 불가");

assert.deepEqual(
  formatInventoryTurnover({
    value: 0,
    soldQuantity: 0,
    averageWarehouseQuantity: 4,
  }),
  {
    value: "0회",
    detail: "판매 0대 ÷ 일평균 재고 4대",
  },
  "실제 0회전은 집계 불가와 구분해야 합니다."
);
assert.deepEqual(
  formatInventoryTurnover({
    value: null,
    soldQuantity: 1,
    averageWarehouseQuantity: null,
    unavailableReason: "기간 재고 원장을 복원할 수 없습니다.",
  }),
  {
    value: "집계 불가",
    detail: "기간 재고 원장을 복원할 수 없습니다.",
  }
);

assert.deepEqual(
  formatInventoryPurchaseCost({
    amount: 350000,
    pricedQuantity: 2,
    totalQuantity: 3,
    missingPriceQuantity: 1,
    coveragePercent: 66.7,
  }),
  {
    value: "₩350,000",
    detail: "2대 확인 · 1대 미확인 · 66.7% 확인",
  }
);
assert.deepEqual(
  formatInventoryPurchaseCost({
    amount: null,
    pricedQuantity: 0,
    totalQuantity: 2,
    missingPriceQuantity: 2,
    coveragePercent: 0,
  }),
  {
    value: "확인 금액 없음",
    detail: "0대 확인 · 2대 미확인 · 0% 확인",
  },
  "가격이 모두 없는 재고는 정합성 실패가 아니라 미확인으로 표시해야 합니다."
);
assert.deepEqual(
  formatInventoryPurchaseCost({
    amount: null,
    pricedQuantity: 0,
    totalQuantity: 0,
    missingPriceQuantity: 0,
    coveragePercent: 0,
  }),
  {
    value: "₩0",
    detail: "대상 재고 없음",
  },
  "정상 빈 재고는 집계 불가와 구분해야 합니다."
);
assert.deepEqual(
  formatInventoryPurchaseCost({
    amount: null,
    pricedQuantity: null,
    totalQuantity: null,
    missingPriceQuantity: null,
    coveragePercent: null,
  }),
  {
    value: "집계 불가",
    detail: "매입원가 집계 불가",
  }
);

assert.equal(inventoryPeriodLabel("90d"), "최근 90일");
assert.equal(inventoryPeriodLabel("custom"), "직접 지정");
assert.equal(inventoryStatusGroupLabel("TRACKING_EXCEPTION"), "배송 추적 예외");
assert.equal(
  inventoryIntegrityMessage("EMPTY", "period"),
  "선택 기간에 집계할 재고 흐름과 판매가 없습니다."
);
assert.match(inventoryIntegrityMessage("PARTIAL", "aging"), /수치를 숨겼습니다/);
assert.equal(inventoryIntegrityMessage("READY", "period"), null);

assert.deepEqual(
  buildInventoryTransitionMatrix([
    { fromGroup: null, toGroup: "SELLABLE", quantity: 4 },
    { fromGroup: "SELLABLE", toGroup: "ORDER_ALLOCATED", quantity: 3 },
    { fromGroup: "ORDER_ALLOCATED", toGroup: null, quantity: 1 },
  ]),
  {
    columns: ["이전 상태", "재고 삭제", "판매 가능", "주문 배정"],
    rows: [
      ["신규 생성", 0, 4, 0],
      ["판매 가능", 0, 0, 3],
      ["주문 배정", 1, 0, 0],
    ],
  },
  "상태 이동 matrix는 이미 집계된 행을 재배치만 해야 합니다."
);

console.log("Inventory statistics presentation semantics verified.");
