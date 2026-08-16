import { MarkerType, type Edge, type Node } from "@xyflow/react";

export type ArchitectureTone =
  | "local"
  | "core"
  | "reliability"
  | "external"
  | "success"
  | "warning"
  | "danger";

export type ArchitectureIcon =
  | "operator"
  | "desktop"
  | "adb"
  | "device"
  | "api"
  | "domain"
  | "worker"
  | "database"
  | "gateway"
  | "observability"
  | "coupang"
  | "carrier"
  | "component"
  | "route"
  | "auth"
  | "function"
  | "transaction"
  | "ledger"
  | "policy"
  | "table"
  | "snapshot"
  | "lock"
  | "timer"
  | "retry"
  | "success"
  | "warning"
  | "return";

export type ArchitectureNodeData = {
  eyebrow: string;
  title: string;
  description: string;
  detail: string;
  tone: ArchitectureTone;
  icon: ArchitectureIcon;
};

export type ArchitectureNode = Node<ArchitectureNodeData, "architecture">;

export type ArchitectureLane = {
  left: number;
  width: number;
  index: string;
  title: string;
  subtitle: string;
};

export type ArchitectureLegend = {
  label: string;
  tone: "solid" | "dashed" | "muted" | "danger";
};

export type ArchitectureDiagram = {
  id: string;
  outputName: string;
  kicker: string;
  titleLead: string;
  titleStrong: string;
  summary: [string, string];
  tech: string[];
  ariaLabel: string;
  lanes: ArchitectureLane[];
  nodes: ArchitectureNode[];
  edges: Edge[];
  legend: ArchitectureLegend[];
};

export const architectureNodes: ArchitectureNode[] = [
  {
    id: "operator",
    type: "architecture",
    position: { x: 40, y: 170 },
    data: {
      eyebrow: "현장 운영",
      title: "작업자",
      description: "입고 · 검수 · 재고 · 출고",
      detail: "권한별 ERP/WMS 업무",
      tone: "local",
      icon: "operator",
    },
  },
  {
    id: "desktop-client",
    type: "architecture",
    position: { x: 320, y: 170 },
    data: {
      eyebrow: "CLIENT RUNTIME",
      title: "Next.js 데스크톱",
      description: "업무 UI · 폼 상태 · 로컬 출력",
      detail: "중앙 서버 API 프록시",
      tone: "local",
      icon: "desktop",
    },
  },
  {
    id: "android-device",
    type: "architecture",
    position: { x: 40, y: 490 },
    data: {
      eyebrow: "DEVICE",
      title: "Galaxy 단말",
      description: "외관·기능 검수 대상",
      detail: "PG · IMEI · ADB serial",
      tone: "local",
      icon: "device",
    },
  },
  {
    id: "adb-bridge",
    type: "architecture",
    position: { x: 320, y: 490 },
    data: {
      eyebrow: "LOCAL BRIDGE",
      title: "ADB 연동",
      description: "Android platform-tools",
      detail: "기기 제어는 클라이언트에 격리",
      tone: "local",
      icon: "adb",
    },
  },
  {
    id: "central-api",
    type: "architecture",
    position: { x: 620, y: 170 },
    data: {
      eyebrow: "SERVER RUNTIME",
      title: "중앙 업무 API",
      description: "Next.js Route Wrapper",
      detail: "인증 · 권한 · 요청 계약",
      tone: "core",
      icon: "api",
    },
  },
  {
    id: "domain-services",
    type: "architecture",
    position: { x: 920, y: 170 },
    data: {
      eyebrow: "APPLICATION CORE",
      title: "도메인 서비스",
      description: "입고 · 재고 · 주문 · 출고 · 반품",
      detail: "상태 전이와 트랜잭션의 중심",
      tone: "core",
      icon: "domain",
    },
  },
  {
    id: "worker-manager",
    type: "architecture",
    position: { x: 920, y: 490 },
    data: {
      eyebrow: "BACKGROUND",
      title: "Worker Manager",
      description: "동기화 · 배송 추적 · 백업 · 통계",
      detail: "DB lease · retry · progress",
      tone: "core",
      icon: "worker",
    },
  },
  {
    id: "sqlite-ledger",
    type: "architecture",
    position: { x: 1210, y: 72 },
    data: {
      eyebrow: "SINGLE SOURCE OF TRUTH",
      title: "Prisma + SQLite",
      description: "실물·수량·주문·배송 원장",
      detail: "append-only movement · migration",
      tone: "reliability",
      icon: "database",
    },
  },
  {
    id: "write-gateway",
    type: "architecture",
    position: { x: 1210, y: 320 },
    data: {
      eyebrow: "SAFETY GATE",
      title: "외부 쓰기 게이트웨이",
      description: "멱등 요청 · 대상 스냅샷 · GET 검증",
      detail: "USB QHKEY 서명 · 수동 확인 대기열",
      tone: "reliability",
      icon: "gateway",
    },
  },
  {
    id: "observability",
    type: "architecture",
    position: { x: 1210, y: 570 },
    data: {
      eyebrow: "OBSERVABILITY",
      title: "추적과 운영 로그",
      description: "Trace ID · Server-Timing",
      detail: "작업 이력 · 실패 단계 · 성능",
      tone: "reliability",
      icon: "observability",
    },
  },
  {
    id: "coupang-api",
    type: "architecture",
    position: { x: 1510, y: 170 },
    data: {
      eyebrow: "SALES CHANNEL",
      title: "Coupang API",
      description: "주문 · 상품 · 클레임 · 송장",
      detail: "Mock 또는 Live adapter",
      tone: "external",
      icon: "coupang",
    },
  },
  {
    id: "logen-api",
    type: "architecture",
    position: { x: 1510, y: 490 },
    data: {
      eyebrow: "CARRIER",
      title: "Logen API",
      description: "송장 등록 · 라벨 · 배송 추적",
      detail: "Mock 또는 Live adapter",
      tone: "external",
      icon: "carrier",
    },
  },
];

