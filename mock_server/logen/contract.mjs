export const LOGEN_API_BASE_PATH = "/lrm02b-edi/edi";

export const LOGEN_PUBLIC_APIS = Object.freeze([
  { no: 1, method: "POST", path: `${LOGEN_API_BASE_PATH}/contractTotalInfo`, name: "거래처 계약정보 통합조회", phase: "core" },
  { no: 2, method: "POST", path: `${LOGEN_API_BASE_PATH}/contPickFares`, name: "운임구분에 따른 계약 운임 조회", phase: "core" },
  { no: 3, method: "POST", path: `${LOGEN_API_BASE_PATH}/getSlipNo`, name: "송장번호 채번", phase: "core" },
  { no: 5, method: "POST", path: `${LOGEN_API_BASE_PATH}/integratedInquiry`, name: "송장 출력정보 통합조회", phase: "core" },
  { no: 6, method: "POST", path: `${LOGEN_API_BASE_PATH}/slipPrintM`, name: "송장 출력 주문 정보 등록", phase: "core" },
  { no: 7, method: "POST", path: `${LOGEN_API_BASE_PATH}/registerOrderData`, name: "주문 정보 일괄 등록", phase: "ilogen" },
  { no: 8, method: "POST", path: `${LOGEN_API_BASE_PATH}/inquirySlipNoMulti`, name: "출력 송장번호 조회", phase: "ilogen" },
  { no: 9, method: "GET", path: `${LOGEN_API_BASE_PATH}/outSlipPrintPop`, name: "로젠 제공 외부 운송장 출력 팝업", phase: "ilogen" },
  { no: 10, method: "POST", path: `${LOGEN_API_BASE_PATH}/registReturnRequest`, name: "반품 접수 등록", phase: "returns" },
  { no: 11, method: "POST", path: `${LOGEN_API_BASE_PATH}/reverseChkInfoMulti`, name: "반품 집하지점 및 운임 조회", phase: "returns" },
  { no: 13, method: "POST", path: `${LOGEN_API_BASE_PATH}/inquiryReserveStateMulti`, name: "반품 요청 상태 및 송장번호 조회", phase: "returns" },
  { no: 14, method: "POST", path: `${LOGEN_API_BASE_PATH}/inquiryReserveStateFixTakeNo`, name: "주문번호 기준 반품 상태 조회", phase: "returns" },
  { no: 15, method: "POST", path: `${LOGEN_API_BASE_PATH}/inquiryReturnStateMulti`, name: "반품접수 정보 조회", phase: "returns" },
  { no: 17, method: "POST", path: `${LOGEN_API_BASE_PATH}/inquiryCargoTrackingMulti`, name: "화물추적 조회", phase: "tracking" },
  { no: 18, method: "POST", path: `${LOGEN_API_BASE_PATH}/inquiryCargoTrackingMultiLast`, name: "최종 화물추적 조회", phase: "tracking" },
  { no: 19, method: "POST", path: `${LOGEN_API_BASE_PATH}/custExtraFare`, name: "물품금액에 따른 할증운임 조회", phase: "core" },
]);

export const LOGEN_UNPUBLISHED_APIS = Object.freeze([
  { no: 4, name: "전화번호에 대한 안심번호 제공", reason: "UNAVAILABLE_PUBLIC_SPEC" },
  { no: 12, name: "반품 계약 운임 조회", reason: "UNAVAILABLE_PUBLIC_SPEC" },
  { no: 16, name: "반품 취소 등록", reason: "UNAVAILABLE_PUBLIC_SPEC" },
]);

export const LOGEN_CORE_PATHS = new Set(
  LOGEN_PUBLIC_APIS.filter((api) => api.phase === "core").map((api) => api.path)
);

export function logenCapabilities() {
  return {
    sourceRevisionDate: "2026-07-19",
    publicApiCount: LOGEN_PUBLIC_APIS.length,
    implementedApiCount: LOGEN_PUBLIC_APIS.filter((api) => api.phase !== "planned").length,
    unavailablePublicSpecCount: LOGEN_UNPUBLISHED_APIS.length,
    apis: LOGEN_PUBLIC_APIS,
    unavailable: LOGEN_UNPUBLISHED_APIS,
  };
}
