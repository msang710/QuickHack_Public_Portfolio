import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server.js";

import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { createDeterministicTotpService } from "../../support/deterministic-totp-service.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-totp-state-atomicity-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;

function base32Decode(value) {
  let bits = 0;
  let current = 0;
  const output = [];

  for (const char of value.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    current = (current << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;

    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

function totpCodeAtStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto
    .createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);

  return String(binary % 1_000_000).padStart(6, "0");
}

function currentTotpCode(secret) {
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  return totpCodeAtStep(secret, step);
}

function invalidTotpCode(secret) {
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const validWindow = new Set([
    totpCodeAtStep(secret, step - 1),
    totpCodeAtStep(secret, step),
    totpCodeAtStep(secret, step + 1),
  ]);

  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const code = String(candidate).padStart(6, "0");

    if (!validWindow.has(code)) {
      return code;
    }
  }

  throw new Error("Could not find an invalid TOTP fixture code.");
}

function request(path, token, body) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie: `quickhack_session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function createUser(prisma, hashPassword, input) {
  const now = new Date("2026-07-31T12:00:00+09:00");
  const user = await prisma.users.create({
    data: {
      username: input.username,
      password_hash: await hashPassword(input.password),
      role: input.role,
      is_active: 1,
      created_at: now,
      updated_at: now,
    },
  });
  await prisma.employee_profiles.create({
    data: {
      user_id: user.user_id,
      display_name: input.username,
      created_at: now,
      updated_at: now,
    },
  });

  return user;
}

async function createFailingAuditTrigger(prisma, name, actionType) {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION ${name}_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = '${actionType}' THEN
        RAISE EXCEPTION 'forced audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER ${name}
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION ${name}_fn()
  `);
}

