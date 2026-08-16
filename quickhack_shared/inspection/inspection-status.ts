// QuickHack note: 검수 완료 여부에서 재고 상태 표시값을 계산하는 공유 유틸입니다.
export type InspectionLifecycleStatus =
  | "INBOUND"
  | "INSPECTING"
  | "INSPECTED"
  | "RETURN_CHECK";

type InspectionDateValue = Date | string | null;

export type InspectionStatusSource = {
  inspection_type?: string | null;
  appearance_grade: string | null;
  appearance_defect: string | null;
  appearance_worker: string | null;
  appearance_checked_at: InspectionDateValue;
  function_defect: string | null;
  function_worker: string | null;
  function_checked_at: InspectionDateValue;
  csc: string | null;
  first_call_date: InspectionDateValue;
  return_yn: string;
};

export const INSPECTION_LIFECYCLE_STATUSES = new Set<string>([
  "INBOUND",
  "INSPECTING",
  "INSPECTED",
  "RETURN_CHECK",
]);

function hasText(value: string | Date | null) {
  return value instanceof Date
    ? !Number.isNaN(value.getTime())
    : Boolean(value?.trim());
}

export function hasAppearanceInspection(inspection: InspectionStatusSource) {
  if (inspection.inspection_type) {
    return inspection.inspection_type === "APPEARANCE";
  }

  return [
    inspection.appearance_grade,
    inspection.appearance_defect,
    inspection.appearance_worker,
    inspection.appearance_checked_at,
  ].some(hasText);
}

export function hasFunctionInspection(inspection: InspectionStatusSource) {
  if (inspection.inspection_type) {
    return inspection.inspection_type === "FUNCTION";
  }

  return [
    inspection.function_defect,
    inspection.function_worker,
    inspection.function_checked_at,
    inspection.csc,
    inspection.first_call_date,
  ].some(hasText);
}

export function statusFromInspectionState({
  hasAppearance,
  hasFunction,
  hasReturn,
}: {
  hasAppearance: boolean;
  hasFunction: boolean;
  hasReturn: boolean;
}): InspectionLifecycleStatus {
  if (hasReturn) {
    return "RETURN_CHECK";
  }

  if (hasAppearance && hasFunction) {
    return "INSPECTED";
  }

  if (hasAppearance || hasFunction) {
    return "INSPECTING";
  }

  return "INBOUND";
}

export function inferInspectionStatus(
  inspections: InspectionStatusSource[]
): InspectionLifecycleStatus {
  return statusFromInspectionState({
    hasAppearance: inspections.some(hasAppearanceInspection),
    hasFunction: inspections.some(hasFunctionInspection),
    hasReturn: inspections.some((inspection) => inspection.return_yn === "Y"),
  });
}

export function resolveLifecycleDeviceStatus(
  status: string,
  inspections: InspectionStatusSource[],
  hasReturnHistory: boolean
) {
  if (hasReturnHistory) {
    return "RETURN_CHECK";
  }

  if (!INSPECTION_LIFECYCLE_STATUSES.has(status)) {
    return status;
  }

  return inferInspectionStatus(inspections);
}
