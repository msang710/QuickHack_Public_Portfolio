// QuickHack note: 판매 채널 주문 매칭에서 사용하는 보증그룹과 판매등급 우선순위를 공유합니다.
export const WARRANTY_GROUPS = ["2Y", "1Y"] as const;

export type WarrantyGroupCode = (typeof WARRANTY_GROUPS)[number];

export const WARRANTY_GROUP_LABELS: Record<WarrantyGroupCode, string> = {
  "2Y": "2년 보증",
  "1Y": "1년 보증",
};

export const SALE_GRADE_PRIORITY_BY_WARRANTY_GROUP: Record<
  WarrantyGroupCode,
  string[][]
> = {
  "2Y": [["A"], ["A-"], ["B+"]],
  "1Y": [["B+"], ["B"]],
};

export function isWarrantyGroupCode(value: unknown): value is WarrantyGroupCode {
  return WARRANTY_GROUPS.includes(value as WarrantyGroupCode);
}

export function warrantyGroupLabel(value: unknown) {
  return isWarrantyGroupCode(value) ? WARRANTY_GROUP_LABELS[value] : "-";
}

export function warrantyGroupFromSaleGrade(value: unknown) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();

  if (normalized === "A" || normalized === "A-") {
    return "2Y" satisfies WarrantyGroupCode;
  }

  if (normalized === "B+" || normalized === "B") {
    return "1Y" satisfies WarrantyGroupCode;
  }

  return null;
}
