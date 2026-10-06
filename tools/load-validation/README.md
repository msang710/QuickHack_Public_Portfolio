# QuickHack 부하 검증 v1

이 도구는 전용 PostgreSQL DB 세 개(QuickHack 서버, Coupang Mock, Logen Mock)에만 시험 데이터를 적재한다. DB 이름 또는 스키마는 `qh_load_*`여야 한다. 시험 환경의 `qh_test_*` 스키마도 허용한다. 기존 운영 DB에서 실행할 수 없다. 서버와 Mock은 **서로 다른** DB 또는 스키마를 사용한다.

기본 프로필은 SKU 20,000개, 30일 × 일 10,000건의 이력 주문, 포장 대기 주문 20,000건, 작업자 10명이다. `profile` 명령은 생성 시각을 이력 종료 시각으로 고정한 JSON을 출력하고 SHA-256을 stderr에 출력한다. seed/run/verify에 항상 같은 프로필 파일을 쓴다.

## 준비와 데이터 적재

1. 서버용 전용 DB에 현 소스의 Prisma migration을 적용하고 서버 보안 상태(`server_instance_state`)를 초기화한다. Mock용 전용 DB 두 개는 각 Mock의 `--init-db`로 스키마와 기준 자료를 초기화한다.
2. DB 연결 URL을 아래 환경 변수에 넣는다. 비밀번호가 포함된 URL은 셸 기록, 로그, 결과물에 넣지 않는다. 스키마 방식이면 PostgreSQL `search_path`를 해당 `qh_load_*` 스키마로 설정한다.
3. Mock과 서버를 **중지한 상태**에서 다음 순서로 실행한다. 실패한 적재는 새 전용 DB로 다시 시작한다. 적재기는 기존 데이터를 덮어쓰지 않는다.

```bash
export QUICKHACK_LOAD_SERVER_DATABASE_URL='postgresql://.../qh_load_server'
export QUICKHACK_LOAD_COUPANG_DATABASE_URL='postgresql://.../qh_load_coupang'
export QUICKHACK_LOAD_LOGEN_DATABASE_URL='postgresql://.../qh_load_logen'
node tools/load-validation/cli.mjs profile > /tmp/quickhack-load-profile.json
node tools/load-validation/cli.mjs seed-server --profile /tmp/quickhack-load-profile.json
node tools/load-validation/cli.mjs seed-coupang --profile /tmp/quickhack-load-profile.json
node tools/load-validation/cli.mjs seed-logen --profile /tmp/quickhack-load-profile.json
node tools/load-validation/cli.mjs accounts --profile /tmp/quickhack-load-profile.json --secrets /tmp/quickhack-load-secrets.json
node tools/load-validation/cli.mjs verify --profile /tmp/quickhack-load-profile.json
```

`accounts`는 전용 DB에 STAFF 세션 10개와 모바일 등록 기기 10개를 직접 만든다. 실제 계정/기기 등록 절차의 검증 근거가 아니다. 비밀 파일은 `0600`으로 생성하고 보관·전송에 주의한다. 서버 시작 직전에 생성해서 12시간 세션 만료 전에 모든 단계를 마친다.

Coupang Mock은 적재 후 `QUICKHACK_LOAD_TEST_MODE=1`, `COUPANG_MOCK_FAILURE_ENABLED=0`, `--order-interval-ms 0 --return-exchange-interval-ms 0`으로 실행한다. 이 모드에서 주문 목록 API는 요청한 KST 날짜 구간으로 제한한다. 초기 포장 대기 주문은 시험 시작 2~3일 전의 대기 재고로 배치하고 새 주문만 현재 날짜 구간에 유입한다. Logen Mock은 `LOGEN_MOCK_FAILURE_ENABLED=0`, `LOGEN_MOCK_TRACKING_INTERVAL_MS=0`, `LOGEN_MOCK_RETURN_INTERVAL_MS=0`으로 실행한다. Coupang `/admin/reset`은 기본 카탈로그로 되돌리므로 시험 중 사용하지 않는다. QuickHack 서버는 이 전용 서버 DB와 두 Mock으로 연결해야 한다.

