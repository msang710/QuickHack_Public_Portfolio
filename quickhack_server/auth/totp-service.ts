import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  publicConflict,
  publicForbidden,
} from "@/quickhack_server/core/public-error";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { lockServerSecurityState } from "@/quickhack_server/auth/security-state";
import {
  hashSessionToken,
  replaceUserSessionsInTransaction,
} from "@/quickhack_server/auth/auth-service";
import { verifyPassword } from "@/quickhack_server/core/password";
import {
  getTotpKeyStatus,
  requireTotpKeyReady as requireServerTotpKeyReady,
  withTotpEncryptionKey,
} from "@/quickhack_server/security/totp-key-provider";
import { canUseSensitiveAction, type SensitiveAction } from "@/quickhack_shared/auth/sensitive-auth";
import { SENSITIVE_AUTH_MAX_AGE_SECONDS } from "@/quickhack_shared/auth/auth-constants";
import { isRole } from "@/quickhack_server/auth/auth-service";
import { addSeconds, quickHackClock } from "@/quickhack_shared/core/time";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_ALGORITHM = "sha1";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_BYTES = 20;
const TOTP_WINDOW = 1;
const TOTP_MAX_FAILED_ATTEMPTS = 5;
const TOTP_LOCK_SECONDS = 5 * 60;
const RECOVERY_CODE_BYTES = 10;
const DEFAULT_RECOVERY_CODE_COUNT = 10;

export type TotpServiceKeyAccess = {
  getStatus: typeof getTotpKeyStatus;
  requireReady: typeof requireServerTotpKeyReady;
  withKey: typeof withTotpEncryptionKey;
};

const serverTotpKeyAccess: TotpServiceKeyAccess = {
  getStatus: getTotpKeyStatus,
  requireReady: requireServerTotpKeyReady,
  withKey: withTotpEncryptionKey,
};

