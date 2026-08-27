// QuickHack note: 메인 ERP/WMS 좌측 메뉴의 항목, 권한, 아이콘 구성을 정의합니다.
import type * as React from "react";
import {
  BadgeDollarSign,
  BarChart3,
  CheckCheck,
  ClipboardCheck,
  ClipboardList,
  Code2,
  Database,
  FileDown,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Menu,
  PackageCheck,
  PackagePlus,
  PanelRightOpen,
  PencilLine,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  ServerCog,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Store,
  TerminalSquare,
  Truck,
  UsersRound,
  Warehouse,
  Wrench,
} from "lucide-react";
import {
  canAccessDeveloper,
  canAccessRole,
  type AuthUser,
  type Role,
} from "@/quickhack_shared/auth/auth-constants";
import type { ShortcutActionCode } from "@/quickhack_shared/user/personal-settings";

export type MenuItemId =
  | "dashboard"
  | "personal-settings"
  | "inbound-appearance"
  | "inbound-function"
  | "inbound-upload-pending"
  | "inbound-batch"
  | "inbound-purchase-price"
  | "inbound-purchase-pending"
  | "inventory-search"
  | "inventory-audit"
  | "inventory-quantity-ledger"
  | "inventory-edit"
  | "inventory-manage"
  | "supplies-inventory"
  | "supplies-forecast"
  | "supplies-repurchase"
  | "shipment-all-orders"
  | "shipment-delivery-changes"
  | "shipment-matched"
  | "shipment-today"
  | "shipment-in-transit"
  | "shipment-delivery-search"
  | "return-before-shipment"
  | "return-after-shipment"
  | "invoice-issue-history"
  | "invoice-manual-issue"
  | "invoice-registration-failures"
  | "invoice-carrier-dispatch-settings"
  | "statistics-purchase"
  | "statistics-inventory"
  | "statistics-sales"
  | "statistics-returns"
  | "admin-users"
  | "admin-product-criteria"
  | "admin-sales-product-combinations"
  | "admin-channel-products"
  | "admin-channel-order-matching"
  | "sales-channel-manual-order-match"
  | "admin-order-matching-policy"
  | "admin-staff-work-history"
  | "admin-server-logs"
  | "admin-sales-channel-sync-check"
  | "admin-system-status"
  | "developer-response-performance"
  | "admin-security-status"
  | "developer-diagnostics"
  | "developer-api-sandbox"
  | "developer-adb-diagnostics"
  | "developer-db-migrations";

export type MenuIcon = React.ComponentType<{ className?: string }>;

export type MenuGroupId =
  | "main"
  | "inbound"
  | "inventory"
  | "shipment"
  | "returns"
  | "invoice"
  | "supplies"
  | "stats"
  | "product-management"
  | "sales-channel"
  | "system-admin"
  | "developer";

// QuickHack object: 권한, 아이콘, 설명을 포함한 좌측 메뉴 한 항목의 구조입니다.
export type MenuItem = {
  id: MenuItemId;
  label: string;
  minRole: Role;
  icon: MenuIcon;
  description: string;
  developerOnly?: boolean;
};

// QuickHack object: 좌측 메뉴를 업무 영역별로 묶는 그룹 구조입니다.
export type MenuGroup = {
  id: MenuGroupId;
  label: string;
  icon: MenuIcon;
  items: MenuItem[];
};

// Function keys stay attached to business areas even when permissions hide some menus.
export const menuShortcutActions = [
  { actionCode: "NAVIGATE_MAIN", groupIds: ["main"] },
  { actionCode: "NAVIGATE_INBOUND", groupIds: ["inbound"] },
  { actionCode: "NAVIGATE_INVENTORY", groupIds: ["inventory"] },
  { actionCode: "NAVIGATE_SHIPMENT", groupIds: ["shipment"] },
  { actionCode: "NAVIGATE_RETURNS", groupIds: ["returns"] },
  { actionCode: "NAVIGATE_INVOICE", groupIds: ["invoice"] },
  { actionCode: "NAVIGATE_SUPPLIES", groupIds: ["supplies"] },
  { actionCode: "NAVIGATE_STATS", groupIds: ["stats"] },
  {
    actionCode: "NAVIGATE_SYSTEM_ADMIN",
    // Preserve the historical Shift+F9 destination after the admin menu split.
    groupIds: ["system-admin", "product-management", "sales-channel"],
  },
  { actionCode: "NAVIGATE_DEVELOPER", groupIds: ["developer"] },
] as const satisfies ReadonlyArray<{
  actionCode: ShortcutActionCode;
  groupIds: readonly MenuGroupId[];
}>;

