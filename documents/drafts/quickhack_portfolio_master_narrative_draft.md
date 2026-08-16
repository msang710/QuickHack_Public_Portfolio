---
title: "QuickHack 포트폴리오 통합 서사 초안"
subtitle: "현장 물류 문제를 상태·원장·실패 경계·작업 그래프로 구조화한 AI 협업 프로젝트"
document_type: "portfolio article and presentation source draft"
language: "ko-KR"
status: "draft"
updated_at: "2026-08-03"
audience:
  - "ERP·WMS·물류 시스템 설계 역량을 평가하는 면접관"
  - "AI 코딩 에이전트 활용과 실행력을 중요하게 보는 채용 담당자"
  - "제품 판단과 구현 책임을 함께 맡을 수 있는 인재를 찾는 조직"
---

# QuickHack 포트폴리오 통합 서사 초안

## 제목 후보

### 1안 — 가장 직접적인 제목

> **AI에게 “해줘”라고 말해 만든 ERP가 아니라, AI가 안전하게 만들 수 있는 지도를 설계한 프로젝트**

### 2안 — 시스템 설계 역량 중심

> **현장의 물류 문제를 상태, 원장, 실패 경계로 다시 설계하다**

### 3안 — AI 협업 역량 중심

> **코드 생성보다 어려웠던 일: 여러 AI 작업을 하나의 제품 판단으로 통합하기**

## 한 줄 소개

QuickHack은 중고 기기 한 대의 입고 예정부터 검수, 매입, 재고, 판매 채널 주문 매칭, 송장, 배송, 반품까지를 PG·IMEI 단위로 연결하고, 실물 상태·수량 원장·외부 채널 상태가 서로 어긋나지 않도록 설계한 사내용 ERP/WMS 프로젝트입니다.

이 프로젝트에서 제가 증명하려는 것은 단순한 AI 사용 경험이 아닙니다.

> **모호한 실무 문제를 구현 가능한 데이터·상태·책임 구조로 바꾸고, AI가 빠르게 움직여도 제품의 판단과 정합성이 흔들리지 않도록 작업을 설계하고 검증하는 능력입니다.**

---

# 목차

1. 이 프로젝트를 시작한 계기와 실무에서의 문제
2. 주요 설계 요구사항과 실무와의 연결점
3. 주요 비즈니스 로직과 실제 코드 흐름
4. AI와의 바이브 코딩에서 고려해야 했던 것들
5. AI가 제안한 설계를 제가 수정한 직접적인 증거
6. 작업 분해와 병렬 처리로 구현 속도를 높인 방식
7. 구현한 것만큼 중요했던, 만들지 않기로 한 것
8. 결과물과 검증 증거
9. 배운 점과 면접에서 전달할 메시지
10. PPT 전환 목차와 이미지 배치안

---

# 1. 이 프로젝트를 시작한 계기와 실무에서의 문제

## 1.1 시작점은 “ERP를 만들어 보고 싶다”가 아니었습니다

QuickHack은 기술 스택을 연습하기 위해 시작한 프로젝트가 아닙니다. 기존 구글 시트 중심의 물류 업무에서 데이터가 사라지거나, 없어야 할 값이 나타나고, 주문과 재고가 잘못 연결되는 문제를 직접 경험한 것이 출발점이었습니다.

중고 기기 물류에서는 하나의 실물을 여러 팀과 시스템이 차례로 다룹니다.

- 입고 담당자는 예정 수량과 실제 도착 수량을 확인합니다.
- 검수 담당자는 외관·기능 상태와 판매 가능 여부를 기록합니다.
- 매입 담당자는 가격과 매입 확정 여부를 관리합니다.
- 재고 담당자는 현재 위치와 판매 가능 상태를 확인합니다.
- 주문 담당자는 외부 판매 채널의 상품 옵션을 내부 재고와 연결합니다.
- 출고 담당자는 주문, 실물 기기, 송장, 포장 결과가 일치하는지 확인합니다.
- 반품 담당자는 회수된 실물과 기존 판매·배송 이력을 다시 연결합니다.

이 단계들이 각각 다른 시트, 수식, 조회 결과와 수동 작업에 의존하면 “지금 화면에 보이는 값”은 있어도 그 값이 어떤 사실에서 만들어졌는지 설명하기 어렵습니다.

## 1.2 실제로 발생한 문제

기존 운영 기록에는 13건의 장애와 혼선이 남아 있습니다. 확인된 업무 지연만 최소 55분이며, 원인이 확인되지 않았거나 별도 재고조사와 대조가 필요했던 사건의 시간은 포함하지 않았습니다.

대표 사례는 다음과 같습니다.

| 실제 사건 | 현장에서 나타난 문제 | 시스템 설계로 바꾼 요구사항 |
| --- | --- | --- |
| 주문 매칭 데이터 삭제·동기화 누락 | 처리된 주문이 화면에서 사라지거나 출고 대상에서 빠질 위험 | 원본 보존, 현재 상태와 이력 분리, 동기화 결과 기록 |
| 검수·매입 완료 기기의 재고 등록 누락 | 실물은 존재하지만 시스템 재고에는 없음 | 실물 상태와 수량 원장을 한 transaction에서 함께 갱신 |
| 원본에 없는 재고가 QUERY 결과에 표시 | 존재하지 않는 재고를 정상값처럼 판단 | 정본과 조회 결과의 교차 검증, 근거 부족 상태 분리 |
| 주문 없이 재고 상태가 주문 확인으로 변경 | 주문 사실과 재고 상태가 모순 | 허용된 상태 전이와 변경 근거 강제 |
| 외부 상품 옵션 혼선으로 실제 오출고 | 외부 문자열과 내부 재고 기준이 잘못 연결 | 내부 SKU 정규화, 채널 옵션 mapping, 출고 전 재검증 |
| 전체 시트 작동 정지 | 핵심 업무가 하나의 공유 도구에 묶임 | 중앙 서버, worker 상태, backup·복구 가시성 |
| 작업자의 필터가 다른 작업자에게 영향 | 개인 화면 조작이 공동 업무 판단을 변경 | 사용자별 화면 상태와 서버 기준 조회 분리 |

여러 문제는 시스템 자체가 알려 준 것이 아니라 우연히 남아 있던 프린트 기록, 별도 재고조사, 출고 직전 수동 검수로 발견됐습니다. 특히 외부 상품 옵션 혼선은 실제 오출고로 이어졌고, 다음 날 같은 위험이 다시 발생했습니다.

여기서 문제를 다음과 같이 다시 정의했습니다.

> **필요한 것은 화면을 더 만드는 것이 아니라, 실물·수량·주문·외부 상태가 바뀔 때마다 무엇을 정본으로 삼고 어떤 근거를 남길 것인지 결정하는 시스템이다.**