function base32Encode(buffer: Buffer) {
  let value = 0;
  let bits = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string) {
  let bits = 0;
  let current = 0;
  const output: number[] = [];
  for (const char of value.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function encryptSecret(secret: string, keyAccess: TotpServiceKeyAccess) {
  return keyAccess.withKey((key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      secret_ciphertext: ciphertext.toString("base64url"),
      secret_iv: iv.toString("base64url"),
      secret_auth_tag: cipher.getAuthTag().toString("base64url"),
    };
  });
}

function decryptSecret(
  input: { secret_ciphertext: string; secret_iv: string; secret_auth_tag: string },
  keyAccess: TotpServiceKeyAccess
) {
  return keyAccess.withKey((key) => {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.secret_iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(input.secret_auth_tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.secret_ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  });
}

function normalizeOtpCode(value: string) {
  return value.replace(/\D/g, "").slice(0, TOTP_DIGITS);
}

function safeCodeEquals(left: string, right: string) {
  return left.length === right.length && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function lockedSecondsUntil(lockedUntil: Date | null, now = quickHackClock.nowDate()) {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

function normalizeRecoveryCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recoveryCodeHash(value: string) {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(value), "utf8").digest("base64url");
}

function createRecoveryCode() {
  const raw = crypto.randomBytes(RECOVERY_CODE_BYTES).toString("base64url").toUpperCase();
  const value = raw.replace(/[^A-Z0-9]/g, "").slice(0, 16).padEnd(16, "X");
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}`;
}

function totpCodeAtStep(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac(TOTP_ALGORITHM, base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function matchingTotpStep(secret: string, code: string, at = quickHackClock.nowDate()) {
  const normalized = normalizeOtpCode(code);
  if (normalized.length !== TOTP_DIGITS) return null;
  const current = Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    if (step >= 0 && safeCodeEquals(totpCodeAtStep(secret, step), normalized)) return step;
  }
  return null;
}

function enrollmentToken(input: {
  credential_id: number;
  user_id: number;
  secret_ciphertext: string;
  secret_iv: string;
  secret_auth_tag: string;
}) {
  return crypto
    .createHash("sha256")
    .update(
      [input.credential_id, input.user_id, input.secret_ciphertext, input.secret_iv, input.secret_auth_tag].join(":"),
      "utf8"
    )
    .digest("base64url");
}

function enrollmentResponse(
  credential: Parameters<typeof enrollmentToken>[0],
  username: string,
  secret: string
) {
  const label = `QuickHack:${username}`;
  return {
    secret,
    otpauthUri:
      `otpauth://totp/${encodeURIComponent(label)}` +
      `?secret=${encodeURIComponent(secret)}` +
      `&issuer=${encodeURIComponent("QuickHack")}` +
      `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`,
    enrollmentToken: enrollmentToken(credential),
    periodSeconds: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
  };
}

async function lockUser(tx: Prisma.TransactionClient, userId: number) {
  await tx.$queryRaw`SELECT user_id FROM users WHERE user_id = ${userId} FOR UPDATE`;
  return tx.users.findUnique({ where: { user_id: userId } });
}

async function requireCurrentSession(
  tx: Prisma.TransactionClient,
  input: { sessionId: number; userId: number },
  instanceEpoch: number
) {
  const session = await tx.user_sessions.findUnique({ where: { session_id: input.sessionId } });
  const user = await tx.users.findUnique({ where: { user_id: input.userId } });
  if (
    !session ||
    !user ||
    session.user_id !== user.user_id ||
    session.expires_at <= databaseNow() ||
    session.credential_revision !== user.credential_revision ||
    session.instance_epoch !== instanceEpoch ||
    user.is_active !== 1 ||
    user.must_change_password === 1
  ) {
    throw publicConflict("ACCOUNT_SECURITY_CHANGED", "계정 보안 상태가 변경되었습니다. 다시 로그인하세요.");
  }
  return { session, user };
}

async function createPendingEnrollment(
  tx: Prisma.TransactionClient,
  userId: number,
  username: string,
  keyAccess: TotpServiceKeyAccess
) {
  const existing = await tx.user_totp_credentials.findUnique({ where: { user_id: userId } });
  if (existing?.enabled === 1) {
    throw publicConflict("TOTP_ALREADY_CONFIGURED", "이미 OTP가 설정된 계정입니다.");
  }
  if (existing) {
    return enrollmentResponse(existing, username, await decryptSecret(existing, keyAccess));
  }
  const secret = base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));
  const credential = await tx.user_totp_credentials.create({
    data: {
      user_id: userId,
      ...(await encryptSecret(secret, keyAccess)),
      enabled: 0,
      created_at: databaseNow(),
      updated_at: databaseNow(),
    },
  });
  return enrollmentResponse(credential, username, secret);
}

export async function getTotpServerStatus(keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess) {
  return {
    ...(await keyAccess.getStatus()),
    periodSeconds: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
    issuer: "QuickHack",
  };
}

export function requireTotpKeyReady(keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess) {
  return keyAccess.requireReady();
}

export async function getUserTotpStatus(
  userId: number,
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
) {
  const [credential, unusedRecoveryCodeCount, server] = await Promise.all([
    prisma.user_totp_credentials.findUnique({ where: { user_id: userId } }),
    prisma.user_totp_recovery_codes.count({ where: { user_id: userId, used_at: null } }),
    getTotpServerStatus(keyAccess),
  ]);
  return {
    configured: Boolean(credential),
    enabled: credential?.enabled === 1,
    verifiedAt: credential?.verified_at ?? null,
    createdAt: credential?.created_at ?? null,
    updatedAt: credential?.updated_at ?? null,
    lockedUntil: credential?.locked_until ?? null,
    unusedRecoveryCodeCount,
    server,
  };
}

export async function createTotpEnrollment(
  userId: number,
  username: string,
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    await lockServerSecurityState(tx);
    await lockUser(tx, userId);
    return createPendingEnrollment(tx, userId, username, keyAccess);
  });
}

