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
