export const salesChannelKo = { orderMatching: {
  fallback: { rematchExecuteFailed: "기존 주문 재매칭을 완료하지 못했습니다.", rematchPreviewFailed: "기존 주문 재매칭 대상을 조회하지 못했습니다." },
  rematchExclusion: { SHIPMENT_NOT_FULLY_MATCHED: "출고 건 전체가 매칭 완료 상태가 아님", CURRENT_MAPPING_UNAVAILABLE: "현재 적용할 상품 기본 매핑이 없음", ALLOCATION_QUANTITY_MISMATCH: "주문 수량과 활성 PG 배정 수량이 다름", ALLOCATION_NOT_REVERSIBLE: "이미 출력 확정된 PG 배정이 있음", INVENTORY_NOT_RESERVED: "PG 재고가 주문확인 상태가 아님", OUTBOUND_HANDOFF_STARTED: "출력 차수 또는 합포장 작업이 시작됨", WRITE_REQUEST_PENDING: "외부 API 처리 또는 확인이 진행 중임", RETURN_FLOW_EXISTS: "반품 처리가 진행 중이거나 연결된 이력이 있음", SALES_RECORD_EXISTS: "매출 원장이 이미 생성됨", ORDER_STATUS_NOT_REVERSIBLE: "쿠팡 주문이 재매칭 가능 단계를 지남", SNAPSHOT_INCONSISTENT: "주문·오퍼·PG 배정 스냅샷이 서로 다름" },
  common: { mapped: "매핑됨", unmapped: "미매핑", all: "전체", active: "활성", inactive: "비활성", allStorage: "전체 용량", allColor: "전체 색상", allValue: "전체", noMapping: "매핑 없음", noLocation: "위치 없음", noInventory: "재고 없음", noStatus: "상태 없음", count: "{count, number}건", devices: "{count, number}대" },
  summary: { options: "쿠팡 옵션", mapped: "매핑됨", unmapped: "미매핑", offers: "활성 오퍼" },
  toolbar: { search: "vendorItemId, 상품명, 기종, 보증, 용량, 색상 검색", refresh: "새로고침", preview: "재매칭 대상 확인" },
  columns: { option: "쿠팡 옵션", productOption: "상품/옵션", offer: "판매 오퍼", offerCondition: "기종/조건/보증", storageCondition: "용량 조건", storage: "용량", colorCondition: "색상 조건", color: "색상", status: "상태", orders: "주문", orderCount: "주문 수" },
  detail: { title: "채널 주문 매칭 기준", subtitle: "쿠팡 vendorItemId를 QuickHack의 기종/보증조건 조합과 용량/색상 조건에 연결합니다.", option: "쿠팡 옵션", productName: "상품명", updated: "최근 수정", offer: "판매 오퍼", offerSearch: "기종, 용량, 색상 또는 보증조건 검색", offerCode: "오퍼 코드", model: "기종", storage: "용량", color: "색상", warranty: "보증조건", offerStatus: "오퍼 상태", saving: "저장중", save: "매칭 저장", clear: "매핑 해제", previewing: "조회중", inventoryPreview: "재고 후보 미리보기", candidates: "재고 후보 {count, number}건", noCandidates: "조회된 재고 후보가 없습니다.", select: "왼쪽 표에서 쿠팡 옵션을 선택하세요." },
  grid: { loading: "쿠팡 상품 매핑 목록을 불러오는 중입니다.", empty: "표시할 쿠팡 상품 매핑이 없습니다." },
  message: { candidateLoadFailed: "재고 후보를 조회하지 못했습니다.", mappingLoadFailed: "쿠팡 상품 매핑 목록을 불러오지 못했습니다.", offerLoadFailed: "판매 오퍼 목록을 불러오지 못했습니다.", rematchComplete: "기존 배정 {allocations, number}건을 해제하고 주문 {shipments, number}건을 다시 매칭했습니다. 완료 {completed, number}건, 부분 {partial, number}건, 실패 {failed, number}건입니다.", rematchAfterResetFailed: "기존 배정은 안전하게 해제되었지만 즉시 재매칭을 완료하지 못했습니다. 주문 매칭 상태를 다시 확인해 주세요.", saveFailed: "매칭 기준을 저장하지 못했습니다.", saved: "매칭 기준을 저장했습니다. 변경 가능한 주문 {updated, number}건에 반영했습니다.", savedWithProtected: "매칭 기준을 저장했습니다. 변경 가능한 주문 {updated, number}건에 반영했고, 진행 또는 완료 이력이 있는 주문 {protected, number}건은 기존 매핑을 유지했습니다.", unchanged: "동일한 매칭 기준입니다. 저장된 데이터는 변경하지 않았습니다." },
  candidateWarning: { CANDIDATE_LOAD_FAILED: "재고 후보를 조회하지 못했습니다.", ACTIVE_OFFER_NOT_FOUND: "활성 판매 오퍼를 찾을 수 없습니다.", INVALID_WARRANTY_GROUP: "판매 오퍼의 보증조건이 올바르지 않습니다.", MAPPING_NOT_FOUND: "쿠팡 상품 매핑 행을 찾을 수 없습니다.", MAPPING_REQUIRED: "판매 상품 조합 매핑 전에는 재고 후보를 조회하지 않습니다.", MAPPED_OFFER_INACTIVE: "연결된 판매 오퍼가 없거나 비활성화되어 있습니다.", RANDOM_STORAGE_BUCKET: "용량 랜덤 조건에 따라 한 용량 후보군을 선택했습니다.", RANDOM_COLOR_BUCKET: "색상 랜덤 조건에 따라 한 색상 후보군을 선택했습니다.", GRADE_FALLBACK: "{warrantyGroup} 기본 우선순위 재고가 없어 {grades} 등급을 조회했습니다." },
  rematch: { title: "기존 주문 재매칭 대상 확인", subtitle: "매칭 완료 후 아직 출고 작업에 전달되지 않은 출고 건을 확인합니다. 전체 목록을 확인한 뒤 별도 확인 단계에서 재매칭할 수 있습니다.", allPages: "모든 페이지를 확인해야 재매칭을 실행할 수 있습니다.", revalidate: "실행 시점에 재매칭 대상만 다시 잠금·검증합니다.", close: "닫기", executeCount: "대상 {count, number}건 재매칭", reviewed: "검토 출고 건", eligible: "재매칭 대상", excluded: "제외", targetPg: "대상 PG", reasons: "제외 사유", privacy: "주문번호와 배송번호 단위로 전체 품목을 판정합니다. 수취인·주소·전화번호는 조회하지 않습니다.", basis: "기준 {date}", empty: "확인할 매칭 완료 출고 건이 없습니다.", order: "주문 {id}", shipment: "배송 {id}", shipmentSummary: "쿠팡 {status} · 품목 {items, number}건 · PG {allocations, number}대", quantity: "vendorItemId {id} · 수량 {quantity, number}", snapshot: "기존 주문 스냅샷", current: "현재 기본 매핑", retry: "다시 판정", more: "다음 대상 더 보기", loading: "재매칭 대상과 제외 사유를 판정하는 중입니다.", confirmTitle: "기존 미포장 주문을 다시 매칭합니다", confirmDescription: "표시된 모든 대상의 기존 PG 배정을 해제하고 현재 기본 상품 매핑으로 다시 매칭합니다. 표시 후 상태가 바뀌었다면 전체 작업을 중단합니다.", confirmSummary: "출고 건 {shipments, number}건 · 주문 항목 {items, number}건 · PG {allocations, number}대", confirmNote: "대상 목록의 주문번호·배송번호·PG를 다시 확인한 뒤 실행하세요.", confirm: "배정 해제 후 재매칭", busy: "재매칭 중", refreshed: "목록을 확인하는 동안 주문 상태가 변경되어 첫 페이지부터 다시 표시했습니다." }
}, policy: {
  basis: {
    saleGrade: { label: "판매 등급 기준", value: "정책의 판매등급 우선순위" },
    stockAge: { label: "재고 등록 시간 기준", value: "재고 등록 시간을 기준으로 선택" },
  },
  rules: {
    orderCanceled: { label: "취소 여부", value: "취소되지 않은 주문 아이템", note: "취소된 주문 아이템은 자동 매칭 대상에서 제외합니다." },
    matchableQuantity: { label: "매칭 가능 수량", value: "matchable_quantity > 0", note: "실제로 출고 가능한 수량이 남아 있는 아이템만 처리합니다." },
    mappingStatus: { label: "상품 매핑 상태", value: "MAPPED", note: "채널 상품이 QuickHack 판매 오퍼에 연결되어 있어야 합니다." },
    salesOffer: { label: "판매 오퍼", value: "sales_offer_id 필수", note: "기종, 옵션 조건과 보증그룹이 확정된 주문만 자동 매칭합니다." },
    inventoryStatus: { label: "재고 상태", value: "판매가능 재고", note: "매입 확정 후 판매 가능한 재고만 예약 후보로 사용합니다." },
    shipmentHistory: { label: "출고 이력", value: "활성 매칭 없음", note: "이미 주문 매칭 흐름에 들어간 PG는 후보에서 제외합니다." },
    existingMatch: { label: "기존 주문 매칭", value: "활성 매칭 없음", note: "다른 주문에 묶인 PG가 중복 예약되지 않도록 막습니다." },
    model: { label: "기종", value: "model", note: "판매 오퍼의 기종과 실제 재고 SKU 기종이 일치해야 합니다." },
    storage: { label: "용량", value: "storage", note: "판매 오퍼의 용량 조건을 재고 후보 조회에 적용합니다." },
    warrantyGroup: { label: "보증그룹", value: "warrantyGroup", note: "보증그룹에 따라 판매등급 우선순위를 적용합니다." },
  },
  worker: {
    name: { label: "worker", value: "Order inventory matching", note: "판매 채널 주문을 통합해 재고 매칭을 실행하는 worker입니다." },
    interval: { label: "기본 실행 주기", value: "120초", note: "시스템 상태 메뉴에서 스케줄을 켜고 끌 수 있습니다." },
    batch: { label: "1회 처리량", value: "최대 100개 주문 아이템", note: "worker 1회 실행 기준 처리량입니다." },
  },
  common: { readOnly: "수정 불가", saved: "개별", default: "기본", stopped: "중지", allStorage: "전체 용량", allColor: "전체 색상" },
  filter: { title: "후보 필터 순서", order: "위에서 아래 순서", direction: "재고 선택 방향", recentFirst: "최근 재고부터 선택", oldFirst: "오래된 재고부터 선택" },
  list: { empty: "표시할 판매 오퍼가 없습니다.", mappings: "채널매핑 {count, number}", orders: "주문 {count, number}" },
  tier: { title: "판매등급 후보 우선순위", description: "등급 버튼을 선택하면 후보에 포함되고, 드래그하면 선택된 등급의 순서가 바뀝니다.", rank: "{rank, number}순위", excluded: "제외" },
  editor: { select: "판매 오퍼를 선택하세요.", individualPolicy: "개별 정책", defaultPolicy: "기본 정책", reset: "기본값", save: "저장", offer: "판매 오퍼", model: "기종", warrantyGroup: "보증그룹", mappingOrders: "채널 매핑 / 주문", mappingOrdersValue: "{mappings, number} / {orders, number}건", policyName: "정책 이름", policyNamePlaceholder: "예: S24 2년보증 A 우선", autoMatch: "이 판매 오퍼 자동 매칭 사용", gradeFallback: "다음 등급까지 자동 탐색" },
  message: { loadFailed: "주문 매칭 정책을 불러오지 못했습니다.", loaded: "판매 오퍼 정책 {count, number}건을 불러왔습니다.", saveFailed: "주문 매칭 정책 저장에 실패했습니다.", saved: "판매 오퍼 주문 매칭 정책을 저장했습니다.", reset: "판매 오퍼 정책을 기본값으로 되돌렸습니다." },
  unsaved: { form: "주문 매칭 정책", formOffer: "{offer} 주문 매칭 정책", open: "{offer} 주문 매칭 정책 열기", reload: "주문 매칭 정책 새로고침" },
  page: { title: "판매 오퍼별 우선순위 정책", description: "QuickHack 판매상품 조합마다 후보 재고 탐색 순서를 지정합니다.", individualCount: "개별 {count, number}건", refresh: "새로고침", searchPlaceholder: "오퍼 코드, 기종, 용량, 색상 검색", total: "전체", individual: "개별", search: "검색", loading: "판매 오퍼 정책을 불러오는 중입니다." },
  sections: {
    orderTitle: "주문 아이템 고정 조건", orderDescription: "자동 매칭 worker가 주문 아이템을 처리 대상으로 삼기 전에 반드시 확인하는 조건입니다.",
    inventoryTitle: "후보 재고 고정 조건", inventoryDescription: "실제 PG 재고가 주문에 예약되기 전에 반드시 만족해야 하는 조건입니다.",
    matchingTitle: "판매상품 조합 기준", matchingDescription: "채널 상품 매핑에서 넘어온 값과 QuickHack 판매상품 조합을 기준으로 후보 재고를 좁힙니다.",
    flowTitle: "자동 매칭 처리 순서", currentCode: "현재 코드 기준",
    step1: { title: "주문 대상 확인", text: "취소, 수량, 상품 매핑, 판매상품 조합 조건을 먼저 확인합니다." },
    step2: { title: "후보 재고 조회", text: "판매가능 재고 중 출고나 활성 매칭이 없는 PG만 가져옵니다." },
    step3: { title: "PG 예약", text: "선택된 PG의 재고 상태를 예약으로 바꾸고 매칭 이력을 남깁니다." },
    step4: { title: "주문 상태 갱신", text: "아이템, 배송 단위, 주문 전체의 매칭 상태를 다시 계산합니다." },
    safety: "판매 오퍼별 정책은 후보 탐색 우선순위만 조정합니다. 취소 주문 제외, 판매가능 재고만 사용, 이미 출고/매칭된 PG 제외 같은 안전 조건은 운영 화면에서 수정할 수 없습니다.",
    implementation: "지금 단계에서는 정책 저장 구조와 UI를 먼저 잡았습니다. 실제 자동 매칭 worker가 이 판매 오퍼 정책을 읽어 후보 조회에 적용하는 부분은 다음 단계에서 연결합니다."
  }
}, manualMatch: {
  title: "주문 변경 요청", description: "판매채널에 이미 접수된 주문만 처리합니다. 독립 출고는 재고 수정에서 상태를 보류로 변경하세요.", searchPlaceholder: "주문번호, 출고번호, 상품명", search: "검색", empty: "조회된 판매채널 주문이 없습니다.", recovery: "복구 필요: {reason}", selectOrder: "변경할 주문 품목을 선택하세요.", shipment: "출고 {id} · {item}", noPg: "PG 없음",
  workStatus: { UNMATCHED: "매칭 대기", MATCHED: "매칭 완료", PARTIAL: "부분 매칭", FAILED: "매칭 실패", SKIPPED: "매칭 제외", EXPIRED: "매칭 만료", unknown: "알 수 없는 매칭 상태 ({code})" },
  allocationStatus: { ALLOCATED: "PG 배정", API_ACKED: "판매채널 확인", SHIPMENT_LIST_PRINTED: "출고 목록 출력", CANCELED: "배정 취소", unknown: "알 수 없는 배정 상태 ({code})" },
  recoveryStatus: { reassignmentRequired: "PG 재배정 필요" },
  form: { operation: "작업", assign: "PG 배정", replace: "PG 교체", release: "PG 해제", currentPg: "현재 PG", newPg: "새 PG", pgSearch: "판매 가능 PG 검색", requestChannel: "요청 접수 경로", coupang: "쿠팡 문의", phone: "유선 문의", other: "기타", reason: "변경 사유" },
  permission: { readOnly: "STAFF는 조회만 가능하며 MANAGER와 OTP 인증이 변경에 필요합니다.", disabled: "주문 PG 변경 기능이 운영 설정에서 비활성화되어 있습니다. 영향 확인만 가능합니다." },
  message: { candidatesLoadFailed: "PG 후보를 불러오지 못했습니다.", listLoadFailed: "목록을 불러오지 못했습니다.", previewFailed: "변경 영향을 확인하지 못했습니다.", executeFailed: "PG 변경을 실행하지 못했습니다.", postCyclePending: "PG 변경은 반영됐고 판매채널 후속 처리는 진행 중입니다.", postCycleFailed: "PG 변경은 반영됐지만 판매채널 후속 처리를 완료하지 못했습니다. 주문 매칭 상태를 다시 확인해 주세요.", executeComplete: "주문 PG 변경과 후속 처리를 반영했습니다." },
  reason: { allocationNotFound: "현재 배정을 찾을 수 없습니다.", allocationNotReversible: "현재 단계에서는 배정을 변경할 수 없습니다.", shipmentListPrinted: "출고 목록이 이미 출력됐습니다.", activePackageGroup: "활성 포장 그룹에 포함돼 있습니다.", salesRecorded: "매출이 이미 확정됐습니다.", returnStarted: "반품 처리가 시작됐습니다.", channelWritePending: "판매채널 쓰기가 진행 중입니다.", carrierShipmentExists: "택배 송장 또는 배송 처리가 이미 시작됐습니다.", carrierOperationActive: "택배 송장 발급·등록·교체 작업이 진행 중입니다.", shipmentAddressChangeActive: "배송지 변경 요청 처리가 진행 중입니다.", matchQuantityConflict: "주문 필요 수량이 이미 모두 배정됐습니다.", pgNotSellable: "선택한 PG가 판매 가능 상태가 아닙니다.", pgAlreadyAllocated: "선택한 PG가 이미 이 주문에 배정돼 있습니다.", pgNotFound: "선택한 PG를 찾을 수 없습니다.", orderStateNotEligible: "현재 판매채널 주문 상태에서는 PG를 변경할 수 없습니다.", pgSelectionRequired: "현재 주문에서 검색 결과의 PG를 다시 선택해 주세요.", orderItemCanceled: "취소된 주문 품목에는 PG를 배정하거나 교체할 수 없습니다.", manualReassignmentRequired: "PG 재배정이 끝날 때까지 출고가 차단됩니다." },
  preview: { action: "변경 영향 확인", eligible: "변경 가능", ineligible: "변경 불가", selected: "선택 PG {pg} · {model} {storage} {color}", difference: "{field}: 주문 {required} → 출고 {actual}", confirmLabel: "주문 PG 변경 확정", execute: "확정 실행" },
}, channelProducts: {
  common: { mapped: "매핑됨", unmapped: "미매핑" },
  columns: { product: "상품", productName: "상품명", productId: "상품 ID", option: "옵션", optionName: "옵션명", mapping: "매핑", orders: "주문", available: "가용수량", updated: "갱신", updatedAt: "갱신일", status: "상태", offer: "판매 오퍼", offerShort: "오퍼", storage: "용량", color: "색상" },
  message: { loadFailed: "채널 상품 목록을 불러오지 못했습니다.", incomplete: "쿠팡 상품 목록 전체를 확인하지 못해 기존 목록을 유지합니다." },
  summary: { products: "상품", options: "옵션", mapped: "매핑됨", unmapped: "미매핑" },
  toolbar: { search: "상품명, 상품 ID, vendorItemId, 옵션명 검색", all: "전체", fullyMapped: "전체 매핑됨", includesUnmapped: "미매핑 포함", refresh: "새로고침", loading: "채널 상품 목록을 불러오는 중입니다.", empty: "표시할 채널 상품이 없습니다." },
  detail: { selectTitle: "상품 선택", readOnly: "읽기 전용", channel: "채널", productId: "상품 ID", options: "옵션", optionCount: "{count, number}개", mapping: "매핑", orderItems: "주문 아이템", orderCount: "{count, number}건", available: "가용 수량", lastOrder: "마지막 주문", updated: "최근 갱신", emptyOptions: "표시할 옵션이 없습니다.", select: "상품을 선택하세요." }
} } as const;
export type SalesChannelMessages = typeof salesChannelKo;