export async function createTotpEnrollmentForSession(input: {
  sessionId: number;
  userId: number;
  passwordHash: string;
  password: string;
}, keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess) {
  await keyAccess.requireReady();
  if (!(await verifyPassword(input.password, input.passwordHash))) {
    throw publicConflict("CURRENT_PASSWORD_INVALID", "현재 비밀번호가 올바르지 않습니다.");
  }
  return prisma.$transaction(async (tx) => {
    const state = await lockServerSecurityState(tx);
    await lockUser(tx, input.userId);
    const { user } = await requireCurrentSession(tx, input, state.instance_epoch);
    if (user.password_hash !== input.passwordHash) {
      throw publicConflict("ACCOUNT_SECURITY_CHANGED", "계정 보안 상태가 변경되었습니다. 다시 로그인하세요.");
    }
    return createPendingEnrollment(tx, user.user_id, user.username, keyAccess);
  });
}

export async function replaceUserTotpRecoveryCodes(
  tx: Prisma.TransactionClient,
  userId: number,
  count = DEFAULT_RECOVERY_CODE_COUNT
) {
  const codes = Array.from({ length: Math.max(1, Math.min(count, 20)) }, createRecoveryCode);
  const now = databaseNow();
  await tx.user_totp_recovery_codes.deleteMany({ where: { user_id: userId } });
  await tx.user_totp_recovery_codes.createMany({
    data: codes.map((code) => ({ user_id: userId, code_hash: recoveryCodeHash(code), created_at: now })),
  });
  return codes;
}

async function confirmEnrollment(
  tx: Prisma.TransactionClient,
  input: { userId: number; code: string; enrollmentToken: string },
  instanceEpoch: number,
  keyAccess: TotpServiceKeyAccess
) {
  const credential = await tx.user_totp_credentials.findUnique({ where: { user_id: input.userId } });
  if (!credential) return { confirmed: false as const };
  if (credential.enabled === 1) {
    throw publicConflict("TOTP_ENROLLMENT_ALREADY_CONFIRMED", "이 OTP 등록은 이미 완료되었습니다.");
  }
  if (!input.enrollmentToken || enrollmentToken(credential) !== input.enrollmentToken) {
    throw publicConflict("TOTP_ENROLLMENT_CHANGED", "OTP 등록 정보가 변경되었습니다. 등록을 다시 시작하세요.");
  }
  const matchedStep = matchingTotpStep(await decryptSecret(credential, keyAccess), input.code);
  if (matchedStep === null) return { confirmed: false as const };

  const now = databaseNow();
  const recoveryCodes = await replaceUserTotpRecoveryCodes(tx, input.userId);
  await tx.user_totp_credentials.update({
    where: { credential_id: credential.credential_id },
    data: {
      enabled: 1,
      verified_at: now,
      last_used_step: matchedStep,
      failed_count: 0,
      locked_until: null,
      updated_at: now,
    },
  });
  const currentUser = await tx.users.findUniqueOrThrow({ where: { user_id: input.userId } });
  const nextCredentialRevision = currentUser.credential_revision + 1;
  const user = await tx.users.update({
    where: { user_id: input.userId },
    data: {
      revision: { increment: 1 },
      credential_revision: nextCredentialRevision,
      updated_at: now,
    },
  });
  const replacement = await replaceUserSessionsInTransaction(tx, {
    userId: input.userId,
    credentialRevision: nextCredentialRevision,
    instanceEpoch,
  });
  return { confirmed: true as const, recoveryCodes, token: replacement.token, revision: user.revision };
}

export async function confirmTotpEnrollment(
  userId: number,
  code: string,
  token: string,
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    const state = await lockServerSecurityState(tx);
    await lockUser(tx, userId);
    return confirmEnrollment(tx, { userId, code, enrollmentToken: token }, state.instance_epoch, keyAccess);
  });
}

