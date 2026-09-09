import {
  CLIENT_RECORD_ID,
  CLIENT_RECORD_KIND_COLUMN,
  INSPECTION_RECORD_KINDS,
  RECORD_COLUMNS,
  UPLOAD_STATUS_COLUMN,
  createInspectionRecord,
  deriveInspectionRecordKind,
  type InspectionRecord,
  type InspectionRecordKind,
  type InspectionRecordWithStatus,
} from "@/quickhack_shared/inspection/inspection-schema";

export function recordForUpload(
  record: InspectionRecordWithStatus
): {
  clientRecordId: string;
  inspectionKind: InspectionRecordKind;
  record: InspectionRecord;
} {
  const uploadRecord = createInspectionRecord({});

  for (const column of RECORD_COLUMNS) {
    uploadRecord[column] = record[column];
  }

  const inspectionKind =
    record[CLIENT_RECORD_KIND_COLUMN] ?? inferLegacyInspectionRecordKind(record);
  if (!inspectionKind) {
    throw new Error("Inspection record kind is required for upload.");
  }
  return {
    clientRecordId: record[CLIENT_RECORD_ID],
    inspectionKind,
    record: uploadRecord,
  };
}

function hasAppearanceStamp(record: InspectionRecord) {
  return Boolean(record.외관검수자 || record.외관검수일시);
}

function hasFunctionStamp(record: InspectionRecord) {
  return Boolean(record.기능검수자 || record.기능검수일시);
}

function inferLegacyInspectionRecordKind(
  record: InspectionRecord
): InspectionRecordKind | null {
  const hasAppearance = hasAppearanceStamp(record);
  const hasFunction = hasFunctionStamp(record);

  if (hasAppearance && !hasFunction) {
    return INSPECTION_RECORD_KINDS.appearance;
  }

  if (hasFunction && !hasAppearance) {
    return INSPECTION_RECORD_KINDS.function;
  }

  const derivedKind = deriveInspectionRecordKind(record);

  if (derivedKind === INSPECTION_RECORD_KINDS.appearance) {
    return INSPECTION_RECORD_KINDS.appearance;
  }

  if (derivedKind === INSPECTION_RECORD_KINDS.function) {
    return INSPECTION_RECORD_KINDS.function;
  }

  return null;
}

function createClientRecordId(baseId: string, kind: InspectionRecordKind) {
  return `${baseId}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createRecordForKind(
  record: InspectionRecordWithStatus,
  kind: InspectionRecordKind
): InspectionRecordWithStatus {
  const sharedValues = {
    PG: record.PG,
    IMEI: record.IMEI,
    매입처반품유무: record.매입처반품유무,
  };
  const kindValues =
    kind === INSPECTION_RECORD_KINDS.appearance
      ? {
          기기색상: record.기기색상,
          외관등급: record.외관등급,
          외관하자: record.외관하자,
          차수: record.차수,
          외관검수자: record.외관검수자,
          외관검수일시: record.외관검수일시,
        }
      : {
          기능하자: record.기능하자,
          제품명: record.제품명,
          통신사: record.통신사,
          저장공간: record.저장공간,
          최초통화일: record.최초통화일,
          기능검수자: record.기능검수자,
          기능검수일시: record.기능검수일시,
        };

  return {
    ...createInspectionRecord({
      ...sharedValues,
      ...kindValues,
    }),
    [CLIENT_RECORD_ID]: createClientRecordId(record[CLIENT_RECORD_ID], kind),
    [UPLOAD_STATUS_COLUMN]: record[UPLOAD_STATUS_COLUMN],
    [CLIENT_RECORD_KIND_COLUMN]: kind,
  };
}

// QuickHack object: 이전 단일 검수 기록을 외관/기능 기록으로 분리하거나 명시 타입을 보강합니다.
export function normalizeInspectionRecordKinds(
  records: InspectionRecordWithStatus[]
) {
  let changed = false;
  const next: InspectionRecordWithStatus[] = [];

  for (const record of records) {
    if (record[CLIENT_RECORD_KIND_COLUMN]) {
      next.push(record);
      continue;
    }

    if (hasAppearanceStamp(record) && hasFunctionStamp(record)) {
      changed = true;
      next.push(
        createRecordForKind(record, INSPECTION_RECORD_KINDS.appearance),
        createRecordForKind(record, INSPECTION_RECORD_KINDS.function)
      );
      continue;
    }

    const inferredKind = inferLegacyInspectionRecordKind(record);

    if (!inferredKind) {
      next.push(record);
      continue;
    }

    changed = true;
    next.push({
      ...record,
      [CLIENT_RECORD_KIND_COLUMN]: inferredKind,
    });
  }

  return changed ? next : records;
}

export function hasAppearanceRecordData(record: InspectionRecordWithStatus) {
  const explicitKind = record[CLIENT_RECORD_KIND_COLUMN];

  if (explicitKind) {
    return explicitKind === INSPECTION_RECORD_KINDS.appearance;
  }

  return (
    inferLegacyInspectionRecordKind(record) ===
    INSPECTION_RECORD_KINDS.appearance
  );
}

export function hasFunctionRecordData(record: InspectionRecordWithStatus) {
  const explicitKind = record[CLIENT_RECORD_KIND_COLUMN];

  if (explicitKind) {
    return explicitKind === INSPECTION_RECORD_KINDS.function;
  }

  return (
    inferLegacyInspectionRecordKind(record) === INSPECTION_RECORD_KINDS.function
  );
}