## 1.3 프로젝트의 목표

QuickHack의 목표는 다음 다섯 문장으로 정리할 수 있습니다.

1. 기기 한 대의 전체 생명주기를 PG·IMEI로 추적한다.
2. 현재 재고 상태와 수량의 변경 원장을 분리하되 함께 갱신한다.
3. 외부 판매 채널의 문자열을 내부 재고 기준과 직접 섞지 않는다.
4. 실패를 단순 성공·실패가 아니라 결과 불명과 수동 확인까지 포함한 상태로 다룬다.
5. 자동화가 안전한 범위와 사람이 판단해야 할 경계를 코드와 운영 흐름에 남긴다.

---

# 2. 주요 설계 요구사항과 실무와의 연결점

## 2.1 실물 한 대를 끝까지 연결하는 기준 — PG·IMEI

실무에서 가장 먼저 필요한 것은 “이 주문에 어떤 모델이 연결됐는가”보다 “실제로 어느 기기가 움직였는가”를 추적하는 것입니다.

QuickHack은 `devices`의 PG를 중심으로 다음 이력을 연결합니다.

```text
입고 예정
→ 외관·기능 검수
→ 매입 확정
→ 판매 가능 재고
→ 주문 배정
→ 포장 검증
→ 송장·배송
→ 판매 확정
→ 반품 회수·재검수
```

PG는 내부 실물 식별자이고 IMEI는 보조 식별 및 대조 근거입니다. 외부 주문번호나 판매 채널 상품 ID는 이 실물 식별자를 대체하지 않습니다.

실무 연결점은 분명합니다.

- 같은 기기가 두 주문에 동시에 배정되는 것을 막을 수 있습니다.
- 출고 후 반품된 기기를 기존 판매·검수 이력과 다시 연결할 수 있습니다.
- 화면에 표시된 수량과 실제 어떤 기기들이 그 수량을 구성하는지 대조할 수 있습니다.

## 2.2 현재 상태와 변경 이력을 분리한다

현재 상태만 저장하면 빠르게 조회할 수 있지만, 왜 값이 바뀌었는지 알 수 없습니다. 반대로 모든 이력만 읽어 매번 현재값을 계산하면 운영 조회가 무거워지고 오류 경계가 넓어집니다.

그래서 역할을 나눴습니다.

| 데이터 | 답하는 질문 |
| --- | --- |
| `inventory` | 특정 PG의 실물이 현재 어떤 상태인가 |
| `inventory_quantity_balances` | 같은 SKU·상태의 현재 수량이 몇 대인가 |
| `inventory_quantity_movements` | 어떤 업무 때문에 수량이 얼마나 변했는가 |

수량 변경은 다음 불변식을 따릅니다.

```text
새 잔액 = 이전 잔액 + quantity_delta
```

각 movement에는 변경 전·후 수량, 원인 업무, 작업자 또는 worker, 발생 시각과 idempotency key가 남습니다. 현재값은 빠른 운영을 위해 사용하고, append-only movement는 대조와 감사의 근거가 됩니다.

## 2.3 정상적인 0과 근거가 없는 0을 구분한다

재고 화면에서 `0`은 두 가지 의미가 될 수 있습니다.

- 실제로 재고가 없는 정상적인 0
- 원장이 생성되지 않았거나 일부 데이터가 빠져 계산할 수 없는 상태

둘을 같은 숫자로 보여 주면 사용자는 누락을 정상으로 오해할 수 있습니다. 따라서 원장 가용성을 상태로 분리했습니다.

- `READY`: 잔액과 movement 근거가 정상
- `EMPTY`: 정상적인 재고 0
- `INITIALIZATION_PENDING`: 실물 재고는 있지만 원장 초기화가 끝나지 않음
- `PARTIAL`: balance, movement 또는 SKU 근거가 일부 불완전함

이 판단은 단순한 UI 메시지가 아니라 조회·통계·운영 판단이 같은 신뢰 범위를 사용하게 만드는 데이터 계약입니다.

## 2.4 외부 채널의 상품 기준과 내부 재고 기준을 분리한다

외부 판매 채널의 `vendorItemId`, 상품명, 옵션 문자열은 운영 중 변경되거나 다른 상품과 경쟁 상태가 될 수 있습니다. 이를 내부 재고의 정본으로 사용하면 외부 변화가 내부 실물 판단까지 흔듭니다.

그래서 다음을 분리했습니다.

```text
외부 채널 상품·옵션
→ channel product mapping
→ QuickHack 내부 판매상품 조합
→ model + storage + color + warranty/sale grade
→ 판매 가능한 PG 후보
```

실제 재고 선택은 외부 문자열이 아니라 QuickHack의 내부 기준값과 주문 매칭 정책을 사용합니다. 출고 직전에는 외부 주문의 취소·변경·출고중지 상태를 다시 확인해 내부 배정이 여전히 유효한지 검증합니다.

## 2.5 외부 쓰기는 DB transaction처럼 취급하지 않는다

택배사나 판매 채널에 쓰기 요청을 보낸 뒤 응답이 끊기면, 요청이 실패한 것인지 외부에는 반영됐지만 응답만 유실된 것인지 알 수 없습니다.

단순 재시도는 다음 문제를 만들 수 있습니다.

- 같은 송장이나 상태 변경을 중복 등록
- 외부에는 반영됐지만 로컬 상태는 실패로 남음
- 운영자가 여러 번 눌러 상태를 더 복잡하게 만듦

QuickHack은 외부 쓰기를 다음 상태로 나눕니다.

```text
PENDING
→ SENDING
→ VERIFYING
→ LOCAL_PENDING
→ COMPLETED

명확한 미반영 → NOT_APPLIED
끝까지 확인 불가 → REVIEW_REQUIRED
정책 차단 → REJECTED
```

timeout이나 연결 종료가 발생하면 같은 쓰기를 즉시 반복하지 않습니다. 먼저 GET 조회로 외부 상태를 검증하고, 그래도 결론을 낼 수 없을 때는 `REVIEW_REQUIRED`로 자동화를 멈춰 사람에게 판단을 넘깁니다.

## 2.6 개인정보는 날짜가 아니라 업무 종결 상태로 관리한다

기존 접근은 주문 row의 마지막 동기화 시각인 `updated_at`을 기준으로 개인정보 90일을 계산했습니다. 하지만 동기화 시각은 업무가 끝난 시각이 아닙니다.

- 미완료 주문이 오래 갱신되지 않으면 너무 일찍 삭제될 수 있습니다.
- 완료 주문이 반복 동기화되면 보존기간이 계속 미뤄질 수 있습니다.
- 주문 원문을 지워도 배송지 변경, 합포장, 송장 재발급 snapshot에 원문이 남을 수 있습니다.