export async function confirmTotpEnrollmentForSession(input: {
  sessionId: number;
  userId: number;
  code: string;
  enrollmentToken: string;
}, keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    const state = await lockServerSecurityState(tx);
    await lockUser(tx, input.userId);
    await requireCurrentSession(tx, input, state.instance_epoch);
    return confirmEnrollment(tx, input, state.instance_epoch, keyAccess);
  });
}

type TotpVerificationResult = {
  enabled: boolean;
  verified: boolean;
  locked: boolean;
  remainingLockedSeconds: number;
  lockedUntil?: Date | null;
  failedCount?: number;
  remainingAttempts?: number;
  reusedSameStep?: boolean;
  usedRecoveryCode?: boolean;
  credentialId?: number;
};

export async function verifyUserTotpCodeInTransaction(
  tx: Prisma.TransactionClient,
  userId: number,
  code: string,
  options: { allowSameStepReuse?: boolean } = {},
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
): Promise<TotpVerificationResult> {
  const credential = await tx.user_totp_credentials.findUnique({ where: { user_id: userId } });
  if (!credential || credential.enabled !== 1) {
    return { enabled: false, verified: false, locked: false, remainingLockedSeconds: 0 };
  }
  const remainingLockedSeconds = lockedSecondsUntil(credential.locked_until);
  if (remainingLockedSeconds > 0) {
    return {
      enabled: true,
      verified: false,
      locked: true,
      remainingLockedSeconds,
      lockedUntil: credential.locked_until,
      credentialId: credential.credential_id,
    };
  }

  const normalizedRecovery = normalizeRecoveryCode(code);
  if (normalizedRecovery.length >= 8) {
    const recovery = await tx.user_totp_recovery_codes.updateMany({
      where: { user_id: userId, code_hash: recoveryCodeHash(normalizedRecovery), used_at: null },
      data: { used_at: databaseNow() },
    });
    if (recovery.count === 1) {
      await tx.user_totp_credentials.update({
        where: { credential_id: credential.credential_id },
        data: { failed_count: 0, locked_until: null, updated_at: databaseNow() },
      });
      return {
        enabled: true,
        verified: true,
        locked: false,
        remainingLockedSeconds: 0,
        usedRecoveryCode: true,
        credentialId: credential.credential_id,
      };
    }
  }

  const matchedStep = matchingTotpStep(await decryptSecret(credential, keyAccess), code);
  const reusedSameStep = matchedStep !== null && matchedStep === credential.last_used_step;
  const reusedOlderStep = matchedStep !== null && credential.last_used_step !== null && matchedStep < credential.last_used_step;
  if (matchedStep === null || reusedOlderStep || (reusedSameStep && !options.allowSameStepReuse)) {
    const nextFailedCount = credential.failed_count + 1;
    const shouldLock = nextFailedCount >= TOTP_MAX_FAILED_ATTEMPTS;
    const lockedUntil = shouldLock ? addSeconds(databaseNow(), TOTP_LOCK_SECONDS) : null;
    await tx.user_totp_credentials.update({
      where: { credential_id: credential.credential_id },
      data: { failed_count: nextFailedCount, locked_until: lockedUntil, updated_at: databaseNow() },
    });
    return {
      enabled: true,
      verified: false,
      locked: shouldLock,
      remainingLockedSeconds: shouldLock ? TOTP_LOCK_SECONDS : 0,
      lockedUntil,
      failedCount: nextFailedCount,
      remainingAttempts: shouldLock ? 0 : Math.max(0, TOTP_MAX_FAILED_ATTEMPTS - nextFailedCount),
      credentialId: credential.credential_id,
    };
  }
  await tx.user_totp_credentials.update({
    where: { credential_id: credential.credential_id },
    data: { last_used_step: matchedStep, failed_count: 0, locked_until: null, updated_at: databaseNow() },
  });
  return {
    enabled: true,
    verified: true,
    locked: false,
    remainingLockedSeconds: 0,
    reusedSameStep,
    credentialId: credential.credential_id,
  };
}

