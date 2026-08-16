import { isIP } from "node:net";
import type { Prisma } from "@/generated/prisma/client";
import type { prisma as PrismaService } from "@/quickhack_server/core/prisma";
import { normalizeAccountUsername } from "@/quickhack_shared/auth/account-username";
import { addSeconds, quickHackClock } from "@/quickhack_shared/core/time";

export const LOGIN_ATTEMPT_WINDOW_SECONDS = 5 * 60;
export const LOGIN_BLOCK_SECONDS = 10 * 60;
export const LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const LOGIN_CLIENT_MAX_FAILED_ATTEMPTS = 20;
const LOGIN_ATTEMPT_CLEANUP_LIMIT = 32;

type PrismaServiceClient = typeof PrismaService;
type HeaderSource = Pick<Headers, "get">;

export type LoginAttemptIdentity = {
  credentialAttemptKey: string;
  clientAttemptKey: string;
  ipAddress: string;
  username: string;
};

type LoginVerification<T> = {
  succeeded: boolean;
  value: T | null;
};

export type LoginAttemptResult<T> =
  | { status: "BLOCKED"; remainingSeconds: number; value: null }
  | { status: "FAILED"; remainingSeconds: 0; value: null }
  | { status: "SUCCEEDED"; remainingSeconds: 0; value: T };

type AttemptRow = {
  blocked_until: Date | null;
};

export class InvalidTrustedClientAddressError extends Error {
  readonly code = "INVALID_TRUSTED_CLIENT_ADDRESS";

  constructor() {
    super("The trusted client address is invalid.");
    this.name = "InvalidTrustedClientAddressError";
  }
}

function normalizeTrustedClientAddress(value: string) {
  const address = value.trim().toLowerCase();
  const mappedIpv4 = address.startsWith("::ffff:") ? address.slice(7) : "";

  if (mappedIpv4 && isIP(mappedIpv4) === 4) {
    return mappedIpv4;
  }

  if (!address || address.includes(",") || isIP(address) === 0) {
    throw new InvalidTrustedClientAddressError();
  }

  return address;
}

export function trustedClientAddress(headers: HeaderSource) {
  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor === null ? "local" : normalizeTrustedClientAddress(forwardedFor);
}

export function loginAttemptIdentity(
  headers: HeaderSource,
  username: string
): LoginAttemptIdentity {
  const canonicalUsername = normalizeAccountUsername(username);
  const ipAddress = trustedClientAddress(headers);

  return {
    credentialAttemptKey: `credential:${ipAddress}:${canonicalUsername}`,
    clientAttemptKey: `client:${ipAddress}`,
    ipAddress,
    username: canonicalUsername,
  };
}

function remainingBlockedSeconds(rows: AttemptRow[], now: Date) {
  return rows.reduce((maximum, row) => {
    if (!row.blocked_until || row.blocked_until <= now) {
      return maximum;
    }
    return Math.max(
      maximum,
      Math.ceil((row.blocked_until.getTime() - now.getTime()) / 1000)
    );
  }, 0);
}

async function updateFailureBucket(
  tx: Prisma.TransactionClient,
  input: {
    attemptKey: string;
    username: string;
    ipAddress: string;
    maximumFailures: number;
    now: Date;
  }
) {
  const current = await tx.login_attempts.findUnique({
    where: { attempt_key: input.attemptKey },
  });
  const windowStart = addSeconds(input.now, -LOGIN_ATTEMPT_WINDOW_SECONDS);
  const shouldReset =
    !current ||
    current.first_attempt_at <= windowStart ||
    Boolean(current.blocked_until && current.blocked_until <= input.now);
  const failedCount = shouldReset
    ? 1
    : Math.min(input.maximumFailures, current.failed_count + 1);
  const blockedUntil =
    failedCount >= input.maximumFailures
      ? addSeconds(input.now, LOGIN_BLOCK_SECONDS)
      : null;

  return tx.login_attempts.upsert({
    where: { attempt_key: input.attemptKey },
    create: {
      attempt_key: input.attemptKey,
      username: input.username,
      ip_address: input.ipAddress,
      failed_count: failedCount,
      first_attempt_at: input.now,
      blocked_until: blockedUntil,
      updated_at: input.now,
      version: 0,
    },
    update: {
      username: input.username,
      ip_address: input.ipAddress,
      failed_count: failedCount,
      first_attempt_at: shouldReset ? input.now : current?.first_attempt_at,
      blocked_until: blockedUntil,
      updated_at: input.now,
      version: { increment: 1 },
    },
  });
}

async function cleanupExpiredClientAttempts(
  tx: Prisma.TransactionClient,
  identity: LoginAttemptIdentity,
  now: Date
) {
  const staleBefore = addSeconds(
    now,
    -(LOGIN_ATTEMPT_WINDOW_SECONDS + LOGIN_BLOCK_SECONDS)
  );
  await tx.$executeRaw`
    DELETE FROM login_attempts
    WHERE attempt_key IN (
      SELECT attempt_key
      FROM login_attempts
      WHERE ip_address = ${identity.ipAddress}
        AND attempt_key <> ${identity.credentialAttemptKey}
        AND attempt_key <> ${identity.clientAttemptKey}
        AND updated_at <= ${staleBefore}
      ORDER BY updated_at ASC, attempt_key ASC
      LIMIT ${LOGIN_ATTEMPT_CLEANUP_LIMIT}
    )
  `;
}

export async function executeLoginAttempt<T>(
  prisma: PrismaServiceClient,
  identity: LoginAttemptIdentity,
  verify: (tx: Prisma.TransactionClient) => Promise<LoginVerification<T>>,
  now = quickHackClock.nowDate()
): Promise<LoginAttemptResult<T>> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${identity.clientAttemptKey}, 0)
        )
      `;

      const attempts = await tx.login_attempts.findMany({
        where: {
          attempt_key: {
            in: [identity.credentialAttemptKey, identity.clientAttemptKey],
          },
        },
        select: { blocked_until: true },
      });
      const blockedSeconds = remainingBlockedSeconds(attempts, now);
      if (blockedSeconds > 0) {
        return { status: "BLOCKED", remainingSeconds: blockedSeconds, value: null };
      }

      await cleanupExpiredClientAttempts(tx, identity, now);
      const verification = await verify(tx);
      if (verification.succeeded && verification.value !== null) {
        await tx.login_attempts.deleteMany({
          where: { attempt_key: identity.credentialAttemptKey },
        });
        return {
          status: "SUCCEEDED",
          remainingSeconds: 0,
          value: verification.value,
        };
      }

      await updateFailureBucket(tx, {
        attemptKey: identity.credentialAttemptKey,
        username: identity.username,
        ipAddress: identity.ipAddress,
        maximumFailures: LOGIN_MAX_FAILED_ATTEMPTS,
        now,
      });
      await updateFailureBucket(tx, {
        attemptKey: identity.clientAttemptKey,
        username: "*",
        ipAddress: identity.ipAddress,
        maximumFailures: LOGIN_CLIENT_MAX_FAILED_ATTEMPTS,
        now,
      });
      return { status: "FAILED", remainingSeconds: 0, value: null };
    },
    { maxWait: 30_000, timeout: 30_000 }
  );
}
