# QuickHack Logen Mock Server

로젠택배 공개 Open API 문서의 요청·응답 계약을 로컬에서 재현하는 개발용 서버입니다.
실제 로젠 서버, 실제 고객 데이터, 운영 `secretKey`와 연결하지 않습니다.

## 실행

```powershell
npm run mock:logen
```

- 기본 URL: `http://127.0.0.1:3200`
- 기본 테스트 키: `LOGEN-MOCK-TEST-SECRET`
- 상태 확인: `GET /health`
- 구현 현황: `GET /admin/capabilities`
- 데이터 확인: `GET /admin/state`
- 데이터 초기화: `POST /admin/reset`
- iLOGEN 주문 Mock 출력: `POST /admin/ilogen/print`
- 배송 단계 진행: `POST /admin/shipments/advance`
- 반품 단계 진행: `POST /admin/returns/advance`
- 장애 정책: `GET/POST /admin/failure-policy`

관리 API는 loopback 접속만 허용합니다.

## 현재 구현 API

- `POST /lrm02b-edi/edi/contractTotalInfo`
- `POST /lrm02b-edi/edi/contPickFares`
- `POST /lrm02b-edi/edi/getSlipNo`
- `POST /lrm02b-edi/edi/integratedInquiry`
- `POST /lrm02b-edi/edi/slipPrintM`
- `POST /lrm02b-edi/edi/registerOrderData`
- `POST /lrm02b-edi/edi/inquirySlipNoMulti`
- `GET /lrm02b-edi/edi/outSlipPrintPop`
- `POST /lrm02b-edi/edi/registReturnRequest`
- `POST /lrm02b-edi/edi/reverseChkInfoMulti`
- `POST /lrm02b-edi/edi/inquiryReserveStateMulti`
- `POST /lrm02b-edi/edi/inquiryReserveStateFixTakeNo`
- `POST /lrm02b-edi/edi/inquiryReturnStateMulti`
- `POST /lrm02b-edi/edi/inquiryCargoTrackingMulti`
- `POST /lrm02b-edi/edi/inquiryCargoTrackingMultiLast`
- `POST /lrm02b-edi/edi/custExtraFare`

공개 상세 규격을 확인한 16개 API를 구현했습니다. 공개 호출 규격을 확인하지 못한 안심번호,
반품 계약운임, 반품 취소 API는 경로를 추측해서 만들지 않습니다.

배송과 반품 상태는 기본적으로 자동 진행되며 테스트에서는 환경변수로 자동 진행을 끄고
관리 API를 호출해 결정적으로 진행할 수 있습니다. 장애 정책은 HTTP 오류, 타임아웃,
잘못된 JSON, 필수 필드 누락, 일부 데이터 유실, 쓰기 적용 후 응답 유실을 지원합니다.

## 테스트

```powershell
npm run test:mock-logen
npm run verify:carrier
```

테스트는 격리된 임시 PostgreSQL schema와 별도 포트를 사용합니다.
