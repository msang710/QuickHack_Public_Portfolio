import type {
  InventoryStatisticsAgeBucketKey,
  InventoryStatisticsPeriodPreset,
  InventoryStatisticsPeriodTransitionRow,
  InventoryStatisticsPurchaseCostMetric,
  InventoryStatisticsStatusGroupKey,
  InventoryStatisticsTurnoverMetric,
} from "@/quickhack_shared/statistics/statistics";

export const inventoryStatisticsPeriodOptions: Array<{
  value: InventoryStatisticsPeriodPreset;
  label: string;
}> = [
  { value: "30d", label: "최근 30일" },
  { value: "90d", label: "최근 90일" },
  { value: "1y", label: "최근 1년" },
  { value: "all", label: "전체 기간" },
];

const statusGroupLabels: Record<
  InventoryStatisticsStatusGroupKey,
  string
> = {
  SELLABLE: "판매 가능",
  ORDER_ALLOCATED: "주문 배정",
  SALES_RESTRICTED: "판매 제한·점검",
  DELIVERING: "배송 중",
  TRACKING_EXCEPTION: "배송 추적 예외",
  FINAL_DELIVERY: "판매 종결",
  CLAIM_LOCATION_UNKNOWN: "고객 클레임 진행·위치 미확정",
};

const ageBucketLabels: Record<InventoryStatisticsAgeBucketKey, string> = {
  DAYS_0_29: "0~29일",
  DAYS_30_59: "30~59일",
  DAYS_60_89: "60~89일",
  DAYS_90_PLUS: "90일 이상",
};

export function inventoryStatusGroupLabel(
  key: InventoryStatisticsStatusGroupKey
) {
  return statusGroupLabels[key];
}

export function inventoryAgeBucketLabel(
  key: InventoryStatisticsAgeBucketKey
) {
  return ageBucketLabels[key];
}

export function inventoryPeriodLabel(
  preset: InventoryStatisticsPeriodPreset | "custom"
) {
  if (preset === "custom") {
    return "직접 지정";
  }

  return (
    inventoryStatisticsPeriodOptions.find((option) => option.value === preset)
      ?.label ?? preset
  );
}

export function formatInventoryNumber(value: number | null) {
  return value === null ? "집계 불가" : value.toLocaleString("ko-KR");
}

export function formatInventoryQuantity(value: number | null) {
  return value === null
    ? "집계 불가"
    : `${value.toLocaleString("ko-KR")}대`;
}

export function formatInventoryCurrency(value: number | null) {
  if (value === null) {
    return "집계 불가";
  }

  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0,
    style: "currency",
    currency: "KRW",
  }).format(value);
}

export function formatInventoryPercent(value: number | null) {
  return value === null ? "확인 불가" : `${value.toLocaleString("ko-KR")}%`;
}

export function formatInventoryPurchaseCost(
  metric: InventoryStatisticsPurchaseCostMetric
) {
  if (metric.totalQuantity === null) {
    return {
      value: "집계 불가",
      detail: "매입원가 집계 불가",
    };
  }

  if (metric.totalQuantity === 0) {
    return {
      value: "₩0",
      detail: "대상 재고 없음",
    };
  }

  return {
    value:
      metric.amount === null
        ? "확인 금액 없음"
        : formatInventoryCurrency(metric.amount),
    detail: `${formatInventoryQuantity(
      metric.pricedQuantity
    )} 확인 · ${formatInventoryQuantity(
      metric.missingPriceQuantity
    )} 미확인 · ${formatInventoryPercent(metric.coveragePercent)} 확인`,
  };
}

export function formatInventoryTurnover(
  metric: InventoryStatisticsTurnoverMetric
) {
  return {
    value:
      metric.value === null
        ? "집계 불가"
        : `${metric.value.toLocaleString("ko-KR", {
            maximumFractionDigits: 3,
          })}회`,
    detail:
      metric.value === null
        ? metric.unavailableReason ?? "회전율을 계산할 수 없습니다."
        : `판매 ${formatInventoryQuantity(
            metric.soldQuantity
          )} ÷ 일평균 재고 ${formatInventoryQuantity(
            metric.averageWarehouseQuantity
          )}`,
  };
}

export function formatInventoryGeneratedAt(value: string) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(parsed);
}

export function formatInventoryPeriodRange(
  fromDate: string,
  toDate: string,
  dayCount: number
) {
  return `${fromDate} ~ ${toDate} · ${dayCount.toLocaleString("ko-KR")}일`;
}

export function inventoryIntegrityMessage(
  availability: "READY" | "EMPTY" | "PARTIAL",
  area: "asOf" | "aging" | "period"
) {
  if (availability === "READY") {
    return null;
  }

  if (availability === "EMPTY") {
    return area === "period"
      ? "선택 기간에 집계할 재고 흐름과 판매가 없습니다."
      : "집계할 재고가 없습니다.";
  }

  const areaLabel =
    area === "asOf"
      ? "기준일 재고"
      : area === "aging"
        ? "재고 연령"
        : "기간 재고 흐름";

  return `${areaLabel} 원장의 일부 정합성을 확인할 수 없어 영향을 받는 수치를 숨겼습니다.`;
}

export type InventoryTransitionMatrix = {
  columns: string[];
  rows: Array<Array<string | number>>;
};

export function buildInventoryTransitionMatrix(
  transitions: InventoryStatisticsPeriodTransitionRow[]
): InventoryTransitionMatrix {
  const keys: Array<InventoryStatisticsStatusGroupKey | null> = [
    null,
    "SELLABLE",
    "ORDER_ALLOCATED",
    "SALES_RESTRICTED",
    "DELIVERING",
    "TRACKING_EXCEPTION",
    "FINAL_DELIVERY",
    "CLAIM_LOCATION_UNKNOWN",
  ];
  const label = (
    key: InventoryStatisticsStatusGroupKey | null,
    side: "from" | "to"
  ) =>
    key === null
      ? side === "from"
        ? "신규 생성"
        : "재고 삭제"
      : inventoryStatusGroupLabel(key);
  const quantities = new Map(
    transitions.map((row) => [
      `${row.fromGroup ?? "NULL"}>${row.toGroup ?? "NULL"}`,
      row.quantity,
    ])
  );
  const fromKeys = keys.filter((fromKey) =>
    transitions.some((row) => row.fromGroup === fromKey)
  );
  const toKeys = keys.filter((toKey) =>
    transitions.some((row) => row.toGroup === toKey)
  );

  return {
    columns: ["이전 상태", ...toKeys.map((key) => label(key, "to"))],
    rows: fromKeys.map((fromKey) => [
      label(fromKey, "from"),
      ...toKeys.map(
        (toKey) =>
          quantities.get(`${fromKey ?? "NULL"}>${toKey ?? "NULL"}`) ?? 0
      ),
    ]),
  };
}

export function inventorySkuLabel(row: {
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
}) {
  return [row.model, row.storage, row.color, row.saleGrade]
    .filter((value) => value.trim())
    .join(" / ");
}
