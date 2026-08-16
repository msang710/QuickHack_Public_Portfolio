# QuickHack 시스템 아키텍처 포트폴리오 이미지

QuickHack 운영 제품과 분리된 포트폴리오 전용 React Flow 렌더러입니다.
루트 애플리케이션의 메뉴, API, DB, 패키지 의존성에는 영향을 주지 않습니다.

## 구조 근거

- `README.md`의 전체 아키텍처와 배포 역할 분리
- `quickhack_client/`, `app/api/`, `quickhack_server/`, `quickhack_shared/`
- `prisma/schema.prisma`의 실물·수량·주문·배송·worker 원장
- worker registry의 lease, retry, progress 처리
- 판매 채널 쓰기 서비스의 idempotency와 GET verification

## 실행

```powershell
npm install
npm run render
```

`output/`에 1920×1080 PNG가 생성됩니다.

청사진 테마는 다음처럼 렌더링합니다.

```powershell
$env:RENDER_THEME="blueprint"
npm run render
```

파일명에는 `-blueprint-1920x1080`이 붙으며 기존 기본 테마 이미지는
덮어쓰지 않습니다.

## 다이어그램

| ID | 내용 | 대표 근거 |
| --- | --- | --- |
| `overview` | 전체 시스템 아키텍처 | 루트 `README.md`, 배포 역할 분리 |
| `code-structure` | 매입 확정의 실제 코드 호출 경로 | `purchase-pending-list-view.tsx` → API → service → ledger |
| `business-data-flow` | 입고부터 판매·반품까지의 핵심 데이터 흐름 | inbound, inventory, allocation, shipment, sales/return models |
| `safe-external-write` | 외부 쓰기 상태 기계와 실패 복구 | write service, adapter, verification, review service |
| `worker-recovery` | Worker 스케줄·lease·retry·실행 로그 | manager, registry, schedule, worker-jobs |
| `core-data-model` | 핵심 Prisma 모델 관계 | `prisma/schema.prisma` |

개발 서버에서는 `?diagram=<ID>`로 한 장씩 확인할 수 있습니다.

```text
http://localhost:5173/?diagram=code-structure
http://localhost:5173/?diagram=business-data-flow
http://localhost:5173/?diagram=safe-external-write
http://localhost:5173/?diagram=worker-recovery
http://localhost:5173/?diagram=core-data-model
```

렌더 스크립트는 6종 모두에 대해 노드·엣지 개수, 브라우저 런타임 오류,
노드의 캔버스 이탈 여부와 1920×1080 논리 캔버스를 확인한 뒤 PNG를
저장합니다.
