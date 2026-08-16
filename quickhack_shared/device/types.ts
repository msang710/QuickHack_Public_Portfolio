// QuickHack note: 기기 목록, 상세 이력, 보증 조건, 고유번호 표시 타입을 공유합니다.
export type StatusTone =
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "purple"
  | "orange"
  | "sky";

// QuickHack object: 판매 보증 조건을 화면과 서버가 같은 문자열 집합으로 쓰기 위한 상수입니다.
export const DEVICE_WARRANTY_OPTIONS = ["1년 보증", "2년 보증"] as const;
export type DeviceWarranty = (typeof DEVICE_WARRANTY_OPTIONS)[number];

// QuickHack object: 판매등급에서 기본 보증 조건을 산출해 SKU/주문 매칭에 사용합니다.
export function warrantyFromSaleGrade(value: unknown): DeviceWarranty | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();

  if (normalized === "A" || normalized === "A-") {
    return "2년 보증";
  }

  if (normalized === "B+" || normalized === "B") {
    return "1년 보증";
  }

  return null;
}

export function compactKoreanModelName(value: unknown) {
  const model = String(value ?? "")
    .trim()
    .replace(/^Galaxy\s+/i, "")
    .replace(/^Z\s+/i, "")
    .trim();

  if (!model) {
    return "";
  }

  const orderedPatterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/^S(\d+)\s*Ultra$/i, (match) => `S${match[1]}울트라`],
    [/^S(\d+)\s*Edge$/i, (match) => `S${match[1]}엣지`],
    [/^S(\d+)\s*FE$/i, (match) => `S${match[1]}FE`],
    [/^S(\d+)\+$/i, (match) => `S${match[1]}+`],
    [/^S(\d+)$/i, (match) => `S${match[1]}`],
    [/^A(\d+)$/i, (match) => `A${match[1]}`],
    [/^Flip\s*(\d+)$/i, (match) => `플립${match[1]}`],
    [/^Fold\s*(\d+)$/i, (match) => `폴드${match[1]}`],
    [/^Wide\s*(\d+)$/i, (match) => `와이드${match[1]}`],
    [/^Jump\s*(\d+)$/i, (match) => `점프${match[1]}`],
    [/^Buddy\s*(\d+)$/i, (match) => `버디${match[1]}`],
    [/^Quantum\s*(\d+)$/i, (match) => `퀀텀${match[1]}`],
  ];

  for (const [pattern, format] of orderedPatterns) {
    const match = model.match(pattern);

    if (match) {
      return format(match);
    }
  }

  return model
    .replace(/\bUltra\b/gi, "울트라")
    .replace(/\bEdge\b/gi, "엣지")
    .replace(/\bFlip\b/gi, "플립")
    .replace(/\bFold\b/gi, "폴드")
    .replace(/\bWide\b/gi, "와이드")
    .replace(/\bJump\b/gi, "점프")
    .replace(/\bBuddy\b/gi, "버디")
    .replace(/\bQuantum\b/gi, "퀀텀")
    .replace(/\s+/g, "");
}

// QuickHack object: DB의 model/model_seq를 실무 고유번호 표기 형식으로 변환합니다.
export function formatModelSeqLabel(
  model: unknown,
  modelSeq: number | string | null | undefined
) {
  if (modelSeq === null || modelSeq === undefined || modelSeq === "") {
    return "-";
  }

  const sequence = String(modelSeq).trim();

  if (!sequence) {
    return "-";
  }

  const compactModel = compactKoreanModelName(model);

  return compactModel ? `${compactModel}-${sequence}` : sequence;
}

export type TimelineRecord = {
  id: number;
  label: string;
  detail: string;
  at: string | null;
};

export type DetailField = {
  key: string;
  label: string;
  value: string | number | null;
  displayValue?: string | number | null;
  readOnly?: boolean;
};

export type DetailRecordKind =
  | "device"
  | "inbound"
  | "inventory"
  | "inspection"
  | "orderItem"
  | "channelOrderMatch"
  | "shipmentWork"
  | "returnDecision";

export type DetailRecordGroup =
  | "devices"
  | "inbounds"
  | "inventory"
  | "inspections"
  | "orderItems"
  | "channelOrderMatches"
  | "shipmentWorks"
  | "returnDecisions";

export type DetailRecordInputMode = "text" | "number";

export type DetailRecordFieldInput = {
  key: string;
  value: string | number | null;
};

export type DetailRecord = {
  id: string;
  kind: DetailRecordKind;
  recordId: number | null;
  revision: number | null;
  title: string;
  subtitle: string | null;
  at: string | null;
  fields: DetailField[];
};

export type DeviceDetailRecords = {
  devices: DetailRecord[];
  inbounds: DetailRecord[];
  inspections: DetailRecord[];
  inventory: DetailRecord[];
  orderItems: DetailRecord[];
  channelOrderMatches: DetailRecord[];
  shipmentWorks: DetailRecord[];
  returnDecisions: DetailRecord[];
};

// QuickHack object: 재고 조회와 상세 패널에서 쓰는 기기 목록 row 타입입니다.
export type DeviceListItem = {
  deviceId: number;
  revision: number;
  pgNo: string;
  imei: string | null;
  adbSerial: string | null;
  model: string;
  modelCode: string | null;
  modelSeq: number | null;
  storage: string | null;
  color: string | null;
  appearanceGrade: string | null;
  appearanceDefect: string | null;
  functionDefect: string | null;
  saleGrade: string | null;
  warranty: string | null;
  displayStatus: string;
  createdAt: string;
  updatedAt: string;
  appearanceCheckedAt: string | null;
  functionCheckedAt: string | null;
  inspectionCompletedAt: string | null;
  inbound: {
    id: number;
    revision: number;
    batchId: number | null;
    batchDate: string | null;
    batchNo: number | null;
    supplierName: string | null;
    purchasePrice: number | null;
    receivedAt: string | null;
    priceAgreedAt: string | null;
    status: string;
    note: string | null;
  } | null;
  inventory: {
    id: number;
    revision: number;
    status: string;
    location: string | null;
    stockedAt: string | null;
  } | null;
  inspections: TimelineRecord[];
  orders: TimelineRecord[];
  detailRecords: DeviceDetailRecords;
};