그래서 개인정보 수명주기를 배송·반품·교환의 실제 종결 사실에 연결했습니다.

- 배송 완료 시 보존 시계 시작
- 진행 중 claim이 있으면 시계 중지
- 모든 claim 종결 후 가장 늦은 종결 시각부터 다시 계산
- 상태가 불명확하면 삭제하지 않음
- 주문 원문과 파생 snapshot을 subject 단위 transaction으로 함께 정리
- 공유 package나 진행 중 작업이 있으면 deferred 사유를 남기고 보류

또한 2년 보증과 배송 개인정보를 같은 보존기간으로 묶지 않았습니다. QuickHack에는 영구 고객 전화번호가 아니라 쿠팡 안심번호만 저장되므로, 보증은 주문번호를 우선하고 PG·IMEI를 보조 식별자로 사용합니다. 연락처와 회수주소는 보증 접수 시 새로 받습니다.

## 2.7 복구는 기능이 아니라 권한·프로세스 경계의 문제다

실행 중인 SQLite를 일반 클라이언트가 교체하는 온라인 복구 기능은 인증 버튼을 하나 더 붙이는 것으로 안전해지지 않습니다.

그래서 복구 경계를 축소했습니다.

- 일반 업무 UI와 공개 API에서 DB 복구 제거
- 서버와 worker가 완전히 정지한 오프라인 상태에서만 파일 교체
- 대상 backup 무결성 검사
- 현재 DB의 safety backup 생성
- 원자 교체와 rollback
- 중단 상태를 자동 추정하지 않고 운영자가 resume 또는 rollback 선택
- DB 자체가 교체돼도 남아야 하는 복구 영수증만 DB 밖 JSONL에 append

반면 일반 backup은 기존 worker와 DB 실행 이력을 그대로 사용합니다. backup과 restore는 비슷해 보이지만 생명주기와 source of truth가 다릅니다.

---

# 3. 주요 비즈니스 로직과 실제 코드 흐름

## 3.1 전체 호출 구조

QuickHack의 코드 흐름은 다음 책임 경계를 따릅니다.

```text
작업자 UI
→ app/api route wrapper
→ quickhack_server domain service
→ 권한·정책·상태 전이 검증
→ Prisma transaction
→ 현재 상태 + 원장 + 감사 이력
→ worker 또는 외부 adapter
→ 검증 결과와 운영 상태 표시
```

| 코드 영역 | 책임 |
| --- | --- |
| `quickhack_client/` | 화면, 폼 상태, 로컬 ADB·출력 |
| `app/api/` | Next.js route와 서버 호출 경계 |
| `quickhack_server/` | 권한, transaction, 도메인 서비스, worker, 외부 연동 |
| `quickhack_shared/` | 상태 코드, 전이 정책, DTO와 공통 계약 |
| `prisma/` | DB schema와 migration의 단일 기준 |
| `tools/test-*.mjs` | 실제 실패 경로와 회귀 계약 |

## 3.2 입고부터 판매 가능 재고까지

```text
입고 예정 등록
→ inbound batch와 PG 연결
→ 외관·기능 검수 이력 기록
→ 매입 확정
→ inventory 생성 또는 상태 전환
→ inventory_quantity_balance 갱신
→ inventory_quantity_movement append
```

핵심은 `inventory`만 바꾸거나 수량만 더하지 않는 것입니다. 실물 PG 상태와 SKU별 수량 원장을 같은 업무 transaction에서 함께 반영합니다.

관련 근거:

- `quickhack_server/inbound/purchase-confirm-service.ts`
- `quickhack_server/inventory/inventory-quantity-ledger-service.ts`
- `quickhack_server/inventory/inventory-quantity-ledger-audit-service.ts`
- `quickhack_shared/inventory/inventory-write-rules.ts`

## 3.3 주문 수집과 실물 재고 매칭

```text
Coupang 주문 GET 동기화
→ coupang_order_raw 원본 보존
→ order_items 정규화
→ vendorItemId를 내부 판매상품 조합에 mapping
→ order matching worker가 판매 가능 PG 후보 조회
→ 정책·우선순위에 따라 PG allocation
→ inventory SELLABLE → RESERVED
→ 수량 movement 기록
```

이 흐름에서 원본 주문, 정규화된 주문 품목, worker 작업지시, 최종 PG allocation은 서로 다른 책임을 가집니다. 한 row에 합치지 않음으로써 외부 원본, 내부 판단, 처리 결과를 각각 추적할 수 있습니다.

관련 근거:

- `quickhack_server/sales-channel/coupang/sync-service.ts`
- `quickhack_server/sales-channel/coupang/order-matching-service.ts`
- `quickhack_server/sales-channel/coupang/product-mapping-service.ts`
- `quickhack_server/sales-channel/inventory-quantity-projection-service.ts`

## 3.4 포장·송장·배송

```text
주문 배정 완료
→ 출고 목록·package group 확정
→ inventory RESERVED → PACKING
→ 포장 검증 성공
→ inventory PACKING → PACKED
→ 택배 송장 등록·출력
→ inventory PACKED → DEPARTURE
→ 배송 추적
→ FINAL_DELIVERY
→ sales_records 판매 원장 반영
```

포장 검증은 단순 확인 버튼이 아니라 실물 상태 전이의 gate입니다. 현재 상태가 `PACKING`이 아니면 성공할 수 없고, 정상 흐름에서는 한 번만 `PACKED`로 전환됩니다.

송장 출력과 운송사 송장 등록도 분리했습니다. 출력은 이미 등록된 데이터를 로컬 프린터로 보내는 물리 작업이며, 출력 확인이 운송사 등록 API를 다시 호출하지 않습니다.

관련 근거:

- `quickhack_server/shipment/shipment-package-group-service.ts`
- `quickhack_server/mobile/packing-check-service.ts`
- `quickhack_server/shipment/carrier-integration/logen/shipment-registration-service.ts`
- `quickhack_server/shipment/carrier-integration/logen/label-print-service.ts`
- `quickhack_client/printing/printer-service.ts`
- `quickhack_server/sales/sales-record-service.ts`

## 3.5 반품과 재판매 판단

반품은 원래 판매 흐름을 취소하는 단순 역방향이 아닙니다.

```text
외부 반품·교환 상태 수집
→ 기존 주문·배송·PG allocation 연결
→ 회수 상태 추적
→ 반품 검수
→ 재판매 가능 / 보류 / 불량 판정
→ inventory와 수량 원장 재반영
→ 판매·claim 이력 보존
```

진행 중 반품이나 교환이 있으면 개인정보 수명주기도 함께 보류됩니다. 즉 반품 기능은 화면 하나가 아니라 재고, 판매 원장, 개인정보 보존, 통계의 공통 업무 사실입니다.

## 3.6 Worker의 실행과 복구

