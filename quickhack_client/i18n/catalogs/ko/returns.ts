export const returnsKo = {
  actionDraft: { target: "반품 처리", form: "반품 처리 입력" },
  format: { modelSequence: "{value, number}번" },
  message: { actionComplete: "반품 처리가 완료되었습니다.", actionFailed: "반품 처리를 완료하지 못했습니다.", loadFailed: "반품 목록을 불러오지 못했습니다.", reviewRequired: "쿠팡 상태를 자동으로 확정하지 못해 판매 채널 동기화 점검으로 이동했습니다.", actionMismatch: "현재 접수상태에서는 {action} 작업만 가능합니다." },
  actions: { cancel: "취소", loadMore: "다음 반품 더 보기", loading: "불러오는 중", processing: "처리중", refresh: "목록 새로고침", reviewRequired: "API 확인 필요", stopShipment: "출고중지완료", receiveConfirm: "입고 확인", approve: "반품 완료" },
  columns: { action: "처리", address: "주소", inventoryStatus: "재고상태", orderAt: "주문일시", orderId: "주문번호", product: "상품", reason1: "사유 1", reason2: "사유 2", reason3: "사유 3", receiptStatus: "접수상태", receiver: "수취인", shipmentBatch: "출고 차수" },
  inspection: { appearanceDefect: "외관 이상", appearanceDefectPlaceholder: "예: 액정 찍힘", appearanceGrade: "외관 등급", appearanceGradePlaceholder: "예: A, B, 파손", description: "반품 완료 처리와 함께 선택한 PG별 검수 결과를 기록합니다.", functionDefect: "기능 이상", functionDefectPlaceholder: "예: 충전 불량", note: "검수 메모", notePlaceholder: "포장 상태, 누락 구성품, 재판매 판단 근거", result: { disposal: "폐기", failed: "불량", hold: "보류", passed: "재판매 가능", returnToSupplier: "매입처 반품" }, title: "반품검수 입력" },
  modal: { allocation: "PG 연결", cancelCount: "반품 수량", candidateEmpty: "이 반품 접수와 연결할 수 있는 매칭 PG가 없습니다. 쿠팡 반품 처리는 PG 연결 없이 진행됩니다.", description: "연결 가능한 PG를 선택한 뒤 {action}합니다.", footerLocked: "반품 완료는 입고 확인 때 연결한 PG와 동일한 PG로만 처리됩니다.", footerNoCandidate: "매칭 PG가 없는 주문은 PG 연결 없이 쿠팡 처리만 진행합니다.", footerSelection: "PG 연결 수량이 가능한 PG 수량과 일치해야 쿠팡 처리 버튼이 활성화됩니다.", item: "배송 {shipmentId} · 상품 {itemId}", missing: "연결 부족 {count, number}", orderId: "주문번호", receiptId: "접수번호", select: "{selected, number} / {required, number} 선택", title: "반품 PG 선택", unit: "{count, number}대" },
  phase: { after: { empty: "출고 후 기준에 해당하는 쿠팡 반품 접수 데이터가 없습니다.", loading: "출고 후 반품목록을 불러오는 중입니다.", title: "출고 후 반품목록" }, before: { empty: "출고 전 기준에 해당하는 쿠팡 반품 접수 데이터가 없습니다.", loading: "출고 전 반품목록을 불러오는 중입니다.", title: "출고 전 반품목록" } },
  receiptStatus: { completed: "반품완료", confirm: "입고 확인", receipt: "반품접수", requestCheck: "쿠팡 확인 요청", stop: "출고중지 요청" },
  summary: { after: "출고 후", before: "출고 전", coverage: "접수 건수는 전체 대상 기준이며, 나머지 연결 요약은 현재 불러온 페이지 기준입니다.", linkedOrders: "연결주문", linkedShipments: "연결출고", matchedPg: "매칭PG", receipts: "접수", statusCheck: "상태확인" },
  supplies: { description: "실제 출고 때 차감된 비품 중 다시 사용할 수 있는 품목만 선택합니다.", empty: "해당 출고에서 차감된 비품 이력이 없습니다.", recovered: "복구 완료", recoverOnReturn: "회수 시 재고 복구", title: "회수 비품", unavailable: "재사용 불가", unit: "{count, number}개" },
} as const;

export type ReturnsMessages = typeof returnsKo;
