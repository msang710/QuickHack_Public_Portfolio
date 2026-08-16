// QuickHack note: 세션 쿠키, 로그인 시도, 사용자 변환, 민감 인증 상태를 관리하는 인증 서비스입니다.
﻿import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/quickhack_server/core/prisma";
import { traceOperationSpan } from "@/quickhack_server/observability/operation-trace";
import {
  addSeconds,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import {
  AUTH_COOKIE_NAME,
  ROLES,
  SENSITIVE_AUTH_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  type AuthUser,
  type Role,
} from "@/quickhack_shared/auth/auth-constants";
import type { SensitiveAction } from "@/quickhack_shared/auth/sensitive-auth";
import type { Prisma } from "@/generated/prisma/client";
import { lockServerSecurityState } from "@/quickhack_server/auth/security-state";
import { getRuntimeConfig } from "@/quickhack_shared/core/runtime";
import {
  QUICKHACK_HTTPS_TERMINATION_ENV,
  QUICKHACK_PUBLIC_ORIGIN_ENV,
  resolveTransportSecurityPolicy,
} from "@/quickhack_shared/security/transport-security-policy.mjs";

export {
  AUTH_COOKIE_NAME,
  ROLES,
  SENSITIVE_AUTH_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  type AuthUser,
  type Role,
};

function nowSql() {
  return quickHackClock.nowDate();
}

function expiresAtSql() {
  return addSeconds(quickHackClock.nowDate(), SESSION_MAX_AGE_SECONDS);
}

function shouldUseSecureCookie() {
  const runtimeConfig = getRuntimeConfig();
  return resolveTransportSecurityPolicy({
    runtimeRole: runtimeConfig.role,
    production: runtimeConfig.production,
    httpsTerminated: process.env[QUICKHACK_HTTPS_TERMINATION_ENV],
    publicOrigin: process.env[QUICKHACK_PUBLIC_ORIGIN_ENV],
  }).secureSessionCookie;
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export async function cleanupExpiredSessions() {
  await prisma.user_sessions.deleteMany({
    where: {
      expires_at: {
        lte: nowSql(),
      },
    },
  });
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function toAuthUser(user: {
  user_id: number;
  username: string;
  role: string;
  is_developer?: number | null;
  mobile_packing_enabled?: number | null;
  must_change_password?: number | null;
  employee_profiles?: {
    display_name: string;
  } | null;
}): AuthUser {
  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.employee_profiles?.display_name ?? user.username,
    role: isRole(user.role) ? user.role : "VIEWER",
    isDeveloper: user.is_developer === 1,
    mobilePackingEnabled: user.mobile_packing_enabled === 1,
    mustChangePassword: user.must_change_password === 1,
  };
}

export class SessionGenerationChangedError extends Error {
  readonly code = "SESSION_GENERATION_CHANGED";

  constructor() {
    super("The account security generation changed before the session was created.");
    this.name = "SessionGenerationChangedError";
  }
}

async function insertUserSession(
  tx: Prisma.TransactionClient,
  input: {
    userId: number;
    credentialRevision: number;
    instanceEpoch: number;
  }
) {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);

  await tx.user_sessions.create({
    data: {
      user_id: input.userId,
      session_token_hash: tokenHash,
      expires_at: expiresAtSql(),
      credential_revision: input.credentialRevision,
      instance_epoch: input.instanceEpoch,
      created_at: nowSql(),
    },
  });

  return token;
}

export async function replaceUserSessionsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: number;
    credentialRevision: number;
    instanceEpoch: number;
  }
) {
  const revokedSessions = await tx.user_sessions.deleteMany({
    where: { user_id: input.userId },
  });
  const token = await insertUserSession(tx, input);

  return { token, revokedSessionCount: revokedSessions.count };
}

export async function createUserSession(
  userId: number,
  expectedCredentialRevision?: number
) {
  await cleanupExpiredSessions();

  return prisma.$transaction(async (tx) => {
    const serverState = await lockServerSecurityState(tx);
    const rows = await tx.$queryRaw<
      Array<{ credential_revision: number; is_active: number }>
    >`
      SELECT credential_revision, is_active
      FROM users
      WHERE user_id = ${userId}
      FOR SHARE
    `;
    const user = rows[0];

    if (
      !user ||
      user.is_active !== 1 ||
      (expectedCredentialRevision !== undefined &&
        user.credential_revision !== expectedCredentialRevision)
    ) {
      throw new SessionGenerationChangedError();
    }

    return insertUserSession(tx, {
      userId,
      credentialRevision: user.credential_revision,
      instanceEpoch: serverState.instance_epoch,
    });
  });
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 0,
  });
}

export async function deleteSessionToken(token: string) {
  await prisma.user_sessions.deleteMany({
    where: {
      session_token_hash: hashSessionToken(token),
    },
  });
}

async function loadValidSessionFromToken(token?: string) {
  if (!token) {
    return null;
  }

  const [session, serverState] = await Promise.all([
    prisma.user_sessions.findUnique({
      where: {
        session_token_hash: hashSessionToken(token),
      },
      include: {
        users: {
          include: {
            employee_profiles: true,
            user_totp_credentials: {
              select: { credential_id: true, enabled: true },
            },
          },
        },
        user_sensitive_auth_grants: true,
      },
    }),
    prisma.server_instance_state.findUnique({
      where: { singleton_key: "QUICKHACK" },
      select: { instance_epoch: true },
    }),
  ]);

  if (!session) {
    return null;
  }

  if (
    !serverState ||
    session.expires_at <= nowSql() ||
    session.users.is_active !== 1 ||
    session.credential_revision !== session.users.credential_revision ||
    session.instance_epoch !== serverState.instance_epoch
  ) {
    await prisma.user_sessions
      .delete({
        where: {
          session_id: session.session_id,
        },
      })
      .catch(() => {});

    return null;
  }

  return session;
}

export async function getPasswordChangeSessionFromToken(token?: string) {
  return loadValidSessionFromToken(token);
}

export async function getPasswordChangeSessionFromRequest(
  request: NextRequest
) {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  return traceOperationSpan("AUTH", () =>
    getPasswordChangeSessionFromToken(token)
  );
}

export async function getAuthSessionFromToken(token?: string) {
  const session = await loadValidSessionFromToken(token);

  if (session?.users.must_change_password === 1) {
    return null;
  }

  return session;
}

export async function getAuthUserFromToken(token?: string) {
  const session = await getAuthSessionFromToken(token);
  return session ? toAuthUser(session.users) : null;
}

export async function getAuthUserFromRequest(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  return traceOperationSpan("AUTH", () => getAuthUserFromToken(token));
}

export async function getAuthSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  return traceOperationSpan("AUTH", () => getAuthSessionFromToken(token));
}

export function isSensitiveSessionVerified(
  session: Awaited<ReturnType<typeof getAuthSessionFromToken>>,
  sensitiveAction?: SensitiveAction | null
) {
  if (!session || !sensitiveAction) {
    return false;
  }

  return session.user_sensitive_auth_grants.some(
    (grant) =>
      grant.sensitive_action === sensitiveAction &&
      grant.verified_until > nowSql() &&
      grant.credential_revision === session.users.credential_revision &&
      grant.totp_credential_id ===
        session.users.user_totp_credentials?.credential_id &&
      session.users.user_totp_credentials?.enabled === 1
  );
}
