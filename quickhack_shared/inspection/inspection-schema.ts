// QuickHack note: 검수 데이터 컬럼, 정규화, 유효성 검사, 병합 규칙을 공유합니다.
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { normalizeOptionalImei } from "@/quickhack_shared/device/device-identifiers";

// QuickHack object: 외관/기능 검수 업로드 레코드가 공유하는 한글 컬럼 순서를 정의합니다.
export const RECORD_COLUMNS = [
  "PG",
  "기기색상",
  "IMEI",
  "외관등급",
  "외관하자",
  "기능하자",
  "매입처반품유무",
  "제품명",
  "통신사",
  "저장공간",
  "최초통화일",
  "차수",
  "외관검수자",
  "기능검수자",
  "외관검수일시",
  "기능검수일시",
] as const;

export const UPLOAD_STATUS_COLUMN = "업로드상태";
export const CLIENT_RECORD_ID = "__clientRecordId";
export const CLIENT_RECORD_KIND_COLUMN = "__inspectionKind";

export const INSPECTION_RECORD_KINDS = {
  appearance: "appearance",
  function: "function",
} as const;

export const UPLOAD_STATUSES = {
  pending: "대기",
  uploading: "업로드중",
  done: "완료",
  failed: "실패",
} as const;

export const GRADE_OPTIONS = ["A", "A-", "A-~B+", "B+", "B"] as const;
export const FIRST_CALL_DATE_UNKNOWN = "0000-00-00";
export const NO_DEFECT_TEXT = "하자 없음";

export const WORKER_LIST = ["문윤상", "작업자1", "작업자2"] as const;

export const APPEARANCE_DEFECT_MAP = {
  액정: ["기스", "찍힘", "칼자국"],
  프레임: ["기스", "찍힘", "칼자국"],
  후면: ["기스", "찍힘", "칼자국", "뒷판 부풀음"],
  렌즈: ["기스", "찍힘", "내부 먼지", "칼자국"],
  "렌즈 프레임": ["기스", "찍힘", "칼자국"],
  충전단자: ["까짐"],
} as const;

export const FUNCTION_DEFECT_MAP = {
  계정: ["부모코드 설정"],
  "통신사 변경": ["통변이력 있음"],
  "위 스피커(리시버)": ["무음", "소리작음", "지지직"],
  "아래 스피커": ["무음", "소리작음", "지지직"],
  터치: ["터치불량"],
  진동: ["진동불량"],
  센서: ["지문인식 불량"],
  루프백: ["무음", "수음불량"],
  카메라: ["멍", "초점불량", "실행불가"],
  와이파이: ["연결불량"],
  충전: ["충전불량", "배터리 발열"],
  기타: ["직접 상의 필요"],
} as const;

export const FUNCTION_ACTION_GROUPS = [
  {
    title: "기본 제어",
    actions: [
      { id: "refresh", label: "새로고침" },
      { id: "show-device-numbers", label: "기기 번호 표시" },
      { id: "set-timeout", label: "화면 꺼짐 방지" },
    ],
  },
  {
    title: "화면 검사",
    actions: [
      { id: "reset-display", label: "색상 설정 초기화" },
      { id: "afterimage-test", label: "잔상 검사" },
      { id: "camera", label: "카메라" },
    ],
  },
  {
    title: "상세 확인",
    actions: [
      { id: "accounts", label: "계정 관리" },
      { id: "imei-check", label: "IMEI 조회 (*#06#)" },
      { id: "discount-check", label: "약정조회 사이트" },
      { id: "function-test", label: "기능점검 (*#0*#)" },
    ],
  },
  {
    title: "초기화",
    actions: [{ id: "reboot-recovery", label: "리커버리 모드" }],
  },
] as const;

export const MANUAL_URL =
  "https://github.com/msang710/QuickHack_Public_Portfolio#readme";
export const DISCOUNT_CHECK_URL = "https://www.imei.kr/user/discount/inquire.do";

export type RecordColumn = (typeof RECORD_COLUMNS)[number];
export type UploadStatus =
  (typeof UPLOAD_STATUSES)[keyof typeof UPLOAD_STATUSES];