export function findShortcutMenuGroup(
  groups: readonly MenuGroup[],
  actionCode: ShortcutActionCode
) {
  const shortcut = menuShortcutActions.find(
    (candidate) => candidate.actionCode === actionCode
  );

  if (!shortcut) {
    return undefined;
  }

  for (const groupId of shortcut.groupIds) {
    const group = groups.find((candidate) => candidate.id === groupId);

    if (group) {
      return group;
    }
  }

  return undefined;
}

// QuickHack object: 입고/재고/출고/시스템 관리/개발자 메뉴의 전체 구성을 정의합니다.
export const menuGroups: MenuGroup[] = [
  {
    id: "main",
    label: "메인",
    icon: Menu,
    items: [
      {
        id: "dashboard",
        label: "대쉬보드",
        minRole: "VIEWER",
        icon: LayoutDashboard,
        description: "전체 업무 현황을 확인합니다.",
      },
    ],
  },
  {
    id: "inbound",
    label: "입고",
    icon: PackagePlus,
    items: [
      {
        id: "inbound-appearance",
        label: "외관 검수",
        minRole: "STAFF",
        icon: ClipboardCheck,
        description: "입고 기기의 외관 검수 작업 메뉴입니다.",
      },
      {
        id: "inbound-function",
        label: "기능 검수",
        minRole: "STAFF",
        icon: Wrench,
        description: "입고 기기의 기능 검수 작업 메뉴입니다.",
      },
      {
        id: "inbound-upload-pending",
        label: "업로드 대기 목록",
        minRole: "STAFF",
        icon: ListChecks,
        description: "검수 후 서버 업로드를 기다리는 목록입니다.",
      },
      {
        id: "inbound-batch",
        label: "차수 지정",
        minRole: "STAFF",
        icon: ClipboardList,
        description: "입고 차수를 지정하는 메뉴입니다.",
      },
      {
        id: "inbound-purchase-price",
        label: "매입가 지정",
        minRole: "MANAGER",
        icon: BadgeDollarSign,
        description: "기기별 매입가를 지정하는 메뉴입니다.",
      },
      {
        id: "inbound-purchase-pending",
        label: "매입 대기 목록",
        minRole: "MANAGER",
        icon: FileDown,
        description: "검수 완료 후 매입 협상과 중가비 등록을 준비하는 목록입니다.",
      },
    ],
  },
  {
    id: "inventory",
    label: "재고",
    icon: Warehouse,
    items: [
      {
        id: "inventory-search",
        label: "재고 조회",
        minRole: "VIEWER",
        icon: Search,
        description: "현재 등록된 기기와 재고 상태를 조회합니다.",
      },
      {
        id: "inventory-audit",
        label: "재고 실사",
        minRole: "STAFF",
        icon: ListChecks,
        description: "실물 재고와 시스템 재고를 대조하는 메뉴입니다.",
      },
      {
        id: "inventory-quantity-ledger",
        label: "재고 수불 현황",
        minRole: "STAFF",
        icon: ScrollText,
        description: "재고 SKU별 현재 수량과 변동 이력을 확인합니다.",
      },
      {
        id: "inventory-edit",
        label: "기존 재고 수정",
        minRole: "MANAGER",
        icon: PencilLine,
        description: "기존 재고 데이터를 수정하는 메뉴입니다.",
      },
      {
        id: "inventory-manage",
        label: "재고 추가 / 삭제",
        minRole: "MANAGER",
        icon: PackageCheck,
        description: "재고를 직접 추가하거나 삭제하는 메뉴입니다.",
      },
    ],
  },
  {
    id: "shipment",
    label: "출고",
    icon: Truck,
    items: [
      {
        id: "shipment-all-orders",
        label: "주문 매칭 작업 목록",
        minRole: "MANAGER",
        icon: ClipboardList,
        description: "매칭 worker가 처리하는 주문 작업지시서 목록입니다.",
      },
      {
        id: "shipment-matched",
        label: "매칭 완료",
        minRole: "STAFF",
        icon: CheckCheck,
        description: "주문과 재고 매칭이 완료된 목록입니다.",
      },
      {
        id: "shipment-delivery-changes",
        label: "배송 정보 변경 건 조회",
        minRole: "MANAGER",
        icon: PanelRightOpen,
        description: "배송 정보가 변경된 주문 건을 조회하는 메뉴입니다.",
      },
      {
        id: "shipment-today",
        label: "오늘의 출고 목록",
        minRole: "STAFF",
        icon: Send,
        description: "매칭 완료 목록 출력 시점 기준으로 당일 출고 확인 목록을 조회합니다.",
      },
      {
        id: "shipment-in-transit",
        label: "현재 배송 중 목록",
        minRole: "STAFF",
        icon: Truck,
        description: "현재 송장 등록·배송 중·배송 예외 상태인 목록입니다.",
      },
      {
        id: "shipment-delivery-search",
        label: "전체 배송 건 검색",
        minRole: "STAFF",
        icon: Search,
        description: "기간과 조건을 직접 지정해 배송 건을 검색하는 메뉴입니다.",
      },
    ],
  },
  {
    id: "returns",
    label: "반품관리",
    icon: RotateCcw,
    items: [
      {
        id: "return-before-shipment",
        label: "출고 전 반품 조회",
        minRole: "STAFF",
        icon: ClipboardList,
        description: "결제완료부터 배송지시까지의 쿠팡 반품 요청을 조회하고 회수 처리합니다.",
      },
      {
        id: "return-after-shipment",
        label: "출고 후 반품 조회",
        minRole: "STAFF",
        icon: RotateCcw,
        description: "출고 후 접수된 고객 반품 요청을 조회하는 메뉴입니다.",
      },
    ],
  },
  {
    id: "invoice",
    label: "송장 관리",
    icon: Send,
    items: [
      {
        id: "invoice-issue-history",
        label: "송장 발급 이력 조회",
        minRole: "MANAGER",
        icon: ScrollText,
        description: "송장 발급 이력을 조회하는 메뉴입니다.",
      },
      {
        id: "invoice-manual-issue",
        label: "수동 송장 발급",
        minRole: "MANAGER",
        icon: PencilLine,
        description: "송장을 수동으로 발급하는 메뉴입니다.",
      },
      {
        id: "invoice-registration-failures",
        label: "송장 등록 실패 조회",
        minRole: "MANAGER",
        icon: ListChecks,
        description: "판매 채널 송장 등록에 실패한 건을 조회하는 메뉴입니다.",
      },
      {
        id: "invoice-carrier-dispatch-settings",
        label: "택배사 발송 설정",
        minRole: "LEADER",
        icon: Truck,
        description: "택배사 송장 등록에 사용할 발송자와 기본 포장 정보를 관리합니다.",
      },
    ],
  },
  {
    id: "supplies",
    label: "비품관리",
    icon: PackageCheck,
    items: [
      {
        id: "supplies-inventory",
        label: "재고관리",
        minRole: "STAFF",
        icon: PackageCheck,
        description: "비품 재고 현황을 관리하는 메뉴입니다.",
      },
      {
        id: "supplies-forecast",
        label: "소요예측",
        minRole: "STAFF",
        icon: BarChart3,
        description: "비품 사용량을 기준으로 향후 소요량을 예측하는 메뉴입니다.",
      },
      {
        id: "supplies-repurchase",
        label: "재구매",
        minRole: "STAFF",
        icon: BadgeDollarSign,
        description: "비품 재구매 대상과 발주 준비 상태를 관리하는 메뉴입니다.",
      },
    ],
  },
  {
    id: "stats",
    label: "통계",
    icon: BarChart3,
    items: [
      {
        id: "statistics-purchase",
        label: "매입",
        minRole: "LEADER",
        icon: BadgeDollarSign,
        description: "매입가, 매입처, 차수 기준 통계를 확인합니다.",
      },
      {
        id: "statistics-inventory",
        label: "재고",
        minRole: "LEADER",
        icon: Warehouse,
        description:
          "현재 재고 구성, 장기 재고 부담, 기간 흐름과 판매 회전율을 확인합니다.",
      },
      {
        id: "statistics-sales",
        label: "판매",
        minRole: "LEADER",
        icon: Store,
        description: "판매, 주문 매칭, 출고 기준 통계를 확인합니다.",
      },
      {
        id: "statistics-returns",
        label: "반품",
        minRole: "LEADER",
        icon: RotateCcw,
        description: "고객 반품, 출고 전 취소, 교환 통계를 확인합니다.",
      },
    ],
  },
  {
    id: "product-management",
    label: "상품 관리",
    icon: Database,
    items: [
      {
        id: "admin-product-criteria",
        label: "상품 기준값 관리",
        minRole: "LEADER",
        icon: Database,
        description: "검수 드롭박스와 모델코드, 통신사, 공식 색상명, 용량 기준값을 관리합니다.",
      },
      {
        id: "admin-sales-product-combinations",
        label: "판매 상품 조합 관리",
        minRole: "LEADER",
        icon: Store,
        description: "기종, 용량, 판매등급, 보증 조건으로 구성된 판매용 상품 조합을 관리합니다.",
      },
    ],
  },
  {
    id: "sales-channel",
    label: "판매 채널",
    icon: Store,
    items: [
      {
        id: "admin-channel-products",
        label: "채널별 상품 관리",
        minRole: "LEADER",
        icon: Store,
        description: "판매 채널별 상품 매핑과 상품 정보를 관리하는 메뉴입니다.",
      },
      {
        id: "sales-channel-manual-order-match",
        label: "주문 변경 요청",
        minRole: "STAFF",
        icon: PencilLine,
        description: "기존 판매채널 주문의 고객 변경 요청에 따라 출고 PG를 직접 조정합니다.",
      },
      {
        id: "admin-channel-order-matching",
        label: "채널별 주문 매칭 관리",
        minRole: "LEADER",
        icon: ListChecks,
        description: "판매 채널별 주문 매칭 기준을 관리하는 메뉴입니다.",
      },
      {
        id: "admin-order-matching-policy",
        label: "주문 매칭 정책",
        minRole: "LEADER",
        icon: ShieldCheck,
        description: "자동 주문 매칭 worker의 고정 조건과 운영 정책 기준을 확인합니다.",
      },
      {
        id: "admin-sales-channel-sync-check",
        label: "판매 채널 동기화 점검",
        minRole: "STAFF",
        icon: ShieldAlert,
        description: "외부 채널 쓰기 결과와 재고 수량 불일치·점검 실패를 한 곳에서 확인합니다.",
      },
    ],
  },
  {
    id: "system-admin",
    label: "시스템 관리",
    icon: Settings,
    items: [
      {
        id: "admin-users",
        label: "사용자 계정 관리",
        minRole: "LEADER",
        icon: UsersRound,
        description: "직원 계정과 권한을 관리하는 메뉴입니다.",
      },
      {
        id: "admin-staff-work-history",
        label: "직원 작업 이력 조회",
        minRole: "LEADER",
        icon: ClipboardList,
        description: "직원별 주요 작업 이력을 조회하는 메뉴입니다.",
      },
      {
        id: "admin-server-logs",
        label: "서버 작업 로그 조회",
        minRole: "LEADER",
        icon: ScrollText,
        description: "서버 작업 이력과 오류 로그를 조회하는 메뉴입니다.",
      },
      {
        id: "admin-system-status",
        label: "시스템 상태",
        minRole: "LEADER",
        icon: ServerCog,
        description: "서버, DB, 연동 상태를 확인하는 메뉴입니다.",
      },
      {
        id: "admin-security-status",
        label: "보안 점검",
        minRole: "LEADER",
        icon: ShieldCheck,
        description: "OTP, 백업, 운영 환경, 보안 worker 상태를 점검하는 메뉴입니다.",
      },
    ],
  },
  {
    id: "developer",
    label: "개발자 메뉴",
    icon: Code2,
    items: [
      {
        id: "developer-diagnostics",
        label: "개발자 진단",
        minRole: "VIEWER",
        developerOnly: true,
        icon: TerminalSquare,
        description: "런타임, 서버, DB, 클라이언트 상태를 개발자 관점에서 점검하는 메뉴입니다.",
      },
      {
        id: "developer-response-performance",
        label: "응답 성능 측정",
        minRole: "VIEWER",
        developerOnly: true,
        icon: Gauge,
        description: "사용자 조작 trace의 응답 시간과 DB·트랜잭션 처리 구간을 분석합니다.",
      },
      {
        id: "developer-api-sandbox",
        label: "API 테스트",
        minRole: "VIEWER",
        developerOnly: true,
        icon: ServerCog,
        description: "외부 API와 내부 API 요청을 안전 모드로 재현하고 응답을 확인하는 메뉴입니다.",
      },
      {
        id: "developer-adb-diagnostics",
        label: "ADB 진단",
        minRole: "VIEWER",
        developerOnly: true,
        icon: Wrench,
        description: "ADB 경로, 서버 상태, 연결 기기, offline 장치를 점검하는 메뉴입니다.",
      },
      {
        id: "developer-db-migrations",
        label: "DB / 마이그레이션 점검",
        minRole: "VIEWER",
        developerOnly: true,
        icon: Database,
        description: "Prisma 스키마, 마이그레이션 적용 상태, 주요 테이블 카운트를 점검하는 메뉴입니다.",
      },
    ],
  },
];