주문 수집, 매칭, 배송 추적, backup, 개인정보 정리와 통계 snapshot은 worker가 수행합니다.

worker는 단순 cron 함수가 아니라 다음 상태를 가집니다.

- lease owner와 만료 시각
- heartbeat
- 현재 상태와 다음 실행 시각
- attempt count
- retry waiting
- terminal result
- 실행별 `server_job_logs`

중단된 작업은 무조건 처음부터 재실행하지 않습니다. 멱등성과 복구 가능성을 확인하고, 결과 불명 외부 쓰기나 물리 출력은 사람의 검토 대상으로 남깁니다.

---

# 4. AI와의 바이브 코딩에서 고려해야 했던 것들

## 4.1 초기 바이브 코딩 방식의 장점과 한계

처음에는 실무에서 필요한 기능을 발견할 때마다 AI에게 바로 구현을 요청했습니다.

```text
기능 필요 발견
→ AI에게 구현 요청
→ 코드 생성
→ 화면에서 동작 확인
```

이 방식은 빠릅니다. 그러나 프로젝트가 커지면서 빠른 코드 생성보다 요구사항 사이의 모순이 더 큰 비용이 됐습니다.

- 같은 업무 용어가 화면마다 다른 계산을 사용했습니다.
- AI가 명시되지 않은 예외를 임의의 정상 흐름으로 채웠습니다.
- 실패를 만나면 습관적으로 retry를 추가하려 했습니다.
- 기존에 있는 원장과 이력을 모르고 새 테이블이나 worker를 제안했습니다.
- 한 기능을 고친 결과가 통계, 개인정보, worker와 충돌했습니다.
- 여러 작업이 같은 schema와 공통 계약을 동시에 수정할 위험이 생겼습니다.

여기서 배운 것은 “프롬프트를 더 길게 쓰자”가 아니었습니다.

> **AI가 코드를 만들기 전에 AI가 따라갈 판단 지도와 작업 지도를 먼저 만들어야 한다.**

## 4.2 FACT, PRODUCT, DESIGN을 분리한 SDD

AI와의 대화에서 가장 중요한 통제 방식은 사실, 제품 판단, 구현 설계를 섞지 않는 것이었습니다.

### FACT — 코드에서 확인할 것

- 현재 어떤 테이블과 서비스가 source of truth인가
- 어떤 상태 전이와 retry가 이미 존재하는가
- 어떤 API가 외부 쓰기를 실제로 수행하는가
- 어떤 test가 현재 동작을 보장하는가

### PRODUCT — 제가 결정할 것

- 결과 불명 상태를 자동 재시도할 것인가
- 개인정보를 어느 업무 상태에서 삭제할 것인가
- 강제 종료 후 자동 재시작을 허용할 것인가
- 어떤 위험은 수용하고 어떤 기능은 제거할 것인가

### DESIGN — 승인된 판단을 구현하는 방법

- table, API, service, worker 경계
- 상태 코드와 오류 계약
- migration과 하위 호환성
- test fixture와 rollout 순서

이 구분을 통해 AI가 코드로 확인할 수 있는 사실을 사용자에게 되묻거나, 제품 판단을 기술 설계처럼 임의로 확정하지 못하게 했습니다.

## 4.3 정상 흐름보다 실패 경계를 먼저 정의한다

AI는 happy path 구현에는 강하지만, 다음 상태를 명시하지 않으면 위험한 가정을 채울 수 있습니다.

- 외부에는 반영됐지만 응답만 유실
- worker가 transaction 중간에 종료
- 원장 일부만 존재
- 복구 중 DB 파일이 교체됐지만 서버가 뜨지 않음
- 개인정보 subject 일부가 공유 snapshot에 남음
- 출력 프로세스는 끝났지만 결과 기록이 유실

따라서 각 작업에 다음을 먼저 적었습니다.

```text
정상 완료 기준
명확한 실패
결과 불명
자동 재시도 가능 조건
자동화 중단 조건
수동 검토가 필요한 증거
rollback 또는 재개 방법
```

## 4.4 생성된 코드를 결과가 아니라 가설로 취급한다

AI가 만든 코드는 다음 네 증거와 대조했습니다.

1. 실제 실무 흐름
2. DB schema와 현재 source of truth
3. route → service → transaction → adapter 호출 경로
4. 실패 fixture와 회귀 test

코드가 컴파일된다는 사실은 설계가 맞다는 증거가 아닙니다. 반대로 처음 제안된 설계가 틀렸다는 것을 발견하면 이미 작성된 SDD의 `READY` 판정도 다시 `NEEDS_WORK`로 되돌렸습니다.

## 4.5 AI의 기여와 사람의 책임을 정직하게 구분한다

AI의 기여는 분명합니다.

- 코드 생성과 반복 구현
- 리팩터링 대안 탐색
- test 초안과 fixture 확장
- 코드베이스 검색과 영향 분석
- 문서와 다이어그램 생성
- 병렬 작업의 실행

제가 책임진 영역은 다릅니다.

- 해결할 실무 문제와 우선순위
- 데이터의 의미와 정본
- 실패 허용 범위
- 자동화가 멈추는 조건
- 제품과 보안의 경계
- 과설계를 피하기 위한 비범위
- 작업 의존성과 병합 순서
- 최종 검증과 결과 설명

---

# 5. AI가 제안한 설계를 제가 수정한 직접적인 증거

## 5.1 가장 강한 사례 — 180초 자동 강제 종료를 철회하다

서버 종료 조율을 설계할 때 AI는 다음 흐름을 제안했습니다.

> `180초를 넘긴 경우에만 taskkill /F /T`

당시 AI의 자체 판정은 `Review verdict: READY`였습니다.

제가 지적한 원문은 다음과 같습니다.

> **“180초 유예 정도면 충분할까? 이걸 하는 이유는 가능하면 worker가 강제 종료되는 지점을 줄여서 혹시 모를 데이터 불일치나 누락, 동기화 반영 사고를 줄이는 거잖아”**

이 지적의 핵심은 단순히 시간을 늘리자는 것이 아니었습니다.

> 데이터 불일치를 막기 위해 만든 안전 종료가, 고정 시간만으로 worker를 강제 종료하면 오히려 데이터 불일치를 만들 수 있다.

코드를 다시 조사한 결과 AI의 초기 계산이 실제 retry 구조를 충분히 반영하지 못한 것이 확인됐습니다.

- Coupang read: `90초 × 6회 + backoff ≈ 543초`
- Logen read: `30초 × 3회 + backoff ≈ 91초`
- 이미 전송된 write는 외부 반영 후 로컬 기록 전 결과 불명 구간 존재
- `VACUUM INTO`, transaction, snapshot 계산에는 즉시 중단하기 어려운 임계 구간 존재

AI도 다음과 같이 정정했습니다.

