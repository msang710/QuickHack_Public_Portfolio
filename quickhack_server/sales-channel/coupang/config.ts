// QuickHack note: 쿠팡 연동 설정과 safe mode 여부를 읽는 서버 설정 모듈입니다.
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { resolveOfficialLiveApiHost } from "@/quickhack_shared/core/external-api-destination-policy";

export const COUPANG_READ_SYNC_STATUSES = [
  "ACCEPT",
  "INSTRUCT",
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
] as const;

export const COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES = [
  "INSTRUCT",
  "DEPARTURE",
] as const;

export const COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES = [
  "DELIVERING",
  "FINAL_DELIVERY",
] as const;

export const COUPANG_RETURN_REQUEST_STATUSES = ["RU", "UC"] as const;

export const COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES = [
  "RU",
  "UC",
  "RELEASE_STOP_UNCHECKED",
  "RETURNS_UNCHECKED",
  "VENDOR_WAREHOUSE_CONFIRM",
] as const;

export const COUPANG_RELEASE_STOP_RECEIPT_STATUSES = [
  "RU",
  "UC",
  "RELEASE_STOP_UNCHECKED",
  "RETURNS_UNCHECKED",
] as const;

export const COUPANG_RELEASE_STOP_PENDING_STATUSES = ["N"] as const;

export const COUPANG_RETURN_CONFIRM_RECEIPT_STATUSES = [
  "VENDOR_WAREHOUSE_CONFIRM",
  "RETURNS_COMPLETED",
] as const;

export const COUPANG_ORDER_STATUS_LABELS = {
  ACCEPT: "결제완료",
  INSTRUCT: "상품준비중",
  DEPARTURE: "배송지시",
  DELIVERING: "배송중",
  FINAL_DELIVERY: "배송완료",
  NONE_TRACKING: "추적불가",
} as const;

export type CoupangApiMode = "mock" | "live";

const COUPANG_REQUEST_TIMEOUT_MS = 90_000;

function normalizeApiMode(value: string): CoupangApiMode {
  return value.toLowerCase() === "live" ? "live" : "mock";
}

export function getCoupangRuntimeConfig() {
  const runtimeConfig = runtimeConfigService.read();
  const mode = normalizeApiMode(runtimeConfig.endpoints.coupang.mode);
  const apiHost =
    mode === "live"
      ? resolveOfficialLiveApiHost("COUPANG")
      : runtimeConfig.endpoints.coupang.apiHost;
  const mockServerUrl = runtimeConfig.endpoints.coupang.mockServerUrl;
  const writeApiEnabled = runtimeConfig.policies.coupangWriteApiEnabled;

  return {
    mode,
    apiHost,
    mockServerUrl,
    httpTimeoutMs: COUPANG_REQUEST_TIMEOUT_MS,
    writeApiEnabled,
    readSyncStatuses: [...COUPANG_READ_SYNC_STATUSES],
    preShipmentReturnOrderStatuses: [
      ...COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES,
    ],
    afterShipmentReturnOrderStatuses: [
      ...COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES,
    ],
    returnRequestStatuses: [...COUPANG_RETURN_REQUEST_STATUSES],
    activeReturnReceiptStatuses: [...COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES],
    releaseStopReceiptStatuses: [...COUPANG_RELEASE_STOP_RECEIPT_STATUSES],
    releaseStopPendingStatuses: [...COUPANG_RELEASE_STOP_PENDING_STATUSES],
    returnConfirmReceiptStatuses: [
      ...COUPANG_RETURN_CONFIRM_RECEIPT_STATUSES,
    ],
    orderStatusLabels: COUPANG_ORDER_STATUS_LABELS,
  };
}

export function assertCoupangWriteAllowed(operationName: string) {
  const config = getCoupangRuntimeConfig();

  if (!config.writeApiEnabled) {
    throw new Error(
      `${operationName} 차단: Coupang 쓰기 API가 금지 상태입니다.`
    );
  }

}