서버 시작 전 시험용 Coupang Mock에서 발급한 자격증명으로 **시험 전용** QHKEY를 만들고, 서버 프로세스가 읽는 QHKEY master key activation credential을 준비한다. Linux 소스 실행에서는 `XDG_DATA_HOME` 아래 `quickhack/qhkey/quickhack-keys/coupang.qhkey`와 `CREDENTIALS_DIRECTORY/quickhack.qhkey-master-key`를 사용한다. 두 환경 변수는 기존 설치 경로와 다른 임시 디렉터리를 가리켜야 한다. Mock 주문 유입은 `ACCEPT` 상태와 실제 유입 시각으로 기록된다. 서버의 Worker Manager가 작업을 등록한 후 전용 서버 DB에서 `coupang-accept-order-sync`의 일정을 활성화하고 오류 상태가 없는지 확인한다. `run`은 이 작업이 비활성화되거나 실패·재시도 상태이면 시작 전에 거절한다.

## 단계별 실행

부하 발생기와 Mock은 대상 서버의 4 vCPU / 8 GiB 예산 밖에서 실행한다. `run`은 요청과 Mock 주문 유입을 동시에 실행하고 원본 JSONL, 매니페스트, 요약 JSON을 새 출력 디렉터리에 만든다. 기존 이름과 충돌하면 실패한다. 각 단계는 명시적으로 한 번씩 실행한다.

```bash
node tools/load-validation/cli.mjs run --profile /tmp/quickhack-load-profile.json --phase peak --target https://SERVER:PORT --secrets /tmp/quickhack-load-secrets.json --out /tmp/quickhack-load-results
node tools/load-validation/cli.mjs run --profile /tmp/quickhack-load-profile.json --phase stress --target https://SERVER:PORT --secrets /tmp/quickhack-load-secrets.json --out /tmp/quickhack-load-results
node tools/load-validation/cli.mjs run --profile /tmp/quickhack-load-profile.json --phase soak-2h --target https://SERVER:PORT --secrets /tmp/quickhack-load-secrets.json --out /tmp/quickhack-load-results
node tools/load-validation/cli.mjs run --profile /tmp/quickhack-load-profile.json --phase soak-8h --target https://SERVER:PORT --secrets /tmp/quickhack-load-secrets.json --out /tmp/quickhack-load-results
```

`--server-pid`를 지정하면 같은 호스트의 서버 프로세스 CPU tick과 RSS도 1초마다 기록한다. 지정하지 않아도 DB 연결 수와 트랜잭션, 읽기 블록, 임시 바이트, 교착 수는 기록된다. 실제 서버의 CPU/메모리 제한은 배포 환경에서 별도로 적용·확인한다. 매니페스트의 예산 숫자 자체는 제한 적용의 증거가 아니다.

작업자는 5초 생각 시간으로 읽기 80%, 포장 쓰기 20%를 수행한다. 100번째 포장마다 같은 요청을 다시 보내 중복 전이를 검사한다. Mock 주문은 평균 약 21건/분, peak 약 104건/분, stress 약 208건/분으로 입력한다. 30분 peak와 2시간/8시간 soak를 채점한다. stress는 탐색용이다.

요약 보고서의 PASS는 해당 단계의 p95, 실패·추적 누락·중복·DB 원장 대사와 Mock 주문 유입량을 모두 만족해야 한다. Mock 주문이 서버에 아직 반영되지 않았으면 최대 5분 기다린 뒤에도 `INCONCLUSIVE`로 남긴다. HTTP 원본 기록에는 쿠키와 기기 토큰을 남기지 않는다. `verify`는 DB 대사만 다시 수행한다.

PostgreSQL 통합 검증과 짧은 HTTP smoke는 목표 시간·자원 제한 시험과 별도 결과다. 테스트 결과를 기록할 때 소스 revision, DB 분리, Mock 장애 정책, 서버 자원 제한의 실제 증거를 함께 보관한다.