export async function verifyUserTotpCode(
  userId: number,
  code: string,
  options: { allowSameStepReuse?: boolean } = {},
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    await lockServerSecurityState(tx);
    await lockUser(tx, userId);
    return verifyUserTotpCodeInTransaction(tx, userId, code, options, keyAccess);
  });
}

export async function verifySensitiveSession(input: {
  sessionToken: string;
  code: string;
  sensitiveAction: SensitiveAction;
}, keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    const state = await lockServerSecurityState(tx);
    const observed = await tx.user_sessions.findUnique({
      where: { session_token_hash: hashSessionToken(input.sessionToken) },
      select: { session_id: true, user_id: true },
    });
    if (!observed) throw publicConflict("ACCOUNT_SECURITY_CHANGED", "다시 로그인하세요.");
    await lockUser(tx, observed.user_id);
    const { session, user } = await requireCurrentSession(
      tx,
      { sessionId: observed.session_id, userId: observed.user_id },
      state.instance_epoch
    );
    if (!isRole(user.role) || !canUseSensitiveAction(user.role, input.sensitiveAction)) {
      throw publicForbidden("SENSITIVE_ACTION_FORBIDDEN", "민감 작업을 인증할 권한이 없습니다.");
    }
    const verification = await verifyUserTotpCodeInTransaction(
      tx,
      user.user_id,
      input.code,
      { allowSameStepReuse: true },
      keyAccess
    );
    if (!verification.verified || !verification.credentialId) return { verification, user };
    const verifiedUntil = addSeconds(databaseNow(), SENSITIVE_AUTH_MAX_AGE_SECONDS);
    await tx.user_sensitive_auth_grants.upsert({
      where: {
        session_id_sensitive_action: {
          session_id: session.session_id,
          sensitive_action: input.sensitiveAction,
        },
      },
      create: {
        session_id: session.session_id,
        sensitive_action: input.sensitiveAction,
        verified_until: verifiedUntil,
        credential_revision: user.credential_revision,
        totp_credential_id: verification.credentialId,
        created_at: databaseNow(),
        updated_at: databaseNow(),
      },
      update: {
        verified_until: verifiedUntil,
        credential_revision: user.credential_revision,
        totp_credential_id: verification.credentialId,
        updated_at: databaseNow(),
      },
    });
    return { verification, user, verifiedUntil };
  });
}

export async function manageUserTotpForSession(input: {
  sessionId: number;
  userId: number;
  passwordHash: string;
  password: string;
  code: string;
  action: "recoveryCodes" | "disable";
}, keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess) {
  await keyAccess.requireReady();
  if (!(await verifyPassword(input.password, input.passwordHash))) {
    throw publicConflict("CURRENT_PASSWORD_INVALID", "현재 비밀번호가 올바르지 않습니다.");
  }
  return prisma.$transaction(async (tx) => {
    const state = await lockServerSecurityState(tx);
    await lockUser(tx, input.userId);
    const { user } = await requireCurrentSession(tx, input, state.instance_epoch);
    if (user.password_hash !== input.passwordHash) {
      throw publicConflict("ACCOUNT_SECURITY_CHANGED", "계정 보안 상태가 변경되었습니다. 다시 로그인하세요.");
    }
    const verification = await verifyUserTotpCodeInTransaction(tx, input.userId, input.code, {}, keyAccess);
    if (!verification.verified) return { verification, token: null, recoveryCodes: [] as string[] };

    const recoveryCodes =
      input.action === "recoveryCodes"
        ? await replaceUserTotpRecoveryCodes(tx, input.userId)
        : [];
    if (input.action === "disable") {
      await tx.user_totp_recovery_codes.deleteMany({ where: { user_id: input.userId } });
      await tx.user_totp_credentials.deleteMany({ where: { user_id: input.userId } });
    }
    const nextCredentialRevision = user.credential_revision + 1;
    await tx.users.update({
      where: { user_id: input.userId },
      data: {
        revision: { increment: 1 },
        credential_revision: nextCredentialRevision,
        updated_at: databaseNow(),
      },
    });
    const replacement = await replaceUserSessionsInTransaction(tx, {
      userId: input.userId,
      credentialRevision: nextCredentialRevision,
      instanceEpoch: state.instance_epoch,
    });
    return { verification, token: replacement.token, recoveryCodes };
  });
}

