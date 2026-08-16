export const CARRIER_SHIPMENT_STATUS = {
  allocated: "ALLOCATED",
  registered: "REGISTERED",
  inTransit: "IN_TRANSIT",
  delivered: "DELIVERED",
  exception: "EXCEPTION",
} as const;

export type CarrierShipmentStatus =
  (typeof CARRIER_SHIPMENT_STATUS)[keyof typeof CARRIER_SHIPMENT_STATUS];

const LOGEN_REGISTERED_STATUS_NAMES = new Set([
  "송장등록",
  "송장출력",
  "접수완료",
]);

const LOGEN_IN_TRANSIT_STATUS_NAMES = new Set([
  "집하완료",
  "집하처리",
  "터미널입고",
  "터미널출고",
  "간선상차",
  "간선하차",
  "배송중",
  "배송출발",
  "배달출발",
]);

const LOGEN_DELIVERED_STATUS_NAMES = new Set([
  "배송완료",
  "배달완료",
  "인수완료",
]);

const LOGEN_EXCEPTION_KEYWORDS = [
  "미배송",
  "배송실패",
  "사고",
  "분실",
  "파손",
  "반송",
  "회송",
  "주소불명",
  "수취거부",
] as const;

export function normalizeCarrierTrackingStatusName(
  value: string | null | undefined
) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

export function classifyLogenTrackingStatus(
  value: string | null | undefined
): CarrierShipmentStatus | null {
  const statusName = normalizeCarrierTrackingStatusName(value);

  if (!statusName) return null;
  if (LOGEN_DELIVERED_STATUS_NAMES.has(statusName)) {
    return CARRIER_SHIPMENT_STATUS.delivered;
  }
  if (
    LOGEN_EXCEPTION_KEYWORDS.some((keyword) => statusName.includes(keyword))
  ) {
    return CARRIER_SHIPMENT_STATUS.exception;
  }
  if (LOGEN_IN_TRANSIT_STATUS_NAMES.has(statusName)) {
    return CARRIER_SHIPMENT_STATUS.inTransit;
  }
  if (LOGEN_REGISTERED_STATUS_NAMES.has(statusName)) {
    return CARRIER_SHIPMENT_STATUS.registered;
  }

  return null;
}
