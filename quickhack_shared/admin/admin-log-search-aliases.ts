export const ACTIVITY_ACTION_SEARCH_LABELS: Readonly<Record<string, string>> = {
  INBOUND_BATCH_PLAN_CREATE: "차수 지정 생성",
  INBOUND_BATCH_PLAN_UPDATE: "차수 지정 수정",
  INBOUND_BATCH_PLAN_DELETE: "차수 지정 삭제",
  PURCHASE_PRICE_RATE_UPSERT: "매입가 지정 저장",
  PURCHASE_CONFIRM: "매입 확정",
  INVENTORY_CORRECTION: "기존 재고 수정",
  PRODUCT_CRITERIA_UPSERT: "상품 기준값 저장",
  PRODUCT_CRITERIA_RELATIONS_UPDATE: "연결 기준값 저장",
  CHANNEL_ORDER_MAPPING_SET: "채널 주문 매칭 저장",
  CHANNEL_ORDER_MAPPING_REAPPLY: "기존 주문 매핑 재적용",
  COUPANG_ORDER_AUTO_MATCH: "쿠팡 주문 자동 매칭",
  USER_ACCOUNT_CREATE: "사용자 계정 생성",
  USER_ACCOUNT_UPDATE: "사용자 계정 수정",
  USER_ACCOUNT_DEACTIVATE: "사용자 계정 비활성화",
  USER_TOTP_RESET: "사용자 OTP 초기화",
  USER_TOTP_RECOVERY_CODES_GENERATE: "OTP 복구코드 발급",
  SYSTEM_TOTP_SECURITY_RESET: "OTP 보안 전체 초기화",
  SALES_OFFER_CREATE: "판매 구성 생성",
  SALES_OFFER_ACTIVATE: "판매 구성 활성화",
  SALES_OFFER_DEACTIVATE: "판매 구성 비활성화",
  SALES_OFFER_BOOTSTRAP: "기본 판매 구성 확인",
};

export const ACTIVITY_TARGET_SEARCH_LABELS: Readonly<Record<string, string>> = {
  INBOUND_BATCH: "차수",
  INBOUND: "입고",
  PURCHASE_PRICE_RATE: "매입가",
  PURCHASE_CONFIRM: "매입 확정",
  DEVICE: "기기",
  USER: "사용자 계정",
  PRODUCT_CRITERIA_OPTION: "상품 기준값",
  SALES_CHANNEL_ORDER_ITEM: "판매 채널 주문",
  CHANNEL_PRODUCT_MAPPING: "채널 상품 매핑",
  CHANNEL_ORDER_MAPPING: "채널 주문 매칭",
  SALES_OFFER: "판매 구성",
};

export const ACTIVITY_RESULT_SEARCH_LABELS: Readonly<Record<string, string>> = {
  SUCCESS: "성공",
  FAIL: "실패",
  FAILED: "실패",
  ERROR: "실패 오류",
};

export const SERVER_JOB_SEARCH_LABELS: Readonly<Record<string, string>> = {
  USER_OPERATION_TRACE: "사용자 조작 성능",
  COUPANG_ORDER_SYNC: "쿠팡 주문 수집",
  COUPANG_ORDER_MATCH: "쿠팡 주문 매칭",
  COUPANG_PRODUCT_SYNC: "쿠팡 상품 동기화",
  INVOICE_REGISTER: "송장 등록",
  DATABASE_BACKUP: "DB 백업",
  DATABASE_RESTORE: "DB 복구",
};

export const SERVER_STATUS_SEARCH_LABELS: Readonly<Record<string, string>> = {
  PENDING: "대기",
  RUNNING: "실행 중",
  SUCCESS: "성공",
  FAILED: "실패",
  FAIL: "실패",
  ERROR: "오류",
  SKIPPED: "건너뜀",
  CANCELED: "취소",
};

export const SERVER_FIELD_SEARCH_LABELS: Readonly<Record<string, string>> = {
  trace_id: "Trace ID",
  source: "실행 원천",
  route: "API 경로",
  method: "HTTP 메서드",
  target_count: "처리 대상 수",
  "query.count": "DB 쿼리 수",
  "query.read_count": "DB 읽기 수",
  "query.write_count": "DB 쓰기 수",
  "query.total_ms": "DB 쿼리 합계",
  "query.max_ms": "최장 DB 쿼리",
  "transaction.count": "트랜잭션 수",
  "transaction.wait_ms": "트랜잭션 대기",
  "transaction.run_ms": "트랜잭션 실행",
  "transaction.total_ms": "트랜잭션 전체",
  "transaction.max_ms": "최장 트랜잭션",
};

export function searchAliasCodes(
  query: string,
  labels: Readonly<Record<string, string>>
) {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  if (!normalized) return [];
  return Object.entries(labels)
    .filter(([, label]) => label.toLocaleLowerCase("ko-KR").includes(normalized))
    .map(([code]) => code);
}