> **“앞서 단일 쿠팡 호출 90초의 2배만 기준으로 잡은 건 실제 재시도 구조를 충분히 반영하지 못했습니다.”**

그 결과 판정과 구현이 모두 바뀌었습니다.

| 변경 전 | 변경 후 |
| --- | --- |
| 180초 후 자동 process tree kill | 180초는 지연 경고와 force 버튼 활성화 기준 |
| 시간 초과가 강제 종료 조건 | 기본은 안전 종료 계속 대기 |
| 강제 종료 후 설정 전환 중심 | 사용자 명시 조작 또는 두 번째 signal에서만 force |
| `Review verdict: READY` | `Review verdict: NEEDS_WORK` 후 재설계 |
| 강제 종료 후 자동 재시작 가능성 | process·port·SQLite/WAL 확인 후 수동 시작 |

현재 test는 경고 threshold가 지나도 `force`가 자동 호출되지 않는 것을 명시적으로 검증합니다. 이 설계는 PR #85, commit `33a3d58f`로 구현됐습니다.

### 이 사례가 증명하는 것

> **저는 AI가 만든 구현안을 승인만 한 것이 아니라, 설계 목적과 충돌하는 실패 조건을 발견해 구현 gate를 되돌리고 코드·test·운영 흐름까지 수정했습니다.**

## 5.2 중복 백업 원장을 만들 필요가 없다고 지적하다

AI가 backup 실행 기록을 어디에 남길지 새로운 결정처럼 다루자 제가 다음과 같이 지적했습니다.

> **“지금 구현하려는 흐름이 서버 콘솔이 본서버에게 백업 요청을 내리면, 서버 worker가 그걸 수행하는 구조 아니야? 백업 기록을 어디에 남길지 정해야 한다는 게 무슨 말이야? 그건 본서버 DB에 이미 있잖아.”**

코드 조사 결과 다음 사실이 확인됐습니다.

- `server_worker_jobs`: worker의 현재 상태, 최근 실행, 다음 실행, 오류와 결과
- `server_job_logs`: 실행별 backup·무결성 검사 이력
- backup directory: 실제 생성 파일 목록

AI는 다음과 같이 정정했습니다.

> **“맞아. 네가 이해한 구조가 정확해.”**

> **“내가 그 부분을 백업까지 포함하는 것처럼 표현한 게 잘못이었어.”**

최종 구조는 다음과 같습니다.

- 즉시·자동 backup: 기존 server worker 수행
- 상태와 이력: 기존 DB를 source of truth로 사용
- 신규 backup history table: 만들지 않음
- 관련 migration: 만들지 않음
- offline restore: DB 자체가 교체되므로 DB 밖 `restore-receipts.jsonl`만 사용

PR #86은 기존 worker와 기존 DB 이력을 서버 콘솔에 연결했고, PR #87은 offline restore 영수증만 별도 JSONL로 구현했습니다.

### 이 사례가 증명하는 것

> **시스템의 기존 source of truth와 프로세스 책임을 이해했기 때문에 AI가 만들 수 있었던 중복 테이블과 중복 상태를 구현 전에 제거했습니다.**

## 5.3 검증되지 않은 프로세스 전제를 코드 기준으로 되돌리다

AI는 자동 backup 실행 주체를 설명하며 “콘솔이 종료돼도 본서버가 남을 수 있다”는 전제를 사용했습니다.

제가 물었습니다.

> **“서버 콘솔 없이도 본서버가 살아 있을 수 있는 흐름인가? 실제 코드 기준으로 확인해봐.”**

실제 제품 실행 흐름을 조사한 결과, 콘솔 웹페이지를 닫는 것과 `server-console.mjs` 프로세스를 종료하는 것은 달랐습니다. 정상 제품 흐름에서 콘솔 프로세스가 종료되면 자식인 본서버와 gateway도 함께 종료됐습니다.

AI는 다음과 같이 정정했습니다.

> **“제가 앞서 ‘콘솔이 종료돼도 본서버가 남을 수 있다’고 말한 것은 너무 단정적이었습니다.”**

자동 backup의 실행 주체를 worker에 유지하는 결론은 lease·retry·이력이라는 다른 근거로 유지됐지만, 잘못된 프로세스 전제는 설계 근거에서 제거됐습니다. 동시에 부모 프로세스 종속 동작에만 기대지 않고 공통 shutdown coordinator로 명시적 종료 흐름을 보강했습니다.

## 5.4 2년 보증과 90일 개인정보를 같은 시계로 묶지 않다

AI가 배송 개인정보 90일 정책을 준비했을 때 제가 물었습니다.

> **“보증기간이 2년인데 90일이 맞나?”**

그리고 QuickHack의 실제 데이터 제약을 추가로 지적했습니다.

> **“퀵핵에 저장되는 전화번호는 안심번호뿐이라서 이름이랑 전화번호로는 충분한 정보가 못돼.”**

그 결과 하나의 보존기간으로 뭉치던 구조를 다음처럼 분리했습니다.

- 보증·거래 증거: 주문번호, PG·IMEI, 판매일, 상품, 가격, 보증그룹
- 배송 개인정보: 이름, 안심번호, 상세주소, 배송메모
- 보증 접수 정보: 접수 시 새로 받은 연락처와 회수주소

보증 접수는 주문번호 우선, PG·IMEI 보조로 확정했고, 2년 보증을 이유로 과거 배송 개인정보 전체를 보존하지 않게 했습니다. 이 수명주기는 PR #89와 #90에서 구현됐습니다.

---

# 6. 작업 분해와 병렬 처리로 구현 속도를 높인 방식

## 6.1 여러 AI를 쓰는 것과 병렬 개발은 다르다

AI agent를 여러 개 실행한다고 자동으로 빨라지지는 않습니다. 같은 schema, shared type, worker registry와 package script를 동시에 수정하면 생성 속도보다 충돌 해결과 재검증 비용이 더 커집니다.

그래서 기능 이름이 아니라 실제 코드 소유권과 데이터 계약을 기준으로 병렬 가능성을 판단했습니다.

## 6.2 병렬화 규칙

- 같은 파일·심볼·DB 상태·오류 계약을 수정하면 한 lane에서 직렬화
- 소유 영역과 test 경계가 분리된 작업만 별도 branch·worktree에서 병렬 실행
- `package.json`, Prisma schema·migration, worker registry·keys, 공통 SDD는 integration owner 단일 소유
- 각 lane은 전용 test를 독립 실행
- 공통 `verify` 연결과 migration 순서 정렬은 통합 단계에서 수행
- 기반 계약 → server 구현 → UI 연결 → legacy 제거 순서로 PR을 분리해 각 단계가 단독 병합 가능하도록 설계

## 6.3 실제 적용 사례

