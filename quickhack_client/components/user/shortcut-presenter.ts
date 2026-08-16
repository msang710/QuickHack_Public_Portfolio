import {
  formatShortcutKeyCode,
  type ShortcutActionCode,
  type ShortcutModifier,
  type UserShortcutBinding,
} from "@/quickhack_shared/user/personal-settings";

export const SHORTCUT_MODIFIER_LABELS: Record<ShortcutModifier, string> = {
  NONE: "없음",
  CTRL: "컨트롤",
  SHIFT: "쉬프트",
  ALT: "알트",
};

export const SHORTCUT_ACTION_LABELS: Record<ShortcutActionCode, string> = {
  NAVIGATE_MAIN: "메인 메뉴 이동",
  NAVIGATE_INBOUND: "입고 메뉴 이동",
  NAVIGATE_INVENTORY: "재고 메뉴 이동",
  NAVIGATE_SHIPMENT: "출고 메뉴 이동",
  NAVIGATE_RETURNS: "반품관리 메뉴 이동",
  NAVIGATE_INVOICE: "송장 관리 메뉴 이동",
  NAVIGATE_SUPPLIES: "비품관리 메뉴 이동",
  NAVIGATE_STATS: "통계 메뉴 이동",
  NAVIGATE_SYSTEM_ADMIN: "시스템 관리 메뉴 이동",
  NAVIGATE_DEVELOPER: "개발자 메뉴 이동",
  NAVIGATE_CURRENT_GROUP_ITEM_01: "현재 메뉴 1번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_02: "현재 메뉴 2번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_03: "현재 메뉴 3번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_04: "현재 메뉴 4번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_05: "현재 메뉴 5번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_06: "현재 메뉴 6번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_07: "현재 메뉴 7번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_08: "현재 메뉴 8번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_09: "현재 메뉴 9번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_10: "현재 메뉴 10번째 하위 메뉴",
  NAVIGATE_CURRENT_GROUP_ITEM_11: "현재 메뉴 11번째 하위 메뉴",
  FOCUS_SEARCH: "현재 화면 검색",
  CLOSE_WINDOW: "창 닫기",
  REFRESH_LIST: "목록 새로고침",
  OPEN_PERSONAL_SETTINGS: "개인 설정 열기",
  OPEN_SHORTCUT_GUIDE: "단축키 안내 열기",
};

export function formatShortcutBinding(binding: UserShortcutBinding) {
  if (!binding.keyCode) {
    return "지정 안 함";
  }

  const keyLabel = formatShortcutKeyCode(binding.keyCode);

  return binding.modifier === "NONE"
    ? keyLabel
    : `${SHORTCUT_MODIFIER_LABELS[binding.modifier]} + ${keyLabel}`;
}