export async function resetUserTotpState(tx: Prisma.TransactionClient, userId: number) {
  await tx.user_totp_recovery_codes.deleteMany({ where: { user_id: userId } });
  await tx.user_totp_credentials.deleteMany({ where: { user_id: userId } });
  await tx.user_sessions.deleteMany({ where: { user_id: userId } });
}

export async function resetUserTotp(userId: number) {
  await prisma.$transaction((tx) => resetUserTotpState(tx, userId));
}

export async function disableUserTotp(userId: number) {
  await prisma.$transaction(async (tx) => {
    await lockServerSecurityState(tx);
    const user = await lockUser(tx, userId);
    await resetUserTotpState(tx, userId);
    if (user) {
      await tx.users.update({
        where: { user_id: userId },
        data: { revision: { increment: 1 }, credential_revision: { increment: 1 }, updated_at: databaseNow() },
      });
    }
  });
}

export async function generateUserTotpRecoveryCodes(
  userId: number,
  count = DEFAULT_RECOVERY_CODE_COUNT,
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    await lockServerSecurityState(tx);
    await lockUser(tx, userId);
    return replaceUserTotpRecoveryCodes(tx, userId, count);
  });
}

export async function verifyUserTotpRecoveryCode(
  userId: number,
  code: string,
  keyAccess: TotpServiceKeyAccess = serverTotpKeyAccess
) {
  await keyAccess.requireReady();
  return prisma.$transaction(async (tx) => {
    await lockServerSecurityState(tx);
    await lockUser(tx, userId);
    const result = await verifyUserTotpCodeInTransaction(tx, userId, code, {}, keyAccess);
    return Boolean(result.verified && result.usedRecoveryCode);
  });
}

export function createTotpService(keyAccess: TotpServiceKeyAccess) {
  return {
    getTotpServerStatus: () => getTotpServerStatus(keyAccess),
    requireTotpKeyReady: () => requireTotpKeyReady(keyAccess),
    getUserTotpStatus: (userId: number) => getUserTotpStatus(userId, keyAccess),
    createTotpEnrollment: (userId: number, username: string) => createTotpEnrollment(userId, username, keyAccess),
    createTotpEnrollmentForSession: (input: Parameters<typeof createTotpEnrollmentForSession>[0]) =>
      createTotpEnrollmentForSession(input, keyAccess),
    confirmTotpEnrollment: (userId: number, code: string, token: string) =>
      confirmTotpEnrollment(userId, code, token, keyAccess),
    confirmTotpEnrollmentForSession: (input: Parameters<typeof confirmTotpEnrollmentForSession>[0]) =>
      confirmTotpEnrollmentForSession(input, keyAccess),
    verifyUserTotpCode: (userId: number, code: string, options: { allowSameStepReuse?: boolean } = {}) =>
      verifyUserTotpCode(userId, code, options, keyAccess),
    verifySensitiveSession: (input: Parameters<typeof verifySensitiveSession>[0]) =>
      verifySensitiveSession(input, keyAccess),
    manageUserTotpForSession: (input: Parameters<typeof manageUserTotpForSession>[0]) =>
      manageUserTotpForSession(input, keyAccess),
    generateUserTotpRecoveryCodes: (userId: number, count = DEFAULT_RECOVERY_CODE_COUNT) =>
      generateUserTotpRecoveryCodes(userId, count, keyAccess),
    verifyUserTotpRecoveryCode: (userId: number, code: string) =>
      verifyUserTotpRecoveryCode(userId, code, keyAccess),
  };
}