const menuTextOverrides: Partial<
  Record<MenuItemId, Pick<MenuItem, "label" | "description">>
> = {
  "return-before-shipment": {
    label: "출고 전 반품목록",
    description: "출고 확정 전 취소·반품 신호가 있는 주문 품목을 확인합니다.",
  },
  "return-after-shipment": {
    label: "출고 후 반품목록",
    description: "출고 이후 접수된 반품 데이터를 주문·출고 정보와 함께 확인합니다.",
  },
};

for (const group of menuGroups) {
  for (const item of group.items) {
    const override = menuTextOverrides[item.id];

    if (override) {
      Object.assign(item, override);
    }
  }
}

export const sensitiveMenuIds = new Set<MenuItemId>([
  "inventory-edit",
  "inventory-manage",
  "admin-channel-products",
  "admin-channel-order-matching",
  "admin-order-matching-policy",
]);

const utilityMenuItems: MenuItem[] = [
  {
    id: "personal-settings",
    label: "개인 설정",
    minRole: "VIEWER",
    icon: Settings,
    description: "사용자별 단축키와 알림 설정을 관리합니다.",
  },
];

export function canAccessMenuItem(user: AuthUser, item: MenuItem) {
  if (item.developerOnly && !canAccessDeveloper(user)) {
    return false;
  }

  return canAccessRole(user.role, item.minRole);
}

export function findMenuItem(id: MenuItemId) {
  const utilityItem = utilityMenuItems.find((item) => item.id === id);

  if (utilityItem) {
    return utilityItem;
  }

  for (const group of menuGroups) {
    const item = group.items.find((candidate) => candidate.id === id);

    if (item) {
      return item;
    }
  }

  return menuGroups[0].items[0];
}

export function getAllowedMenuGroups(user: AuthUser) {
  return menuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessMenuItem(user, item)),
    }))
    .filter((group) => group.items.length > 0);
}