async function dropTrigger(prisma, name) {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${name} ON employee_activity_logs`
  );
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}_fn()`);
}

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { hashPassword } = await import("@/quickhack_server/core/password");
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const { SENSITIVE_ACTIONS } = await import(
    "@/quickhack_shared/auth/sensitive-auth"
  );
  const totpModule = await import(
    "@/quickhack_server/auth/totp-service"
  );
  const totpService = createDeterministicTotpService(totpModule);
  const adminUsersModule = await import(
    "@/quickhack_server/api/admin/users"
  );
  const adminUsersApi = {
    ...adminUsersModule,
    POST: adminUsersModule.createAdminUsersPostHandler({
      loadTotpService: async () => ({
        replaceUserTotpRecoveryCodes:
          totpService.replaceUserTotpRecoveryCodes,
        requireTotpKeyReady: totpService.requireTotpKeyReady,
        resetUserTotpState: totpService.resetUserTotpState,
      }),
    }),
  };

  const leader = await createUser(prisma, hashPassword, {
    username: "totp-atomicity-leader",
    password: "Leader!234",
    role: "LEADER",
  });
  const target = await createUser(prisma, hashPassword, {
    username: "totp-atomicity-target",
    password: "Target!234",
    role: "STAFF",
  });
  const enrollment = await totpService.createTotpEnrollment(
    target.user_id,
    target.username
  );
  const enrollmentCode = currentTotpCode(enrollment.secret);
  const confirmation = await totpService.confirmTotpEnrollment(
    target.user_id,
    enrollmentCode,
    enrollment.enrollmentToken
  );
  assert.equal(confirmation.confirmed, true);

  const recoveryCodes =
    await totpService.generateUserTotpRecoveryCodes(target.user_id);
  const recoveryResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      totpService.verifyUserTotpRecoveryCode(
        target.user_id,
        recoveryCodes[0]
      )
    )
  );
  assert.equal(
    recoveryResults.filter(Boolean).length,
    1,
    "A recovery code was consumed more than once."
  );

  const invalidCode = invalidTotpCode(enrollment.secret);
  const failureResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      totpService.verifyUserTotpCode(target.user_id, invalidCode)
    )
  );
  const lockedCredential =
    await prisma.user_totp_credentials.findUniqueOrThrow({
      where: { user_id: target.user_id },
    });
  assert.equal(lockedCredential.failed_count, 5);
  assert.ok(lockedCredential.locked_until);
  assert.equal(
    failureResults.some((result) => result.locked),
    true,
    "The fifth parallel TOTP failure did not lock the credential."
  );

  await prisma.user_totp_credentials.update({
    where: { user_id: target.user_id },
    data: {
      last_used_step: null,
      failed_count: 0,
      locked_until: null,
    },
  });
  const sameStepResults = await Promise.all([
    totpService.verifyUserTotpCode(target.user_id, enrollmentCode),
    totpService.verifyUserTotpCode(target.user_id, enrollmentCode),
  ]);
  assert.equal(
    sameStepResults.filter((result) => result.verified).length,
    1,
    "The same TOTP step succeeded more than once without reuse permission."
  );
  const allowedReuseResults = await Promise.all([
    totpService.verifyUserTotpCode(target.user_id, enrollmentCode, {
      allowSameStepReuse: true,
    }),
    totpService.verifyUserTotpCode(target.user_id, enrollmentCode, {
      allowSameStepReuse: true,
    }),
  ]);
  assert.equal(
    allowedReuseResults.filter((result) => result.verified).length,
    2,
    "Explicit same-step reuse no longer works."
  );

  const leaderEnrollment = await totpService.createTotpEnrollment(
    leader.user_id,
    leader.username
  );
  const leaderCode = currentTotpCode(leaderEnrollment.secret);
  const leaderConfirmation = await totpService.confirmTotpEnrollment(
    leader.user_id,
    leaderCode,
    leaderEnrollment.enrollmentToken
  );
  assert.equal(leaderConfirmation.confirmed, true);
  const leaderToken = await authService.createUserSession(leader.user_id);
  const sensitiveGrant = await totpService.verifySensitiveSession({
    sessionToken: leaderToken,
    code: leaderCode,
    sensitiveAction: SENSITIVE_ACTIONS.accountManagement,
  });
  assert.equal(sensitiveGrant.verification.verified, true);
  await totpService.generateUserTotpRecoveryCodes(target.user_id);
  const recoveryRowsBeforeRollback =
    await prisma.user_totp_recovery_codes.findMany({
      where: { user_id: target.user_id },
      select: { code_hash: true, used_at: true },
      orderBy: { code_hash: "asc" },
    });

  const recoveryTrigger = "fail_totp_recovery_audit";
  await createFailingAuditTrigger(
    prisma,
    recoveryTrigger,
    "USER_TOTP_RECOVERY_CODES_GENERATE"
  );
  const failedRecoveryResponse = await adminUsersApi.POST(
    request("/api/admin/users", leaderToken, {
      action: "generateRecoveryCodes",
      userId: target.user_id,
      expectedRevision: (
        await prisma.users.findUniqueOrThrow({ where: { user_id: target.user_id } })
      ).revision,
    })
  );
  assert.equal(failedRecoveryResponse.status, 500);
  const failedRecoveryBody = await failedRecoveryResponse.json();
  assert.equal(failedRecoveryBody.code, "INTERNAL_ERROR");
  assert.match(failedRecoveryBody.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(
    "recoveryCodes" in failedRecoveryBody,
    false,
    "Recovery code plaintext escaped a rolled back transaction."
  );
  assert.deepEqual(
    await prisma.user_totp_recovery_codes.findMany({
      where: { user_id: target.user_id },
      select: { code_hash: true, used_at: true },
      orderBy: { code_hash: "asc" },
    }),
    recoveryRowsBeforeRollback,
    "Recovery code replacement survived an audit failure."
  );
  await dropTrigger(prisma, recoveryTrigger);

  const successfulRecoveryResponse = await adminUsersApi.POST(
    request("/api/admin/users", leaderToken, {
      action: "generateRecoveryCodes",
      userId: target.user_id,
      expectedRevision: (
        await prisma.users.findUniqueOrThrow({ where: { user_id: target.user_id } })
      ).revision,
    })
  );
  assert.equal(successfulRecoveryResponse.status, 200);
  assert.equal(
    (await successfulRecoveryResponse.json()).recoveryCodes.length,
    10
  );
  const resetTargetToken = await authService.createUserSession(target.user_id);

  const resetTrigger = "fail_totp_reset_audit";
  await createFailingAuditTrigger(
    prisma,
    resetTrigger,
    "USER_TOTP_RESET"
  );
  const failedResetResponse = await adminUsersApi.POST(
    request("/api/admin/users", leaderToken, {
      action: "resetTotp",
      userId: target.user_id,
      expectedRevision: (
        await prisma.users.findUniqueOrThrow({ where: { user_id: target.user_id } })
      ).revision,
    })
  );
  assert.equal(failedResetResponse.status, 500);
  const failedResetBody = await failedResetResponse.json();
  assert.equal(failedResetBody.code, "INTERNAL_ERROR");
  assert.match(failedResetBody.traceId, /^[0-9a-f-]{36}$/);
  assert.ok(
    await prisma.user_totp_credentials.findUnique({
      where: { user_id: target.user_id },
    }),
    "TOTP credential deletion survived an audit failure."
  );
  assert.ok(
    await prisma.user_sessions.findUnique({
      where: {
        session_token_hash: authService.hashSessionToken(resetTargetToken),
      },
    }),
    "Session deletion survived an audit failure."
  );
  await dropTrigger(prisma, resetTrigger);

  const successfulResetResponse = await adminUsersApi.POST(
    request("/api/admin/users", leaderToken, {
      action: "resetTotp",
      userId: target.user_id,
      expectedRevision: (
        await prisma.users.findUniqueOrThrow({ where: { user_id: target.user_id } })
      ).revision,
    })
  );
  assert.equal(successfulResetResponse.status, 200);
  assert.equal(
    await prisma.user_totp_credentials.findUnique({
      where: { user_id: target.user_id },
    }),
    null
  );
  assert.equal(
    await prisma.user_sessions.count({
      where: { user_id: target.user_id },
    }),
    0
  );

  console.log(
    "TOTP recovery claim, failure CAS, and admin audit rollback verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
