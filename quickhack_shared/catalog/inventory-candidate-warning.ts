export type InventoryCandidateWarningCode =
  | "CANDIDATE_LOAD_FAILED"
  | "ACTIVE_OFFER_NOT_FOUND"
  | "INVALID_WARRANTY_GROUP"
  | "MAPPING_NOT_FOUND"
  | "MAPPING_REQUIRED"
  | "MAPPED_OFFER_INACTIVE"
  | "RANDOM_STORAGE_BUCKET"
  | "RANDOM_COLOR_BUCKET"
  | "GRADE_FALLBACK";

export type InventoryCandidateWarning = {
  code: InventoryCandidateWarningCode;
  args?: {
    warrantyGroup?: string;
    grades?: string;
  };
};

export function serializeInventoryCandidateWarning(
  warning: InventoryCandidateWarning
) {
  return warning.args
    ? `${warning.code}:${JSON.stringify(warning.args)}`
    : warning.code;
}
