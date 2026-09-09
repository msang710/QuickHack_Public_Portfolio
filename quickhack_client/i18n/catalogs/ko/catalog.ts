export const catalogKo = {
  productCriteria: {
    category: { productModel: "제품명 / 모델코드", carrier: "통신사", storage: "저장공간", deviceColor: "공식 색상명", appearanceGrade: "외관등급", saleGrade: "판매등급", warrantyGroup: "판매 보증조건", appearanceDefect: "외관하자", functionDefect: "기능하자", cameraLens: "카메라 렌즈 배율", cameraFocusRule: "카메라 초점 기준" },
    common: { all: "전체", selected: "{count, number}개 선택", selectAll: "{title} 전체 선택", empty: "표시할 기준값이 없습니다.", saving: "저장중", active: "사용", inactive: "비활성" },
    camera: { title: "카메라 점검 기준", description: "상품 기준값에 등록된 렌즈 배율을 선택하고, 렌즈별 초점 기준을 지정합니다.", selectAll: "카메라 렌즈 전체 선택", focus: "초점 기준", empty: "등록된 카메라 렌즈 배율 기준값이 없습니다." },
    relation: { form: "상품 연결 기준", formModel: "{model} 연결 기준", saveFailed: "연결된 기준값 저장에 실패했습니다.", verifyFailed: "저장된 연결 기준값을 확인하지 못했습니다.", saved: "연결된 기준값을 저장했습니다.", refreshRequired: "{result} 전체 기준값은 새로고침해 확인하세요.", open: "{model} 연결 기준 열기", otherModel: "다른 기종", model: "기종", modelPlaceholder: "연결값을 편집할 기종", save: "연결값 저장", description: "이 탭은 기종과 연결되는 용량, 공식 색상명, 카메라 점검 기준을 관리합니다. 기준값 자체의 이름은 왼쪽 탭에서 수정합니다.", cameraSummary: "현재 카메라 기준: {summary}", storage: "연결 저장공간", color: "연결 공식 색상명", emptyModel: "연결값을 편집할 기종 기준값이 없습니다." },
    option: { form: "새 상품 기준값", formSelected: "{label} 상품 기준값", loadFailed: "상품 기준값 조회에 실패했습니다.", category: "분류", parent: "상위값", key: "기준키", label: "표시값", status: "상태", order: "순서", open: "{label} 기준값 열기", newOpen: "새 상품 기준값 작성", reload: "상품 기준값 새로고침", tabOpen: "상품 기준값 탭 열기", relationTabOpen: "연결된 기준값 편집 탭 열기", bootstrapOpen: "기본 상품 기준값 채우기", saveFailed: "상품 기준값 저장에 실패했습니다.", saved: "상품 기준값을 저장했습니다.", refreshRequired: "{result} 목록 새로고침이 필요합니다.", bootstrapFailed: "기본 기준값 확인에 실패했습니다.", bootstrapDone: "기본 상품 기준값을 확인했습니다." },
    page: { optionsTab: "상품 기준값", relationsTab: "연결된 기준값 편집", search: "분류, 상위값, 기준키, 표시값 검색", categoryPlaceholder: "분류", allCategories: "전체 분류", refresh: "새로고침", loading: "기준값을 불러오는 중입니다.", editorTitle: "상품 기준값 편집", editorDescription: "저장 후 검수 화면 드롭박스와 하자 선택 기준에 반영됩니다.", newValue: "새 값", parentPlaceholder: "하자 항목의 부위명 등", keyPlaceholder: "모델코드 또는 고유 값", labelPlaceholder: "화면에 표시할 값", sortOrder: "정렬 순서", save: "기준값 저장", bootstrap: "기본값 누락분 채우기" }
  },
  salesOffer: {
    common: { random: "랜덤", all: "전체", active: "사용", inactive: "비활성", saving: "저장중" },
    warranty: { twoYear: "2년 보증", oneYear: "1년 보증" },
    form: { selected: "{code} 판매 오퍼", new: "새 판매 오퍼" },
    message: { criteriaLoadFailed: "상품 기준값을 불러오지 못했습니다.", listLoadFailed: "판매 오퍼 목록을 불러오지 못했습니다.", required: "기종과 보증조건을 선택해야 합니다.", saveFailed: "판매 오퍼를 저장하지 못했습니다.", saved: "판매 오퍼를 저장했습니다.", bootstrapFailed: "기본 판매 오퍼를 생성하지 못했습니다.", bootstrapResult: "{products, number}개 기종의 기본 판매 구성 {offers, number}건을 확인했습니다. 새로 생성 {created, number}건, 다시 활성화 {reactivated, number}건, 변경 없음 {unchanged, number}건입니다." },
    columns: { code: "오퍼 코드", model: "기종", storage: "용량", color: "색상", warranty: "보증조건", mappings: "채널매핑", mappingCount: "매핑 수", status: "상태" },
    unsaved: { new: "새 판매 오퍼 작성", open: "{code} 판매 오퍼 열기", reload: "판매 오퍼 목록 새로고침", bootstrap: "기본 판매 오퍼 생성" },
    summary: { total: "전체 오퍼", active: "사용 중", inactive: "비활성", mapped: "채널 연결" },
    toolbar: { search: "오퍼 코드, 기종, 용량, 색상 검색", active: "사용 중", inactive: "비활성", all: "전체", refresh: "새로고침", bootstrap: "기본 오퍼 생성", loading: "판매 오퍼를 불러오는 중입니다.", empty: "표시할 판매 오퍼가 없습니다." },
    editor: { title: "판매 오퍼 편집", description: "기종, 용량, 색상, 보증조건을 하나의 판매 단위로 관리합니다.", add: "추가", code: "오퍼 코드", generated: "저장 시 자동 생성", model: "기종", modelSelect: "기종 선택", storage: "용량 조건", allStorage: "전체 용량", color: "색상 조건", allColor: "전체 색상", warranty: "보증조건", warrantySelect: "보증조건 선택", status: "상태", save: "오퍼 저장" }
  }
} as const;
export type CatalogMessages = typeof catalogKo;
