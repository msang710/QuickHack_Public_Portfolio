// QuickHack note: 민감 메뉴 2차 인증 응답 형식과 유효 시간을 공유합니다.
import {
  SENSITIVE_AUTH_MAX_AGE_SECONDS,
  canAccessRole,
  type Role,
} from "@/quickhack_shared/auth/auth-constants";

export const SENSITIVE_ACTIONS = {
  accountManagement: "USER_ACCOUNT_MANAGEMENT",
  carrierIntegrationSettings: "CARRIER_INTEGRATION_SETTINGS",
  channelProducts: "CHANNEL_PRODUCTS",
  channelOrderMatching: "CHANNEL_ORDER_MATCHING",
  inboundPurchaseConfirm: "INBOUND_PURCHASE_CONFIRM",
  inventoryEdit: "INVENTORY_EDIT",
  inventoryManage: "INVENTORY_MANAGE",
} as const;

export type SensitiveAction =
  (typeof SENSITIVE_ACTIONS)[keyof typeof SENSITIVE_ACTIONS];

export const SENSITIVE_ACTION_MAX_LENGTH = 64;

export const SENSITIVE_ACTION_POLICIES = {
  [SENSITIVE_ACTIONS.accountManagement]: { minRole: "LEADER" },
  [SENSITIVE_ACTIONS.carrierIntegrationSettings]: { minRole: "LEADER" },
  [SENSITIVE_ACTIONS.channelProducts]: { minRole: "LEADER" },
  [SENSITIVE_ACTIONS.channelOrderMatching]: { minRole: "MANAGER" },
  [SENSITIVE_ACTIONS.inboundPurchaseConfirm]: { minRole: "MANAGER" },
  [SENSITIVE_ACTIONS.inventoryEdit]: { minRole: "MANAGER" },
  [SENSITIVE_ACTIONS.inventoryManage]: { minRole: "MANAGER" },
} as const satisfies Record<SensitiveAction, { minRole: Role }>;

const SENSITIVE_ACTION_SET = new Set<SensitiveAction>(
  Object.values(SENSITIVE_ACTIONS)
);

export function parseSensitiveAction(value: unknown): SensitiveAction | null {
  const action = String(value ?? "").trim();

  if (!action || action.length > SENSITIVE_ACTION_MAX_LENGTH) {
    return null;
  }

  return SENSITIVE_ACTION_SET.has(action as SensitiveAction)
    ? (action as SensitiveAction)
    : null;
}

export function canUseSensitiveAction(
  role: Role,
  action: SensitiveAction
) {
  return canAccessRole(role, SENSITIVE_ACTION_POLICIES[action].minRole);
}

export function sensitiveActionForMenu(menuId: string): SensitiveAction | null {
  switch (menuId) {
    case "admin-users":
      return SENSITIVE_ACTIONS.accountManagement;
    case "admin-channel-products":
      return SENSITIVE_ACTIONS.channelProducts;
    case "admin-channel-order-matching":
    case "admin-order-matching-policy":
    case "sales-channel-manual-order-match":
      return SENSITIVE_ACTIONS.channelOrderMatching;
    case "inventory-edit":
      return SENSITIVE_ACTIONS.inventoryEdit;
    case "inventory-manage":
      return SENSITIVE_ACTIONS.inventoryManage;
    default:
      return null;
  }
}

export type SensitiveAuthRequiredResponse = {
  ok: false;
  message: string;
  sensitiveAuthRequired: true;
  sensitiveAction?: SensitiveAction;
  sensitiveAuthMaxAgeSeconds?: number;
};

export function sensitiveAuthRequiredResponse(
  message: string,
  sensitiveAction: SensitiveAction
): SensitiveAuthRequiredResponse {
  return {
    ok: false,
    message,
    sensitiveAuthRequired: true,
    sensitiveAction,
    sensitiveAuthMaxAgeSeconds: SENSITIVE_AUTH_MAX_AGE_SECONDS,
  };
}

export function isSensitiveAuthRequiredResponse(
  value: unknown
): value is SensitiveAuthRequiredResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      "sensitiveAuthRequired" in value &&
      (value as { sensitiveAuthRequired?: unknown }).sensitiveAuthRequired ===
        true
  );
}
