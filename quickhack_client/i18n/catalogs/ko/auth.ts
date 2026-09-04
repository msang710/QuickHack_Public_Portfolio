export const authKo = {
  sensitiveAction: {
    recoveryLabel: "민감 메뉴 OTP 복구코드", title: "2차 인증 필요", description: "{menu} 메뉴는 채널 상품과 주문 매칭에 영향을 주므로 OTP 코드를 확인합니다. OTP가 설정되지 않은 계정은 오른쪽에서 먼저 등록하세요.", code: "OTP 코드", checking: "인증 상태 확인중", submitting: "확인중", open: "확인 후 열기", recoveryRequired: "먼저 OTP 복구코드를 안전하게 보관하고 ‘보관 완료’를 누르세요.",
    message: { authStatusFailed: "인증 상태를 확인하지 못했습니다.", invalidMenu: "2차 인증 대상 메뉴가 올바르지 않습니다.", qrFailed: "QR 코드를 생성하지 못했습니다. 인증 앱 등록 키를 수동으로 입력하세요.", setupCodePrompt: "인증 앱에 OTP 키를 등록한 뒤 6자리 코드를 입력하세요.", setupComplete: "OTP 등록이 완료되었습니다. 다음 2차 인증부터 OTP 코드를 사용합니다.", setupConfirmFailed: "OTP 코드를 확인하지 못했습니다.", setupStartFailed: "OTP 등록을 시작하지 못했습니다.", statusFailed: "OTP 상태를 확인하지 못했습니다.", verifyFailed: "OTP 인증에 실패했습니다." },
    setup: { title: "OTP 등록", description: "OTP를 등록하면 이후 민감 메뉴는 인증 앱의 6자리 코드로 확인합니다.", loading: "OTP 상태 확인중", enabled: "이 계정은 OTP 2차 인증이 설정되어 있습니다.", unavailable: "OTP 보안 서비스를 사용할 수 없어 보호된 작업이 차단되었습니다. 관리자는 QuickHack 본서버 콘솔에서 OTP 보안 상태를 확인해야 합니다.", password: "현재 비밀번호", start: "OTP 등록 시작", qrAlt: "Google OTP 등록 QR 코드", qrLoading: "QR 코드 생성 중", qrHint: "Google OTP 앱에서 QR 코드를 스캔하세요.", secret: "인증 앱 등록 키", uri: "등록 URI", code: "인증 앱 6자리 코드", confirm: "OTP 등록 완료" },
    dialog: { cancel: "취소", busy: "처리중" }
  },
  login: {
    brandSubtitle: "내부 ERP/WMS",
    heroTitle: "직원 로그인",
    heroDescription: "기기, 입고, 검수, 재고, 주문, 출고, 반품 데이터를 직원 계정 기준으로 관리합니다.",
    title: "로그인",
    description: "발급된 직원 계정으로 접속하세요.",
    username: "아이디",
    password: "비밀번호",
    submit: "로그인",
    pending: "로그인 중...",
    testAccount: "테스트 계정",
    errors: { failed: "로그인에 실패했습니다.", unavailable: "서버에 연결할 수 없습니다.", timeout: "서버 응답 시간이 초과되었습니다. 잠시 뒤 다시 시도해 주세요.", invalidServerResponse: "중앙 서버 응답이 올바르지 않습니다.", invalidCredentials: "로그인 정보가 올바르지 않습니다.", bodyTooLarge: "로그인 요청 본문이 너무 큽니다.", credentialsRequired: "아이디와 비밀번호를 입력하세요.", invalidRequest: "잘못된 로그인 요청입니다.", rateLimited: "로그인 실패가 반복되어 잠시 제한되었습니다. {seconds, number}초 후 다시 시도하세요." },
  },
  passwordChange: {
    title: "비밀번호 변경", forcedTitle: "새 비밀번호 설정", currentPassword: "현재 비밀번호", nextPassword: "새 비밀번호", confirmPassword: "새 비밀번호 확인",
    description: { forced: "임시 비밀번호를 본인만 아는 새 비밀번호로 변경해야 업무 화면을 사용할 수 있습니다.", normal: "변경이 완료되면 다른 PC를 포함한 기존 로그인 세션이 모두 종료됩니다." },
    minimum: "새 비밀번호는 {count, number}자 이상이어야 합니다.", submitting: "변경 중", success: "비밀번호를 변경했습니다.", failed: "비밀번호를 변경하지 못했습니다.",
    validation: { currentRequired: "현재 비밀번호를 입력하세요.", tooShort: "새 비밀번호는 {count, number}자 이상이어야 합니다.", mismatch: "새 비밀번호 확인이 일치하지 않습니다.", unchanged: "현재 비밀번호와 다른 새 비밀번호를 입력하세요.", currentInvalid: "현재 비밀번호가 올바르지 않습니다.", securityChanged: "다른 요청에서 계정 보안 정보가 먼저 변경되었습니다. 다시 로그인한 뒤 시도하세요." },
  },
  passwordRequired: { subtitle: "내부 ERP/WMS", title: "비밀번호 변경이 필요합니다", description: "{name} 계정은 임시 비밀번호로 로그인했습니다. 새 비밀번호를 설정하기 전에는 업무 메뉴와 다른 계정 설정을 사용할 수 없습니다.", logout: "로그아웃", logoutFailed: "로그아웃하지 못했습니다." },
} as const;