export type InspectionRecordKind =
  (typeof INSPECTION_RECORD_KINDS)[keyof typeof INSPECTION_RECORD_KINDS];
export type InspectionRecord = Record<RecordColumn, string>;
export type InspectionRecordWithStatus = InspectionRecord & {
  [CLIENT_RECORD_ID]: string;
  [UPLOAD_STATUS_COLUMN]: UploadStatus;
  [CLIENT_RECORD_KIND_COLUMN]?: InspectionRecordKind;
};

export function normalizeBarcode(value: string) {
  return value.trim().toUpperCase();
}

function normalizeText(value: unknown) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: unknown) {
  const normalized = normalizeText(value);

  if (["-", "Unknown", "unknown", "0000"].includes(normalized)) {
    return "";
  }

  return normalized;
}

function normalizeListText(value: unknown) {
  return normalizeOptionalText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeNoDefectComparable(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function isNoDefectText(value: unknown) {
  const normalized = normalizeNoDefectComparable(normalizeText(value));

  return normalized === "" || normalized === normalizeNoDefectComparable(NO_DEFECT_TEXT);
}

export function normalizeDefectText(value: unknown) {
  const normalized = normalizeListText(value);

  return normalized || NO_DEFECT_TEXT;
}

export function actualDefectText(value: unknown) {
  return normalizeListText(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => !isNoDefectText(part))
    .join(", ");
}

export function hasActualDefectText(value: unknown) {
  return actualDefectText(value) !== "";
}

function normalizeReturnYn(value: unknown) {
  const normalized = normalizeText(value).toUpperCase();

  return ["Y", "YES", "TRUE", "1"].includes(normalized) ? "Y" : "N";
}

function normalizeGrade(value: unknown) {
  const normalized = normalizeText(value).toUpperCase();

  return (GRADE_OPTIONS as readonly string[]).includes(normalized)
    ? normalized
    : normalizeText(value);
}

// QuickHack object: 외관등급을 현재 판매 정책의 판매등급 기본값으로 변환합니다.
export function saleGradeFromAppearanceGrade(value: unknown) {
  const normalized = normalizeGrade(value);

  if (normalized === "A" || normalized === "A-") {
    return "A";
  }

  if (normalized === "A-~B+") {
    return "A-";
  }

  if (normalized === "B+" || normalized === "B") {
    return normalized;
  }

  return normalized;
}

function normalizeCarrier(value: unknown) {
  const normalized = normalizeOptionalText(value);
  const compact = normalized.toUpperCase().replace(/\s+/g, "");

  const carrierMap: Record<string, string> = {
    SKC: "SKT",
    SKT: "SKT",
    KTC: "KT",
    KT: "KT",
    LUC: "LG U+",
    LGU: "LG U+",
    "LGU+": "LG U+",
    "LGU＋": "LG U+",
    "LG유플러스": "LG U+",
    KOO: "자급제",
    자급제: "자급제",
  };

  return carrierMap[compact] ?? normalized;
}

function normalizeStorage(value: unknown) {
  const normalized = normalizeOptionalText(value)
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!normalized) {
    return "";
  }

  const tbMatch = normalized.match(/^(\d+(?:\.\d+)?)T(?:B)?$/);

  if (tbMatch) {
    const tb = Number.parseFloat(tbMatch[1]);
    return Number.isFinite(tb)
      ? `${Number.isInteger(tb) ? tb : tbMatch[1]}TB`
      : normalized;
  }

  const gbMatch = normalized.match(/^(\d+(?:\.\d+)?)G(?:B)?$/);
  const numericMatch = normalized.match(/^(\d+(?:\.\d+)?)$/);
  const gbText = gbMatch?.[1] ?? numericMatch?.[1];

  if (!gbText) {
    return normalized;
  }

  const gb = Number.parseFloat(gbText);

  if (!Number.isFinite(gb)) {
    return normalized;
  }

  if (gb >= 900) {
    return `${Math.round(gb / 1024)}TB`;
  }

  return `${Number.isInteger(gb) ? gb : gbText}GB`;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function validDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isNoDateMarker(value: string) {
  return ["", "-", "Unknown", "unknown", "0000", FIRST_CALL_DATE_UNKNOWN].includes(
    value
  );
}

// QuickHack object: ADB/수동 입력 최초 통화일을 YYYY-MM-DD 또는 0000-00-00 형식으로 통일합니다.
export function normalizeFirstCallDate(value: unknown) {
  const normalized = normalizeText(value);

  if (isNoDateMarker(normalized)) {
    return FIRST_CALL_DATE_UNKNOWN;
  }

  const digitsOnly = normalized.replace(/\D/g, "");
  const digitMatch =
    digitsOnly.length === 8
      ? digitsOnly.match(/^(\d{4})(\d{2})(\d{2})$/)
      : null;
  const separatedMatch = normalized.match(
    /^(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})일?$/
  );
  const match = digitMatch ?? separatedMatch;

  if (!match) {
    return "";
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (!validDateParts(year, month, day)) {
    return "";
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function isValidFirstCallDateInput(value: unknown) {
  const normalized = normalizeText(value);

  return isNoDateMarker(normalized) || normalizeFirstCallDate(normalized) !== "";
}

function normalizeSqlDateTime(value: unknown) {
  const normalized = normalizeOptionalText(value).replace("T", " ");

  if (!normalized) {
    return "";
  }

  const match = normalized.match(
    /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );

  if (!match) {
    return normalized;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (!validDateParts(year, month, day)) {
    return normalized;
  }

  const hour = Number.parseInt(match[4] ?? "0", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  const second = Number.parseInt(match[6] ?? "0", 10);

  if (hour > 23 || minute > 59 || second > 59) {
    return normalized;
  }

  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(
    minute
  )}:${pad2(second)}`;
}

// QuickHack object: 검수 컬럼별 입력값을 저장 전 표준 형식으로 정규화합니다.
export function normalizeInspectionField(
  column: RecordColumn,
  value: unknown
) {
  switch (column) {
    case "PG":
      return normalizeBarcode(normalizeOptionalText(value));
    case "IMEI":
      return normalizeOptionalText(value);
    case "기기색상":
      return normalizeOptionalText(value);
    case "외관등급":
      return normalizeGrade(value);
    case "외관하자":
    case "기능하자":
      return normalizeListText(value);
    case "매입처반품유무":
      return normalizeReturnYn(value);
    case "제품명":
      return normalizeOptionalText(value);
    case "통신사":
      return normalizeCarrier(value);
    case "저장공간":
      return normalizeStorage(value);
    case "최초통화일":
      return normalizeFirstCallDate(value);
    case "차수": {
      const normalized = normalizeOptionalText(value);
      return /^\d+$/.test(normalized)
        ? String(Number.parseInt(normalized, 10))
        : normalized;
    }
    case "외관검수일시":
    case "기능검수일시":
      return normalizeSqlDateTime(value);
    case "외관검수자":
    case "기능검수자":
    default:
      return normalizeOptionalText(value);
  }
}

export function isValidPg(value: string) {
  return /^[A-Z]{2}\d{10}$/.test(normalizeBarcode(value));
}

export function isValidImei(value: string) {
  try {
    return normalizeOptionalImei(value) !== null;
  } catch {
    return false;
  }
}

export function validateBarcodeInput(rawValue: string, targetColumn: "PG" | "IMEI") {
  const value = normalizeBarcode(rawValue);

  if (!value) {
    return { ok: false, value: "", message: "바코드 값이 비어 있습니다." };
  }

  if (targetColumn === "PG" && !isValidPg(value)) {
    return {
      ok: false,
      value: "",
      message: "PG 형식 오류 - 알파벳 2자리 + 숫자 10자리",
    };
  }

  if (targetColumn === "IMEI" && !isValidImei(value)) {
    return {
      ok: false,
      value: "",
      message: "IMEI 형식 오류 - 15자리 숫자",
    };
  }

  return {
    ok: true,
    value,
    message: `${targetColumn} 입력 완료`,
  };
}

export function validateBatch(value: string) {
  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    return false;
  }

  return Number.parseInt(normalized, 10) > 0;
}

export function nowSqlDateTime() {
  return nowKstSqlDateTime();
}

export function createEmptyInspectionRecord(): InspectionRecord {
  return {
    PG: "",
    기기색상: "",
    IMEI: "",
    외관등급: "",
    외관하자: "",
    기능하자: "",
    매입처반품유무: "N",
    제품명: "",
    통신사: "",
    저장공간: "",
    최초통화일: "",
    차수: "",
    외관검수자: "",
    기능검수자: "",
    외관검수일시: "",
    기능검수일시: "",
  };
}

export function createInspectionRecord(
  values: Partial<InspectionRecord>
): InspectionRecord {
  const record = createEmptyInspectionRecord();

  for (const column of RECORD_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(values, column)) {
      continue;
    }

    record[column] = normalizeInspectionField(
      column,
      values[column]
    );
  }

  return record;
}

export function createUploadRecord(
  values: Partial<InspectionRecord>,
  kind?: InspectionRecordKind
): InspectionRecordWithStatus {
  return {
    ...createInspectionRecord(values),
    [CLIENT_RECORD_ID]:
      globalThis.crypto?.randomUUID?.() ??
      `record-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [UPLOAD_STATUS_COLUMN]: UPLOAD_STATUSES.pending,
    ...(kind ? { [CLIENT_RECORD_KIND_COLUMN]: kind } : {}),
  };
}

export function getRecordLabel(record: InspectionRecord) {
  return record.PG || record.IMEI || "-";
}

type DerivedInspectionRecordKind = InspectionRecordKind | "combined" | "empty";

function hasAnyText(record: InspectionRecord, columns: RecordColumn[]) {
  return columns.some((column) => Boolean(record[column]?.trim()));
}

export function deriveInspectionRecordKind(
  record: InspectionRecord
): DerivedInspectionRecordKind {
  const hasAppearance = hasAnyText(record, [
    "기기색상",
    "외관등급",
    "외관하자",
    "외관검수자",
    "외관검수일시",
  ]);
  const hasFunction = hasAnyText(record, [
    "기능하자",
    "제품명",
    "통신사",
    "저장공간",
    "최초통화일",
    "기능검수자",
    "기능검수일시",
  ]);

  if (hasAppearance && hasFunction) {
    return "combined";
  }

  if (hasAppearance) {
    return "appearance";
  }

  if (hasFunction) {
    return "function";
  }

  return "empty";
}

function canMergeInspectionRecords(
  existing: InspectionRecord,
  incoming: InspectionRecord,
  incomingKind?: InspectionRecordKind
) {
  const existingExplicitKind = (existing as Partial<InspectionRecordWithStatus>)[
    CLIENT_RECORD_KIND_COLUMN
  ];
  const existingKind = existingExplicitKind ?? deriveInspectionRecordKind(existing);
  const nextIncomingKind = incomingKind ?? deriveInspectionRecordKind(incoming);

  if (existingKind === "empty" || nextIncomingKind === "empty") {
    return true;
  }

  return existingKind === nextIncomingKind;
}

// QuickHack object: 클라이언트 업로드 대기 목록에서 같은 종류의 검수 기록을 병합합니다.
export function mergeInspectionRecord(
  records: InspectionRecordWithStatus[],
  incoming: InspectionRecord,
  incomingKind?: InspectionRecordKind
) {
  const matchedIndex = records.findIndex((record) => {
    if (!canMergeInspectionRecords(record, incoming, incomingKind)) {
      return false;
    }

    if (incoming.PG && record.PG === incoming.PG) {
      return true;
    }

    return Boolean(incoming.IMEI && record.IMEI === incoming.IMEI);
  });

  if (matchedIndex === -1) {
    return {
      records: [...records, createUploadRecord(incoming, incomingKind)],
      index: records.length,
      mode: "ADDED" as const,
    };
  }

  const nextRecords = records.map((record, index) => {
    if (index !== matchedIndex) {
      return record;
    }

    const merged = { ...record };

    for (const column of RECORD_COLUMNS) {
      const value = incoming[column];

      if (value !== "") {
        merged[column] = value;
      }
    }

    merged[UPLOAD_STATUS_COLUMN] = UPLOAD_STATUSES.pending;
    if (incomingKind) {
      merged[CLIENT_RECORD_KIND_COLUMN] = incomingKind;
    }
    return merged;
  });

  return {
    records: nextRecords,
    index: matchedIndex,
    mode: "UPDATED" as const,
  };
}