코드 리뷰 후속 작업에서는 남은 P2 15건을 11개 lane과 세 wave로 나눴습니다.

- Wave 1: TOTP, 로그인 timing, 모바일 등록, 민감 action 등 보안 상태 원자성
- Wave 2: Logen 추적, backup 암호화, QHKEY, 로컬 출력 spool 등 운영 안정성
- Wave 3: 사용자 실패 처리, 관리자 감사, observability retention

상위 도메인이 같아도 상태와 소유 서비스가 다르면 병렬화했습니다. 반대로 같은 TOTP 상태나 같은 UI·오류 계약을 수정하는 항목은 같은 lane에서 순차 처리했습니다.

통합 owner는 병렬 결과를 합치면서 다음을 다시 확인했습니다.

- lane 구현 파일이 누락되지 않았는가
- migration 순서가 충돌하지 않는가
- 공통 script와 registry가 중복 수정되지 않았는가
- lane별 test와 TypeScript가 통과하는가
- production build·staging에서 통합 결과가 유지되는가

## 6.4 중요한 구분 — 개발 작업은 병렬화하고 운영 부하는 순차화한다

개발 작업은 독립성이 확보되면 병렬화했지만, 운영 코드의 무거운 통계 snapshot 계산은 SQLite와 Node event loop의 순간 부하를 이유로 순차 실행했습니다.

> **병렬화는 신념이 아니라 총 작업 시간과 충돌 비용, 운영 부하를 함께 줄일 때 선택하는 도구입니다.**

정확한 시간 비교 기록이 없으므로 “N배 빨라졌다”는 수치는 사용하지 않습니다. 대신 다음 사실을 효율성의 증거로 제시합니다.

- 독립 작업의 동시 진행
- 공통 hotspot 충돌 방지
- 단독 병합 가능한 PR 경계
- 통합 owner를 통한 검증 비용 통제
- 실제 wave integration branch와 commit 이력

---

# 7. 구현한 것만큼 중요했던, 만들지 않기로 한 것

## 7.1 정확하지 않은 과거 통계를 만들지 않았다

과거 시점의 외부 상태와 상태 전이 증거가 없는데 현재값을 이용해 synthetic history를 만들면, 숫자는 풍부해 보이지만 사실이 아닙니다.

따라서 신뢰 가능한 이벤트가 기록되기 시작한 이후만 통계 범위로 공개하고, 기존 데이터는 근거가 있을 때만 제한적으로 backfill했습니다.

## 7.2 자동 backfill과 무거운 재계산을 일반화하지 않았다

- 서버 복귀 시 빠진 모든 날짜를 자동 계산하지 않고 최신 cutoff만 보충
- 완료된 snapshot은 예약 실행에서 계산 전에 skip
- 늦게 들어온 사실을 반영할 필요가 있을 때만 권한 있는 사용자가 재계산
- 하나의 daily worker를 위해 범용 schedule schema와 관리 UI를 만들지 않음

## 7.3 제한된 위험에 복잡한 출력 소유권 시스템을 만들지 않았다

중복 송장 출력은 용지 낭비와 작업자 혼선은 만들 수 있지만, 현재 흐름에서는 운송사 등록 API나 운임 청구를 다시 실행하지 않습니다. 포장 검증도 정상적인 두 번째 포장 완료를 막습니다.

따라서 복잡한 다중 PC 출력권 lease와 인계 시스템은 과설계로 판단해 만들지 않았습니다. 대신 결과 불명 출력의 자동 재출력 금지와 개인정보 spool 정리는 유지했습니다.

## 7.4 위험한 온라인 복구를 더 화려하게 포장하지 않았다

일반 사용자 UI에서 실행 중 DB를 교체하는 기능을 더 많은 인증과 확인 창으로 감싸지 않았습니다. 기능 자체를 공개 업무 경계에서 제거하고 offline restore로 축소했습니다.

## 7.5 결과 불명 쓰기를 자동 retry하지 않았다

자동화율을 높이기 위해 retry를 추가하는 대신, 결과 검증과 수동 판단 대기열을 선택했습니다.

> **“자동화할 수 있다”와 “자동화하는 것이 이득이다”는 다른 질문입니다.**

---

# 8. 결과물과 검증 증거

## 8.1 코드와 데이터 모델

주요 증거는 다음과 같습니다.

- PG 중심 실물 마스터와 입고·검수·재고·판매·반품 연결
- `inventory_quantity_balances`와 append-only `inventory_quantity_movements`
- `coupang_order_raw`, `order_items`, `match_worker_allocation`의 책임 분리
- 외부 쓰기 request·target snapshot·attempt 상태 머신
- worker lease·heartbeat·retry·job log
- 개인정보 lifecycle와 파생 snapshot redaction
- offline restore와 append-only JSONL receipt

## 8.2 test와 회귀 검증

QuickHack의 검증은 화면이 열리는지만 확인하지 않습니다.

- 같은 PG가 두 주문에 중복 배정되지 않는가
- 실물 상태와 수량 원장이 함께 이동하는가
- movement idempotency가 중복 증감을 막는가
- 원장 `EMPTY`와 `PARTIAL`을 구분하는가
- 외부 쓰기 timeout 뒤 무조건 재전송하지 않는가
- worker lease 상실과 중단이 복구 가능한 상태로 남는가
- claim 진행 중 개인정보가 삭제되지 않는가
- 공유 snapshot 일부만 정리되는 상태를 막는가
- 180초 warning 뒤 자동 강제 종료되지 않는가
- offline restore 실패 시 safety backup으로 rollback 가능한가

`npm run verify`는 타입 검사, SQLite bootstrap, worker lease, 수량 원장, 외부 쓰기 실패·검증, 주문 매칭, 배송, 반품, 송장과 배포 build를 교차 검증하는 기준으로 사용했습니다.

## 8.3 시각화 자료

이미 작성된 React Flow 청사진 이미지는 본문의 설명을 대체하는 장식이 아니라 코드와 데이터 관계를 빠르게 탐색하기 위한 증거로 사용합니다.

- `quickhack-system-architecture-blueprint-1920x1080.png`
- `quickhack-business-data-flow-blueprint-1920x1080.png`
- `quickhack-core-data-model-blueprint-1920x1080.png`
- `quickhack-code-structure-blueprint-1920x1080.png`
- `quickhack-safe-external-write-blueprint-1920x1080.png`
- `quickhack-worker-recovery-blueprint-1920x1080.png`

각 이미지에는 반드시 다음 설명을 붙입니다.

1. 이 그림이 답하는 실무 질문
2. 개발 중 발견한 위험
3. 제가 내린 설계 판단
4. 관련 코드·table·test
5. 구현 완료인지 설계 단계인지

## 8.4 원문 대화와 결정 기록

