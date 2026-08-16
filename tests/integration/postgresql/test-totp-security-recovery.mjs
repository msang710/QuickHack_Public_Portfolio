import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-totp-security-recovery-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    createTotpSecurityRecoveryService,
    TOTP_SECURITY_RESET_CONFIRM_TEXT,
  } = await import(
    "@/quickhack_server/admin/totp-security-recovery-service"
  );
  const timestamp = new Date("2026-08-04T14:00:00+09:00");
  const expiresAt = new Date("2099-01-01T00:00:00+09:00");
  const affectedUser = await prisma.users.create({
    data: {
      username: "totp-security-affected",
      password_hash: "not-used",
      role: "LEADER",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const unaffectedUser = await prisma.users.create({
    data: {
      username: "totp-security-unaffected",
      password_hash: "not-used",
      role: "STAFF",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  await prisma.user_totp_credentials.create({
    data: {
      user_id: affectedUser.user_id,
      secret_ciphertext: "unavailable",
      secret_iv: "unavailable",
      secret_auth_tag: "unavailable",
      enabled: 1,
      verified_at: timestamp,
      failed_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.user_totp_recovery_codes.createMany({
    data: ["recovery-one", "recovery-two"].map((code_hash) => ({
      user_id: affectedUser.user_id,
      code_hash,
      created_at: timestamp,
    })),
  });
  await prisma.user_sessions.createMany({
    data: [
      {
        user_id: affectedUser.user_id,
        session_token_hash: "affected-session",
        expires_at: expiresAt,
        credential_revision: affectedUser.credential_revision,
        instance_epoch: 1,
        created_at: timestamp,
      },
      {
        user_id: unaffectedUser.user_id,
        session_token_hash: "unaffected-session",
        expires_at: expiresAt,
        credential_revision: unaffectedUser.credential_revision,
        instance_epoch: 1,
        created_at: timestamp,
      },
    ],
  });

  let keyStatus = {
    state: "CREDENTIALS_REQUIRE_EXISTING_KEY",
    configured: false,
    protection: null,
  };
  let backupCount = 0;
  const service = createTotpSecurityRecoveryService({
    prismaClient: prisma,
    getKeyStatus: async () => keyStatus,
    recoverKeyAfterCredentialsCleared: async () => {
      keyStatus = {
        state: "READY",
        configured: true,
        protection: "WINDOWS_DPAPI_CURRENT_USER",
      };
      return keyStatus;
    },
    runSafetyBackup: async () => {
      backupCount += 1;
    },
  });

  const initial = await service.readState();
  assert.equal(initial.credentialCount, 1);
  assert.equal(initial.enabledCredentialCount, 1);
  assert.equal(initial.recoveryCodeCount, 2);
  assert.equal(initial.affectedSessionCount, 1);
  assert.equal(initial.recovery.allowed, true);
  assert.equal(initial.recovery.requiresReset, true);

  await assert.rejects(
    () => service.recover({ confirmText: "wrong" }),
    (error) =>
      error?.code === "TOTP_SECURITY_RESET_CONFIRMATION_REQUIRED" &&
      error?.statusCode === 400
  );
  assert.equal(backupCount, 0);
  assert.equal(await prisma.user_totp_credentials.count(), 1);

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_system_totp_security_audit_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = 'SYSTEM_TOTP_SECURITY_RESET' THEN
        RAISE EXCEPTION 'forced audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER fail_system_totp_security_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_system_totp_security_audit_fn()
  `);
  await assert.rejects(() =>
    service.recover({ confirmText: TOTP_SECURITY_RESET_CONFIRM_TEXT })
  );
  assert.equal(backupCount, 1);
  assert.equal(
    await prisma.user_totp_credentials.count(),
    1,
    "Credential deletion survived an audit failure."
  );
  assert.equal(
    await prisma.user_totp_recovery_codes.count(),
    2,
    "Recovery-code deletion survived an audit failure."
  );
  assert.equal(
    await prisma.user_sessions.count({
      where: { user_id: affectedUser.user_id },
    }),
    1,
    "Session deletion survived an audit failure."
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER IF EXISTS fail_system_totp_security_audit ON employee_activity_logs"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_system_totp_security_audit_fn()"
  );

  const recovered = await service.recover({
    confirmText: TOTP_SECURITY_RESET_CONFIRM_TEXT,
  });
  assert.equal(backupCount, 2);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.backupCreated, true);
  assert.deepEqual(recovered.reset, {
    credentialCount: 1,
    enabledCredentialCount: 1,
    recoveryCodeCount: 2,
    invalidatedSessionCount: 1,
  });
  assert.equal(await prisma.user_totp_credentials.count(), 0);
  assert.equal(await prisma.user_totp_recovery_codes.count(), 0);
  assert.equal(
    await prisma.user_sessions.count({
      where: { user_id: affectedUser.user_id },
    }),
    0
  );
  assert.equal(
    await prisma.user_sessions.count({
      where: { user_id: unaffectedUser.user_id },
    }),
    1,
    "A user without OTP credentials was logged out."
  );
  const audit = await prisma.employee_activity_logs.findFirstOrThrow({
    where: { action_type: "SYSTEM_TOTP_SECURITY_RESET" },
  });
  assert.equal(audit.user_id, null);
  assert.equal(audit.target_type, "SECURITY");
  assert.equal(audit.target_id, "TOTP_MASTER_KEY");
  assert.equal(audit.result, "SUCCESS");

  const readyService = createTotpSecurityRecoveryService({
    prismaClient: prisma,
    getKeyStatus: async () => keyStatus,
    recoverKeyAfterCredentialsCleared: async () => keyStatus,
    runSafetyBackup: async () => {
      throw new Error("A READY service must not create a safety backup.");
    },
  });
  await assert.rejects(
    () => readyService.recover({ confirmText: TOTP_SECURITY_RESET_CONFIRM_TEXT }),
    (error) => error?.code === "TOTP_SECURITY_ALREADY_READY"
  );

  process.env.QUICKHACK_RUNTIME_ROLE = "server";
  process.env.QUICKHACK_SUPERVISOR_TOKEN = "totp-security-supervisor-token";
  const { createTotpSecurityRouteHandlers } = await import(
    "@/quickhack_server/admin/totp-security-route-handlers"
  );
  const route = createTotpSecurityRouteHandlers({
    readState: () => readyService.readState(),
    recover: (input) => readyService.recover(input),
  });
  const supervisorRequest = (token) =>
    new NextRequest(
      "http://127.0.0.1:3000/api/internal/supervisor/totp-security",
      {
        headers: token
          ? { "X-QuickHack-Supervisor-Token": token }
          : {},
      }
    );
  const unauthorized = await route.GET(supervisorRequest("wrong-token"));
  assert.equal(unauthorized.status, 403);
  process.env.QUICKHACK_RUNTIME_ROLE = "client";
  const clientRuntime = await route.GET(
    supervisorRequest(process.env.QUICKHACK_SUPERVISOR_TOKEN)
  );
  assert.equal(clientRuntime.status, 404);
  process.env.QUICKHACK_RUNTIME_ROLE = "server";
  const authorized = await route.GET(
    supervisorRequest(process.env.QUICKHACK_SUPERVISOR_TOKEN)
  );
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).state.key.configured, true);

  console.log(
    "TOTP safety backup gate, transactional reset, session scope, audit, supervisor isolation, and READY-state refusal verified."
  );
} finally {
  await prisma?.$disconnect().catch(() => undefined);
  temporaryDatabase.cleanup();
}
