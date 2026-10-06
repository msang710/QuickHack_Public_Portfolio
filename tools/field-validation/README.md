# Field validation 실행

저장소 루트에서 실행합니다. 모든 예시는 개발용 격리 환경을 대상으로 합니다.

## 모의 포장 업무

터미널 1:

```bash
node tools/field-validation/mock-server.mjs serve tools/field-validation/scenarios/packing-retry.json
```

터미널 2:

```bash
node tools/field-validation/cli.mjs run tools/field-validation/scenarios/packing-retry.json
```

시나리오는 seed로 주문·PG를 재현하고 포장 및 중복 재시도 후 상태 스냅샷을 기대값과 비교합니다. 각 응답의 업무 코드, HTTP 상태, 소요 시간, 추적 ID를 기록합니다. 모의 서버와 실행기는 `127.0.0.1`만 사용합니다. 보고서의 `INCONCLUSIVE`는 외부 제공사, Android 기기, 네트워크 RTT 검증이 실행되지 않았다는 뜻입니다.

보고서의 `sourceRevision`은 깨끗한 저장소에서는 Git HEAD, 변경된 작업트리에서는 HEAD와 Git이 추적하거나 무시하지 않는 파일 내용의 SHA-256 지문입니다. 실행 중 지문이 바뀌면 `sourceSnapshotStatus: CHANGED_DURING_RUN`을 기록하고 종료 코드 2를 반환합니다. 지문 계산에 사용한 파일 내용은 보고서에 기록하지 않습니다.

## 격리 네트워크 RTT

```bash
node tools/field-validation/lab.mjs run tools/field-validation/scenarios/network-delay.json
```

이 명령은 `qhfv-` 이름의 임시 네트워크 네임스페이스와 veth 인터페이스를 만들고 `tc netem`을 적용한 뒤 각 구간의 ping RTT를 측정합니다. `ip netns`와 `tc`에 필요한 권한이 있어야 합니다. 결과의 `NETWORK_ONLY`와 `applicationTrafficVerified: false`는 **QuickHack HTTP 요청이 이 경로를 통과했다는 증거가 아님**을 명시합니다. 명령이 실패하면 RTT 결과를 생성하지 않습니다. 네트워크 장애 실험은 실제 물리 Wi-Fi, 기기 절전, 택배사 회선 상태를 대체하지 않습니다.

## 외부 제공사 읽기 프로브

소유한 테스트 몰·운송장과 해당 계정 권한을 준비한 뒤에만 실행합니다. 자격 증명은 서버 환경 변수로 주고 결과에는 넣지 않습니다.

```bash
printf '%s' '{"runId":"run-001","courierCode":"kr.logen","trackingNumber":"123456789012"}' | node --import ./tools/field-validation/register-ts-alias.mjs tools/field-validation/provider-probe.mjs deliveryapi
printf '%s' '{"runId":"run-001"}' | node --import ./tools/field-validation/register-ts-alias.mjs tools/field-validation/provider-probe.mjs cafe24
```

DeliveryAPI는 `QUICKHACK_DELIVERYAPI_API_KEY`, `QUICKHACK_DELIVERYAPI_SECRET_KEY`를 사용합니다. Cafe24는 `QUICKHACK_CAFE24_MALL_ID`, `QUICKHACK_CAFE24_ACCESS_TOKEN`을 사용합니다. OAuth 인가·토큰 갱신 도우미와 DeliveryAPI 구독·웹훅 검증 도우미는 코드에 있지만 이 프로브는 읽기 요청만 실행합니다.

## 검증 경계

`tests/integration/postgresql/test-mobile-packing-integrity.mjs`는 임시 PostgreSQL 스키마에서 실제 포장 서비스의 재고 전이·원장·감사를 검증합니다. 모의 서버는 HTTP 실행기와 독립 오라클의 동작을 검증합니다. Android 실기기 지연, 외부 제공사 응답, 전체 업무 경로의 네트워크 장애 수용성은 각각 별도 실행 증거가 필요합니다.