“제가 직접 설계했다”는 주장을 자기소개 문장만으로 증명하지 않습니다.

가장 강한 evidence card는 다음 네 칸으로 구성합니다.

```text
AI의 초기 제안
→ 사용자의 문제 지적 원문
→ 코드 재조사로 확인된 사실
→ 변경된 SDD·test·commit
```

추천 evidence card:

1. 180초 자동 강제 종료 철회
2. backup history 중복 설계 제거
3. 서버 콘솔 process 전제 재검증
4. 2년 보증과 배송 개인정보 분리

판매 채널 재고 검증 worker의 새로운 설계 대화는 아직 구현 계획 단계이므로, 구현·test까지 완료되기 전에는 완료 사례로 사용하지 않습니다.

---

# 9. 배운 점과 면접에서 전달할 메시지

## 9.1 프로젝트를 통해 바뀐 개발 방식

처음에는 AI에게 필요한 기능을 빠르게 구현시키는 것이 생산성이라고 생각했습니다. 그러나 프로젝트가 커질수록 병목은 코드 생성 속도가 아니라 판단의 모호함, source of truth의 중복, 실패 경계의 누락과 작업 충돌이었습니다.

이후 개발 순서는 다음처럼 바뀌었습니다.

```text
현장 문제 기록
→ 코드에서 현재 사실 확인
→ 제품 판단과 비범위 결정
→ 상태·데이터·실패 경계 설계
→ PR과 병렬 lane 분해
→ AI 구현·리뷰
→ 코드·test·문서 교차 검증
→ 새 사실 발견 시 SDD 수정
```

AI 구현은 전체 과정 중 한 단계가 됐고, 사람의 역할은 더 명확해졌습니다.

## 9.2 30초 소개

> QuickHack은 구글 시트 기반 물류 업무에서 반복된 데이터 누락, 재고 불일치와 오매칭 문제를 해결하기 위해 만든 ERP/WMS입니다. 처음에는 필요한 기능을 AI에게 바로 구현시키는 방식으로 개발했지만, 프로젝트가 커지면서 코드 생성보다 데이터 정본, 실패 경계와 작업 의존성을 정의하는 일이 더 중요하다는 것을 배웠습니다. 이후 PG 중심 실물 추적, 수량 원장, 외부 쓰기 결과 불명, 개인정보 수명주기와 자동화 중단 조건을 SDD로 먼저 설계했습니다. 독립 작업은 병렬화하고 공유 schema와 계약은 통합 owner가 관리했습니다. 제가 증명하려는 역량은 AI 사용 자체가 아니라, AI가 안전하고 빠르게 구현할 수 있는 시스템과 작업 지도를 만들고 결과를 책임지는 능력입니다.

## 9.3 “결국 AI가 대부분 만든 것 아닌가요?”에 대한 답

> 코드 생성에는 AI의 기여가 큽니다. 그러나 AI는 어느 숫자를 정본으로 삼을지, 외부 쓰기 결과가 불명일 때 재시도해도 되는지, 개인정보를 언제 삭제할 수 있는지, 어느 복구는 사람에게 맡겨야 하는지 스스로 책임질 수 없습니다. 저는 이 판단을 상태와 데이터 계약으로 만들고, AI가 제안한 설계도 실제 코드와 실무 흐름으로 다시 검증했습니다. 180초 자동 강제 종료처럼 AI가 READY로 판단한 설계를 제가 문제 삼아 NEEDS_WORK로 되돌리고 실제 구현과 test까지 바꾼 원문 기록도 남아 있습니다. 제가 맡은 핵심은 타이핑이 아니라 문제 정의, 설계 경계, 작업 오케스트레이션과 최종 검증입니다.

## 9.4 핵심 설득 문장

### 현장 문제

> **화면을 만든 것이 아니라, 실물과 숫자가 어긋나는 이유를 추적할 수 있는 구조를 만들었습니다.**

### 데이터 설계

> **숫자를 보여주는 화면이 아니라, 숫자가 신뢰될 수 있는 정본과 변경 원장을 설계했습니다.**

### 실패 처리

> **재시도 로직뿐 아니라 자동화가 멈추고 사람에게 판단을 넘겨야 하는 조건을 설계했습니다.**

### 개인정보와 보안

> **더 많은 인증 기능을 붙이기 전에 실제 데이터와 프로세스가 안전하게 존재할 수 있는 경계를 먼저 줄였습니다.**

### AI 협업

> **AI가 코드를 만들기 전에, AI가 따라갈 시스템 지도와 작업 지도를 만들었습니다.**

### 병렬 처리

> **기능을 의존성 기반 작업 그래프로 바꾸고, 충돌하지 않는 AI 작업만 병렬화해 구현 속도와 통합 안정성을 함께 관리했습니다.**

## 9.5 마지막 조커 문장

이 문장은 기술적 근거가 아니라 분위기가 충분히 좋아졌을 때만 쓰는 면접용 조커입니다. 객관적 견적처럼 주장하지 않고 AI의 농담 섞인 추정임을 분명히 합니다.

### 직설적인 버전

> “마지막으로 제 Codex가 그러는데요. 이 정도 범위와 품질을 외주로 만들면 아무리 낮게 잡아도 2억, 많으면 4억 정도 들 수 있대요. 그러니까 저를 뽑으시면 돈 아끼시는 겁니다.”

### 조금 더 안전한 버전

> “정확한 견적이라고 주장할 수는 없지만, 제 Codex는 이 정도 범위와 품질을 외주로 다시 만들면 2억에서 4억 수준일 수 있다고 하더라고요. 적어도 저를 채용하시면 견적서보다 먼저 문제의 구조와 만들지 말아야 할 것부터 확인하는 사람은 얻으실 수 있습니다.”

이 문장은 본문이나 첫 면접 답변에 넣지 않습니다. 발표가 끝나고 면접관이 프로젝트의 범위와 AI 활용 방식을 충분히 이해한 뒤, 분위기가 좋을 때만 짧게 사용합니다.

---

# 10. PPT 전환 목차와 이미지 배치안

## 슬라이드 1 — 표지

제목:

> **AI가 코드를 만들기 전에, AI가 따라갈 시스템 지도를 만들었습니다**

부제:

> QuickHack ERP/WMS — 현장 물류 문제를 상태·원장·실패 경계·작업 그래프로 구조화한 기록

## 슬라이드 2 — 왜 시작했는가

- 구글 시트 기반 실제 장애 13건
- 확인된 지연 최소 55분
- 데이터 누락, 없는 값 표시, 상태 불일치, 실제 오출고와 재발

이미지: 장애 이력 timeline 또는 핵심 4개 사건 카드

## 슬라이드 3 — 해결하려는 한 문장

> 실물 기기 상태, 수량 원장, 외부 채널 상태가 업무 단계마다 서로 어긋나지 않게 한다.

