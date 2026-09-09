export const settingsKo = {
  personal: {
    tabs: { account: "계정 설정", personal: "개인 설정", appearance: "화면" }, account: { loading: "계정 정보를 불러오는 중입니다.", basic: "기본 정보", mine: "내 계정", role: "권한", createdAt: "계정 생성일", dirty: "저장하지 않은 계정 정보 변경사항이 있습니다.", saved: "저장된 상태입니다.", cancel: "변경 취소", saving: "저장 중", save: "계정 저장" }, role: { viewer: "조회전용", staff: "사원급", manager: "중간관리자급", leader: "리더급" },
    loading: "개인 설정을 불러오는 중입니다.", shortcuts: {
      title: "단축키", enabled: "단축키 사용", top: "상위 메뉴 이동", current: "현재 메뉴 내부", common: "공통 작업", clear: "단축키 지우기", modifier: "{action} 보조키", key: "{action} 키", press: "키를 누르세요", unset: "미지정", unassigned: "지정 안 함", error: { unsupported: "지원하지 않는 키입니다.", reserved: "Windows 또는 브라우저의 기본 동작과 충돌합니다.", duplicate: "다른 동작과 같은 단축키가 지정되어 있습니다." },
      guide: { title: "단축키 안내", description: "현재 계정에 저장된 단축키입니다.", sections: { common: "공통 작업", top: "상위 메뉴 이동", current: "현재 메뉴 하위 이동" } },
      modifiers: { none: "없음", ctrl: "컨트롤", shift: "쉬프트", alt: "알트" },
      action: { navigateMain: "메인 메뉴 이동", navigateInbound: "입고 메뉴 이동", navigateInventory: "재고 메뉴 이동", navigateShipment: "출고 메뉴 이동", navigateReturns: "반품관리 메뉴 이동", navigateInvoice: "송장 관리 메뉴 이동", navigateSupplies: "비품관리 메뉴 이동", navigateStats: "통계 메뉴 이동", navigateSystemAdmin: "시스템 관리 메뉴 이동", navigateDeveloper: "개발자 메뉴 이동", currentItem01: "현재 메뉴 1번째 하위 메뉴", currentItem02: "현재 메뉴 2번째 하위 메뉴", currentItem03: "현재 메뉴 3번째 하위 메뉴", currentItem04: "현재 메뉴 4번째 하위 메뉴", currentItem05: "현재 메뉴 5번째 하위 메뉴", currentItem06: "현재 메뉴 6번째 하위 메뉴", currentItem07: "현재 메뉴 7번째 하위 메뉴", currentItem08: "현재 메뉴 8번째 하위 메뉴", currentItem09: "현재 메뉴 9번째 하위 메뉴", currentItem10: "현재 메뉴 10번째 하위 메뉴", currentItem11: "현재 메뉴 11번째 하위 메뉴", focusSearch: "현재 화면 검색", closeWindow: "창 닫기", refreshList: "목록 새로고침", openPersonalSettings: "개인 설정 열기", openShortcutGuide: "단축키 안내 열기" },
    }, notifications: { title: "알림", windows: "윈도우 알림", inspection: "검수 완료", shipment: "배송정보 변경", returns: "반품 접수" }, status: { dirty: "저장하지 않은 변경사항이 있습니다.", saved: "저장된 상태입니다." }, actions: { defaults: "기본값", cancel: "변경 취소", saving: "저장 중", save: "저장" }
  },
  accountTotp: {
    recoveryLabel: "내 OTP 복구코드", title: "OTP 2차 인증", description: "민감한 메뉴를 열 때 인증 앱의 6자리 코드로 본인을 확인합니다.", status: { checking: "확인 중", configured: "설정됨", unconfigured: "미설정" },
    message: { statusFailed: "OTP 상태를 확인하지 못했습니다.", qrFailed: "QR 코드를 만들지 못했습니다. 등록 키를 직접 입력하세요.", actionFailed: "OTP 작업을 처리하지 못했습니다.", setupMissing: "OTP 등록 정보를 받지 못했습니다.", enterCode: "인증 앱에 등록한 뒤 표시되는 6자리 코드를 입력하세요.", confirmFailed: "OTP 등록을 완료하지 못했습니다.", confirmed: "OTP 등록이 완료되었습니다. 복구코드는 지금 안전한 곳에 보관하세요.", credentialsRequired: "현재 비밀번호와 OTP 6자리 코드를 모두 입력하세요.", disabled: "OTP 2차 인증을 해제했습니다.", recoveryIssued: "복구코드를 새로 발급했습니다.", codeInvalid: "OTP 코드가 올바르지 않습니다.", notConfigured: "이 계정에는 OTP가 설정되어 있지 않습니다.", actionUnsupported: "지원하지 않는 OTP 요청입니다.", authRequired: "로그인이 필요합니다.", invalidBody: "요청 본문이 올바르지 않습니다.", rateLimited: "OTP 인증이 잠겼습니다. {seconds, number}초 뒤 다시 시도하세요." },
    guarded: { confirm: "OTP 등록 완료", disable: "OTP 2차 인증 해제", recovery: "OTP 복구코드 재발급", disableConfirm: "이 계정의 OTP 2차 인증을 해제할까요?" },
    unavailable: "OTP 보안 서비스를 사용할 수 없어 OTP 등록과 보호된 작업이 차단되었습니다. 관리자는 QuickHack 본서버 콘솔에서 OTP 보안 상태를 확인해야 합니다.",
    setup: { password: "현재 비밀번호", start: "OTP 등록 시작", qrAlt: "OTP 등록 QR 코드", qrLoading: "QR 코드 생성 중", qrHint: "인증 앱에서 QR 코드를 스캔하세요.", secret: "인증 앱 등록 키", code: "인증 앱 6자리 코드", confirm: "OTP 등록 완료" },
    management: { verifiedAt: "등록일시", lockedUntil: "잠금 만료", recoveryRemaining: "남은 복구코드", recoveryCount: "{count, number}개", password: "현재 비밀번호", code: "현재 OTP 6자리 코드", reissue: "복구코드 재발급", disable: "OTP 해제" },
  },
  mobileApp: {
    formLabel: "포장 검수 USB 기기 등록", title: "포장 검수 모바일 연결", description: "현재 연결된 실제 USB 기기에만 등록 증명을 전달합니다. 등록 코드는 표시하지 않습니다.",
    permission: { allowed: "권한 허용", denied: "권한 없음", message: "포장 검수 접근 권한이 없습니다." },
    state: { active: "활성", provisioning: "앱 로그인 대기", reauthRequired: "재등록 필요", revoked: "폐기됨" },
    message: { loadFailed: "모바일 기기 등록 정보를 불러오지 못했습니다.", adbLoadFailed: "ADB 기기 목록을 불러오지 못했습니다.", adbUpdated: "현재 준비된 실제 USB 기기 목록을 갱신했습니다.", adbEmpty: "현재 준비된 실제 USB 기기가 없습니다.", selectDevice: "ADB 목록을 갱신하고 실제 USB 기기를 선택하세요.", provisionFailed: "USB 기기 등록에 실패했습니다.", provisioned: "USB 기기 등록 정보를 전달했습니다.", revokeFailed: "기기 등록 폐기에 실패했습니다.", revoked: "기기 등록을 폐기했습니다." },
    revokeConfirm: "{device} 등록을 폐기할까요?", device: "실제 USB ADB 기기", select: "ADB 기기 선택", refresh: "ADB 갱신", label: "기기 라벨", labelPlaceholder: "예: 포장라인 1번 기기", register: "선택한 USB 기기 등록", revision: "리비전 {revision, number}", activatedAt: "활성화", lastSeenAt: "마지막 호출", reregister: "선택 USB로 재등록", revoke: "폐기", empty: "이 계정에 등록된 포장 검수 기기가 없습니다.", loadMore: "다음 등록 불러오기",
  },
  language: {
    description: "저장 후 QuickHack의 메뉴와 시스템 메시지에 적용됩니다.",
    english: "English",
    korean: "한국어",
    label: "표시 언어",
    title: "언어",
  },
} as const;
