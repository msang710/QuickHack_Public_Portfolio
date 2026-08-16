// QuickHack note: Inspection row type/source/result codes shared by DB writers and UI.
export const INSPECTION_TYPE = {
  appearance: "APPEARANCE",
  function: "FUNCTION",
  returnCheck: "RETURN_CHECK",
} as const;

export const INSPECTION_SOURCE_TYPE = {
  inbound: "INBOUND",
  coupangReturn: "COUPANG_RETURN",
  manual: "MANUAL",
} as const;

export const INSPECTION_RESULT = {
  passed: "PASSED",
  failed: "FAILED",
  hold: "HOLD",
  returnToSupplier: "RETURN_TO_SUPPLIER",
  disposal: "DISPOSAL",
} as const;

export type InspectionType =
  (typeof INSPECTION_TYPE)[keyof typeof INSPECTION_TYPE];
export type InspectionSourceType =
  (typeof INSPECTION_SOURCE_TYPE)[keyof typeof INSPECTION_SOURCE_TYPE];
export type InspectionResult =
  (typeof INSPECTION_RESULT)[keyof typeof INSPECTION_RESULT];

export const INSPECTION_TYPE_LABELS: Record<InspectionType, string> = {
  APPEARANCE: "외관검수",
  FUNCTION: "기능검수",
  RETURN_CHECK: "반품검수",
};

export const INSPECTION_SOURCE_TYPE_LABELS: Record<InspectionSourceType, string> = {
  INBOUND: "입고",
  COUPANG_RETURN: "쿠팡 반품",
  MANUAL: "수동 등록",
};

export const INSPECTION_RESULT_LABELS: Record<InspectionResult, string> = {
  PASSED: "통과",
  FAILED: "불합격",
  HOLD: "보류",
  RETURN_TO_SUPPLIER: "매입처 반품",
  DISPOSAL: "폐기",
};

export function inspectionTypeLabel(value: string | null | undefined) {
  return INSPECTION_TYPE_LABELS[value as InspectionType] ?? value ?? "";
}

export function inspectionSourceTypeLabel(value: string | null | undefined) {
  return INSPECTION_SOURCE_TYPE_LABELS[value as InspectionSourceType] ?? value ?? "";
}

export function inspectionResultLabel(value: string | null | undefined) {
  return INSPECTION_RESULT_LABELS[value as InspectionResult] ?? value ?? "";
}