이미지: `quickhack-business-data-flow-blueprint-1920x1080.png`

## 슬라이드 4 — 전체 시스템과 코드 책임

- Client / Server / Worker / External API / DB
- route → service → transaction → ledger → adapter

이미지: `quickhack-system-architecture-blueprint-1920x1080.png` 또는 code structure blueprint

## 슬라이드 5 — 핵심 비즈니스 흐름

- 입고 → 검수 → 매입 → 재고 → 매칭 → 포장 → 송장 → 배송 → 반품
- PG가 실물의 기준
- SKU balance와 movement가 수량의 기준

이미지: business flow + 간단한 상태 전이

## 슬라이드 6 — 설계 사례 1: 숫자의 근거

- `inventory`와 quantity ledger 분리
- `READY / EMPTY / INITIALIZATION_PENDING / PARTIAL`
- movement lazy loading과 공통 reconciliation

이미지: core data model blueprint

## 슬라이드 7 — 설계 사례 2: 실패와 자동화 중단

- 외부 쓰기 결과 불명
- GET 검증 우선
- `REVIEW_REQUIRED`
- 무조건 retry하지 않음

이미지: safe external write blueprint

## 슬라이드 8 — 설계 사례 3: 개인정보와 복구 경계

- 동기화 시각이 아닌 업무 종결 수명주기
- 2년 보증과 배송 PII 분리
- online restore 제거와 offline 경계

이미지: 개인정보 lifecycle과 restore boundary를 반으로 나눈 도식

## 슬라이드 9 — 바이브 코딩의 전환

왼쪽:

```text
해줘 → 생성 → 동작 확인
```

오른쪽:

```text
FACT → PRODUCT → DESIGN
→ PR·lane → AI 구현
→ test·코드·문서 검증
```

핵심 문장:

> 프롬프트를 길게 쓴 것이 아니라 판단과 작업의 구조를 바꿨다.

## 슬라이드 10 — 제가 AI 설계를 수정한 증거

메인 evidence card:

```text
AI: 180초 후 자동 강제 종료 / READY
사용자: 이 목적은 강제 종료를 줄여 데이터 사고를 막는 것 아닌가?
코드 확인: Coupang read 최악 약 543초
결과: 180초 warning + explicit force / test + PR #85
```

하단 보조 카드:

- 기존 backup history 재사용
- 잘못된 console process 전제 제거

## 슬라이드 11 — 병렬 작업 오케스트레이션

- 남은 P2 15건 → 11개 lane → 3개 wave
- 독립 파일·상태만 병렬화
- schema·migration·registry는 integration owner 단일 소유
- lane test → 통합 typecheck·build·staging

이미지: 작업 dependency graph

## 슬라이드 12 — 만들지 않은 것

- 근거 없는 synthetic history
- 모든 날짜 자동 backfill
- 중복 출력 때문에 복잡한 다중 PC ownership
- 일반 UI의 online DB restore
- 결과 불명 쓰기의 자동 retry

핵심 문장:

> 기능을 많이 만든 것이 아니라, 정확성과 운영 비용을 기준으로 구현 경계를 정했다.

## 슬라이드 13 — 증거

- SDD 결정 이력
- schema와 service 코드
- 상태 전이
- 전용 failure fixture
- PR·commit
- 원문 대화 전후 맥락

## 슬라이드 14 — 결론

> **QuickHack은 AI가 만든 ERP가 아니라, AI가 안정적으로 개발할 수 있도록 인간이 문제와 판단, 작업 의존성을 구조화한 프로젝트입니다.**

마지막 보조 문장:

> 저는 모호한 문제를 구현 가능한 시스템 지도로 바꾸고, 여러 AI 작업을 안전하게 병렬화하며, 그 결과가 하나의 제품 계약으로 통합되도록 책임질 수 있습니다.

## 슬라이드 15 — 선택적 조커

발표 자료에는 본문으로 넣지 않고 발표자 노트에만 기록합니다.

> “제 Codex는 이 정도면 외주로 2억에서 4억은 들 수 있다던데요. 그러니까 저를 뽑으시면 돈 아끼시는 겁니다.”

---

# 부록 A. 핵심 근거 위치

## 프로젝트 문제와 전체 구조

- `README.md`
- `portfolio/google-sheets-logistics-incident-history.md`

## 재고 원장과 reconciliation

- `specs/features/inventory-ledger-matrix/prd.md`
- `specs/features/inventory-ledger-matrix/system_design.md`
- `quickhack_server/inventory/inventory-quantity-ledger-service.ts`
- `quickhack_server/inventory/inventory-quantity-query-service.ts`
- `quickhack_server/inbound/inbound-reconciliation-service.ts`

## 외부 쓰기와 worker 복구

- `quickhack_server/sales-channel/write/sales-channel-write-service.ts`
- `quickhack_server/sales-channel/coupang/api-client.ts`
- `quickhack_server/workers/worker-jobs.ts`
- `tools/test-sales-channel-write-failure-flows.mjs`
- `tools/test-worker-lease-invariants.mjs`

## 안전 종료와 backup·restore

- `tools/quickhack-shutdown-coordinator.mjs`
- `tools/test-server-shutdown-coordinator.mjs`
- `quickhack_server/admin/backup-console-service.ts`
- `tools/quickhack-offline-restore.mjs`
- `specs/features/codebase-review-hardening/impact.md`

## 개인정보 수명주기

- `quickhack_server/security/personal-data-lifecycle-service.ts`
- `quickhack_server/security/personal-data-redaction-service.ts`
- `tools/test-personal-data-lifecycle.mjs`
- `tools/test-personal-data-derived-redaction.mjs`
- PR #89, commit `f26821cd`
- PR #90, commit `ef699b56`

## 병렬 작업 경계

- `specs/features/codebase-review-hardening/impact.md`의 P2 병렬 작업 경계
- Wave integration branches와 merge commit
- `specs/features/statistics-completion/system_design.md`

---

# 부록 B. 작성 시 주의사항

- AI의 기여를 숨기지 않습니다.
- 반대로 AI가 제품 판단과 실무 책임까지 수행한 것처럼 쓰지 않습니다.
- 확인되지 않은 성능 향상률이나 개발 속도 배수를 만들지 않습니다.
- 외주 2억~4억 문장은 견적 근거가 아니라 면접용 농담임을 유지합니다.
- 설계 단계인 판매 채널 재고 검증 worker를 구현 완료 사례처럼 표시하지 않습니다.
- 다이어그램 자체를 성과로 과장하지 않고, 반드시 실무 질문·판단·코드·test에 연결합니다.
- 모든 핵심 주장에는 다음 세 가지가 함께 있어야 합니다.

```text
제가 내린 판단
판단의 근거
실제 구현 또는 검증 증거
```
