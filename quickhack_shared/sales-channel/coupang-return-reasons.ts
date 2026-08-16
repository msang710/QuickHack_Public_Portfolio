// QuickHack note: Coupang VOC reason codes are stored as API codes, but work screens should show operator-facing labels.
const COUPANG_VOC_REASON_LABELS: Record<string, string> = {
  CHANGEMIND: "필요 없어짐 (단순 변심)",
  NOLONGERNEED: "필요 없어짐",
  DIFFERENTOPT: "색상/ 사이즈가 기대와 다름(같은 상품의 다른 옵션으로 교환)",
  DONTLIKESIZECOLOR: "색상, 사이즈가 기대와 다름",
  CHEAPER: "다른 사이트의 가격이 더 저렴함",
  WRONGOPT: "상품의 옵션 선택을 잘못함",
  DELIVERYLATER: "배송 예정일이 예상보다 늦음",
  WRONGADDRESS: "배송지 입력 실수",
  REORDER: "상품을 추가하여 재주문",
  OTHERS: "기타",
  OTHERS_CHANGEMIND: "그외 (단순변심)",
  DELIVERYSTOP: "배송흐름이 멈춤",
  CARRIERLOST: "택배사 상품 분실",
  LOST: "배송주소 오배송(원인파악 불가 포함)",
  PARTIALMISS: "주문상품 중 일부가 배송되지 않음",
  COMPOMISS: "상품의 구성품, 부속품이 제대로 들어있지 않음",
  LATEDELIVERED: "상품이 늦게 배송됨",
  SKUOOSRESHIP: "SKU OOS로 나머지 상품 재출고",
  DELIVERYSTUCK: "배송 상태가 멈춰 있음",
  LIKELYDELAY: "배송지연이 예상됨",
  DAMAGED: "상품이 파손되어 배송됨",
  DEFECT: "상품 결함/기능에 이상이 있음",
  INACCURATE: "실제 상품이 상품 설명에 써있는 것과 다름",
  BOTHDAMAGED: "포장과 상품 모두 훼손됨",
  SHIPBOXOK: "포장은 괜찮으나 상품이 파손됨",
  UNABLEBOOK: "티켓 상품 예약 불가능",
  TICKETNOUSE: "티켓 상품 지점 휴업/ 폐점으로 사용 불가능",
  PRICEERROR: "잘못된 가격 기재",
  ITEMNAMEERR: "잘못된 상품명 기재",
  OTHERS_PRODUCT: "그외 (상품문제)",
  WRONGDELIVERY: "내가 주문한 상품과 아예 다른 상품이 배송됨",
  WRONGSIZECOL: "내가 주문한 상품과 다른 색상/사이즈의 상품이 배송됨",
  OTHERS_DELIVERY: "그외 (배송문제)",
  OOSSELLER: "업체로부터 품절되었다고 연락 받음",
  UNUSEDTICKET: "티켓 상품의 미사용 환불 취소",
  DUPLICATE: "Abusing 의심 중복구매 취소",
  SKUOOSCAN: "SKU OOS 취소",
  SYSTEMERROR: "시스템 오류",
  SYSTEMINFO_ERROR: "상품 정보가 잘못 노출됨(쿠팡 시스템 오류)",
  EXITERROR: "주문 이탈",
  PAYERROR: "결제 오류",
  PARTNERERROR: "제휴사이트 오류",
  REGISTERROR: "쿠폰 등록 오류",
  NOTPURCHASABLE: "구매 불가능",
};

// Coupang's VOC sheet contains PRICEERROR twice with different labels.
// When only the code is available, keep the product-issue label as the fallback.
const COUPANG_VOC_REASON_DUPLICATE_LABELS: Record<string, string[]> = {
  PRICEERROR: ["잘못된 가격 기재", "가격 등재 오류"],
};

const COUPANG_RETURN_REASON_ALIASES: Record<string, string> = {
  CHANGE_MIND: "단순 변심(사유 없음)",
  EXCHANGE_REQUEST: "교환 요청",
};

const COUPANG_REASON_LABEL_NORMALIZATIONS: Record<string, string> = {
  "단순변심(사유없음)": "단순 변심(사유 없음)",
  "단순 변심(사유없음)": "단순 변심(사유 없음)",
  "단순변심(사유 없음)": "단순 변심(사유 없음)",
};

function reasonCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeCoupangReasonLabel(value: unknown) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  return COUPANG_REASON_LABEL_NORMALIZATIONS[text] ?? text;
}

export function coupangReturnReasonLabel(value: unknown) {
  const code = reasonCode(value);

  if (!code) {
    return "";
  }

  return COUPANG_RETURN_REASON_ALIASES[code] ?? COUPANG_VOC_REASON_LABELS[code] ?? "";
}

export function coupangReturnReasonDuplicateLabels(value: unknown) {
  const code = reasonCode(value);

  return code ? COUPANG_VOC_REASON_DUPLICATE_LABELS[code] ?? [] : [];
}
