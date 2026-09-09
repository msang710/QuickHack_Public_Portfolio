import type { Prisma } from "@/generated/prisma/client";
import { lockAndAdvanceServerSecurityState } from "@/quickhack_server/auth/security-state";
import { publicConflict, publicNotFound } from "@/quickhack_server/core/public-error";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";

export type AccountManagementSecurityContext = {
  actor: AuthUser;
  sessionId: number;
};

export async function authorizeAccountMutation(
  tx: Prisma.TransactionClient,
  context: AccountManagementSecurityContext
) {
  const serverState = await lockAndAdvanceServerSecurityState(tx);
  const session = await tx.user_sessions.findUnique({
    where: { session_id: context.sessionId },
    include: {
      users: { include: { user_totp_credentials: true } },
      user_sensitive_auth_grants: true,
    },
  });
  const now = databaseNow();
  const credential = session?.users.user_totp_credentials;
  const grant = session?.user_sensitive_auth_grants.find(
    (candidate) =>
      candidate.sensitive_action === SENSITIVE_ACTIONS.accountManagement &&
      candidate.verified_until > now &&
      candidate.credential_revision === session.users.credential_revision &&
      candidate.totp_credential_id === credential?.credential_id
  );

  if (
    !session ||
    session.expires_at <= now ||
    session.instance_epoch !== serverState.instance_epoch ||
    session.credential_revision !== session.users.credential_revision ||
    session.users.is_active !== 1 ||
    session.users.must_change_password === 1 ||
    session.users.role !== "LEADER" ||
    credential?.enabled !== 1 ||
    !grant
  ) {
    throw publicConflict(
      "ACCOUNT_AUTHORIZATION_CHANGED",
      "ACCOUNT_AUTHORIZATION_CHANGED"
    );
  }

  return { serverState, actor: session.users };
}

export async function lockAccountTarget(
  tx: Prisma.TransactionClient,
  userId: number,
  expectedRevision: number
) {
  const rows = await tx.$queryRaw<Array<{ revision: number }>>`
    SELECT revision
    FROM users
    WHERE user_id = ${userId}
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    throw publicNotFound("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
  }
  if (rows[0].revision !== expectedRevision) {
    throw publicConflict(
      "ACCOUNT_CHANGED",
      "ACCOUNT_CHANGED"
    );
  }

  return tx.users.findUniqueOrThrow({
    where: { user_id: userId },
    include: { employee_profiles: true, user_totp_credentials: true },
  });
}

export async function assertActiveLeaderRemains(
  tx: Prisma.TransactionClient,
  input: { targetUserId: number; nextRole: string; nextIsActive: number }
) {
  if (input.nextRole === "LEADER" && input.nextIsActive === 1) return;

  const otherLeaderCount = await tx.users.count({
    where: {
      user_id: { not: input.targetUserId },
      role: "LEADER",
      is_active: 1,
    },
  });
  if (otherLeaderCount === 0) {
    throw publicConflict(
      "ACTIVE_LEADER_REQUIRED",
      "ACTIVE_LEADER_REQUIRED"
    );
  }
}

export function accountAuditSnapshot(user: {
  user_id: number;
  username: string;
  role: string;
  is_developer: number;
  mobile_packing_enabled: number;
  must_change_password: number;
  is_active: number;
  revision: number;
  user_totp_credentials?: { enabled: number } | null;
  recoveryCodeCount?: number;
  employee_profiles?: {
    display_name?: string | null;
    phone?: string | null;
    email?: string | null;
    birth_date?: Date | null;
    hire_date?: Date | null;
  } | null;
}) {
  const profile = user.employee_profiles;
  return {
    userId: user.user_id,
    username: user.username,
    role: user.role,
    isDeveloper: user.is_developer === 1,
    mobilePackingEnabled: user.mobile_packing_enabled === 1,
    mustChangePassword: user.must_change_password === 1,
    isActive: user.is_active === 1,
    revision: user.revision,
    totpEnabled: user.user_totp_credentials?.enabled === 1,
    recoveryCodeCount: user.recoveryCodeCount,
    profile: {
      displayName: profile?.display_name ? "set" : "cleared",
      phone: profile?.phone ? "set" : "cleared",
      email: profile?.email ? "set" : "cleared",
      birthDate: profile?.birth_date ? "set" : "cleared",
      hireDate: profile?.hire_date ? "set" : "cleared",
    },
  };
}
