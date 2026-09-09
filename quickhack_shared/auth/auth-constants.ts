// QuickHack note: 역할 권한 순서와 AuthUser 타입을 클라이언트/서버가 공유합니다.
﻿export const AUTH_COOKIE_NAME = "quickhack_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
export const SENSITIVE_AUTH_MAX_AGE_SECONDS = 60 * 60;

export const ROLES = ["LEADER", "MANAGER", "STAFF", "VIEWER"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  STAFF: 1,
  MANAGER: 2,
  LEADER: 3,
};

export type AuthUser = {
  userId: number;
  username: string;
  displayName: string;
  role: Role;
  isDeveloper: boolean;
  mobilePackingEnabled: boolean;
  mustChangePassword: boolean;
};

export function canAccessRole(role: Role, minRole: Role) {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function canAccessDeveloper(user: AuthUser | null | undefined) {
  return Boolean(user?.isDeveloper);
}