export const requestStyle = {
  stroke: "#7dd3fc",
  strokeWidth: 2.2,
};

export const processingStyle = {
  stroke: "#a5b4fc",
  strokeWidth: 2.2,
};

export const reliableStyle = {
  stroke: "#c4b5fd",
  strokeWidth: 2.2,
};

export const backgroundStyle = {
  stroke: "#94a3b8",
  strokeWidth: 1.8,
  strokeDasharray: "7 7",
};

export const externalStyle = {
  stroke: "#fdba74",
  strokeWidth: 2.2,
};

export const successStyle = {
  stroke: "#6ee7b7",
  strokeWidth: 2.2,
};

export const dangerStyle = {
  stroke: "#fda4af",
  strokeWidth: 2,
  strokeDasharray: "6 6",
};

export function architectureEdge(
  id: string,
  source: string,
  target: string,
  options: Partial<Edge> = {}
): Edge {
  return {
    id,
    source,
    target,
    type: "smoothstep",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 18,
      height: 18,
      color: String(options.style?.stroke ?? "#94a3b8"),
    },
    ...options,
  };
}

export const architectureEdges: Edge[] = [
  architectureEdge("operator-client", "operator", "desktop-client", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "현장 업무",
    style: requestStyle,
  }),
  architectureEdge("client-api", "desktop-client", "central-api", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "HTTPS 업무 API",
    style: requestStyle,
  }),
  architectureEdge("client-adb", "desktop-client", "adb-bridge", {
    sourceHandle: "bottom-source",
    targetHandle: "top-target",
    label: "로컬 제어",
    style: requestStyle,
  }),
  architectureEdge("adb-device", "adb-bridge", "android-device", {
    sourceHandle: "left-source",
    targetHandle: "right-target",
    label: "USB / ADB",
    style: requestStyle,
  }),
  architectureEdge("api-domain", "central-api", "domain-services", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "권한 · 계약",
    style: processingStyle,
  }),
  architectureEdge("domain-database", "domain-services", "sqlite-ledger", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "원장 갱신",
    style: reliableStyle,
  }),
  architectureEdge("domain-worker", "domain-services", "worker-manager", {
    sourceHandle: "bottom-source",
    targetHandle: "top-target",
    label: "비동기 위임",
    style: processingStyle,
  }),
  architectureEdge("domain-gateway", "domain-services", "write-gateway", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "안전한 외부 쓰기",
    style: reliableStyle,
  }),
  architectureEdge("worker-database", "worker-manager", "sqlite-ledger", {
    sourceHandle: "right-source",
    targetHandle: "bottom-target",
    style: backgroundStyle,
  }),
  architectureEdge("worker-observability", "worker-manager", "observability", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "실행 결과",
    style: backgroundStyle,
  }),
  architectureEdge("api-observability", "central-api", "observability", {
    sourceHandle: "bottom-source",
    targetHandle: "left-target",
    style: backgroundStyle,
  }),
  architectureEdge("gateway-coupang", "write-gateway", "coupang-api", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "WRITE → VERIFY",
    style: externalStyle,
  }),
  architectureEdge("worker-logen", "worker-manager", "logen-api", {
    sourceHandle: "right-source",
    targetHandle: "left-target",
    label: "택배 동기화",
    style: {
      ...externalStyle,
      strokeDasharray: "7 7",
    },
  }),
];

export const overviewDiagram: ArchitectureDiagram = {
  id: "overview",
  outputName: "quickhack-system-architecture",
  kicker: "ERP / WMS SYSTEM ARCHITECTURE",
  titleLead: "한 대의 기기를,",
  titleStrong: "끝까지 추적하는 운영 아키텍처",
  summary: [
    "로컬 검수부터 중앙 원장, 외부 판매·택배 연동까지",
    "역할 분리와 실패 복구를 전제로 설계했습니다.",
  ],
  tech: [
    "Next.js 16",
    "React 19",
    "Prisma · SQLite",
    "Lease-based Workers",
    "Idempotent Writes",
  ],
  ariaLabel: "QuickHack 전체 작동 구조",
  lanes: [
    {
      left: 40,
      width: 520,
      index: "01",
      title: "LOCAL OPERATIONS",
      subtitle: "작업자 · 데스크톱 · 단말",
    },
    {
      left: 620,
      width: 530,
      index: "02",
      title: "APPLICATION CORE",
      subtitle: "중앙 API · 도메인 · Worker",
    },
    {
      left: 1210,
      width: 240,
      index: "03",
      title: "DATA & RELIABILITY",
      subtitle: "원장 · 안전장치 · 관측",
    },
    {
      left: 1510,
      width: 250,
      index: "04",
      title: "EXTERNAL SYSTEMS",
      subtitle: "판매 채널 · 택배사",
    },
  ],
  nodes: architectureNodes,
  edges: architectureEdges,
  legend: [
    { label: "사용자 요청 · 업무 처리", tone: "solid" },
    { label: "백그라운드 동기화 · 복구", tone: "dashed" },
    { label: "자격 증명 · 관측 · 실행 이력", tone: "muted" },
  ],
};
