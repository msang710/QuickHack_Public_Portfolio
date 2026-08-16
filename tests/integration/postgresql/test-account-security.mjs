import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import pg from "pg";

import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { createRandomTestAccount } from "../../support/random-test-account.mjs";

const { Pool } = pg;

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-account-security-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function request(path, token, body) {
  const headers = {};

  if (token) {
    headers.cookie = `quickhack_session=${token}`;
  }

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function responseSessionToken(response) {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/quickhack_session=([^;]+)/);
  assert.ok(match, `Missing session cookie: ${setCookie}`);
  return match[1];
}

async function createUser(input) {
  const timestamp = new Date("2026-07-30T12:00:00+09:00");
  const { hashPassword } = await import(
    "@/quickhack_server/core/password"
  );
  const user = await prisma.users.create({
    data: {
      username: input.username,
      password_hash: await hashPassword(input.password),
      must_change_password: input.mustChangePassword ? 1 : 0,
      role: input.role ?? "STAFF",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.employee_profiles.create({
    data: {
      user_id: user.user_id,
      display_name: input.displayName ?? input.username,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  return user;
}

function adminUserBody(user, tempPassword) {
  return {
    action: "saveUser",
    userId: user.user_id,
    expectedRevision: user.revision,
    username: user.username,
    displayName: user.employee_profiles.display_name,
    phone: "",
    email: "",
    birthDate: "",
    hireDate: "",
    role: user.role,
    isDeveloper: user.is_developer === 1,
    mobilePackingEnabled: user.mobile_packing_enabled === 1,
    isActive: user.is_active === 1,
    tempPassword,
  };
}

async function grantSensitive(authService, token, user, credential, action) {
  const session = await prisma.user_sessions.findUniqueOrThrow({
    where: { session_token_hash: authService.hashSessionToken(token) },
  });
  await prisma.user_sensitive_auth_grants.upsert({
    where: {
      session_id_sensitive_action: {
        session_id: session.session_id,
        sensitive_action: action,
      },
    },
    create: {
      session_id: session.session_id,
      sensitive_action: action,
      verified_until: new Date("2099-01-01T00:00:00+09:00"),
      credential_revision: user.credential_revision,
      totp_credential_id: credential.credential_id,
    },
    update: {
      verified_until: new Date("2099-01-01T00:00:00+09:00"),
      credential_revision: user.credential_revision,
      totp_credential_id: credential.credential_id,
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const { SENSITIVE_ACTIONS } = await import(
    "@/quickhack_shared/auth/sensitive-auth"
  );
  const { verifyPassword } = await import(
    "@/quickhack_server/core/password"
  );
  const adminUsersApi = await import(
    "@/quickhack_server/api/admin/users"
  );
  const adminMobileApi = await import(
    "@/quickhack_server/api/admin/mobile-devices"
  );
  const loginApi = await import("@/quickhack_server/api/auth/login");
  const meApi = await import("@/quickhack_server/api/auth/me");
  const totpApi = await import("@/quickhack_server/api/auth/totp");
  const passwordApi = await import(
    "@/quickhack_server/api/auth/password"
  );
  const deviceListApi = await import(
    "@/quickhack_server/api/inventory/device-list"
  );

  const leader = await createUser({
    username: "account-security-leader",
    password: "Leader!234",
    displayName: "계정 보안 리더",
    role: "LEADER",
  });
  const staff = await createUser({
    username: "account-security-staff",
    password: "Staff!234",
    displayName: "계정 보안 사원",
  });
  const leaderCredential = await prisma.user_totp_credentials.create({
    data: {
      user_id: leader.user_id,
      secret_ciphertext: "test",
      secret_iv: "test",
      secret_auth_tag: "test",
      enabled: 1,
    },
  });
  const staffCredential = await prisma.user_totp_credentials.create({
    data: {
      user_id: staff.user_id,
      secret_ciphertext: "test",
      secret_iv: "test",
      secret_auth_tag: "test",
      enabled: 1,
    },
  });
  const leaderToken = await authService.createUserSession(leader.user_id);
  const staffToken = await authService.createUserSession(staff.user_id);

  assert.equal(
    (await adminUsersApi.GET(request("/api/admin/users"))).status,
    401
  );

  const missingGrant = await adminUsersApi.GET(
    request("/api/admin/users", leaderToken)
  );
  assert.equal(missingGrant.status, 403);
  assert.deepEqual(
    {
      sensitiveAuthRequired:
        (await missingGrant.clone().json()).sensitiveAuthRequired,
      sensitiveAction: (await missingGrant.json()).sensitiveAction,
    },
    {
      sensitiveAuthRequired: true,
      sensitiveAction: SENSITIVE_ACTIONS.accountManagement,
    }
  );

  const staffSession = await prisma.user_sessions.findUniqueOrThrow({
    where: {
      session_token_hash: authService.hashSessionToken(staffToken),
    },
  });
  await prisma.user_sensitive_auth_grants.create({
    data: {
      session_id: staffSession.session_id,
      sensitive_action: SENSITIVE_ACTIONS.accountManagement,
      verified_until: new Date("2099-01-01T00:00:00+09:00"),
      credential_revision: staff.credential_revision,
      totp_credential_id: staffCredential.credential_id,
      created_at: new Date("2026-07-30T12:00:00+09:00"),
      updated_at: new Date("2026-07-30T12:00:00+09:00"),
    },
  });
  assert.equal(
    (
      await adminUsersApi.GET(
        request("/api/admin/users", staffToken)
      )
    ).status,
    403,
    "A non-LEADER must not use a manually inserted account grant."
  );

  assert.equal(
    (
      await adminMobileApi.GET(
        request("/api/admin/mobile-devices", leaderToken)
      )
    ).status,
    403,
    "Admin mobile device reads must use the same account grant."
  );

  await grantSensitive(
    authService,
    leaderToken,
    leader,
    leaderCredential,
    SENSITIVE_ACTIONS.accountManagement
  );
  assert.equal(
    (
      await adminUsersApi.GET(
        request("/api/admin/users", leaderToken)
      )
    ).status,
    200
  );
  assert.equal(
    (
      await adminMobileApi.GET(
        request("/api/admin/mobile-devices", leaderToken)
      )
    ).status,
    200
  );

  const createResponse = await adminUsersApi.POST(
    request("/api/admin/users", leaderToken, {
      action: "saveUser",
      userId: null,
      username: "  TEMPORARY-ACCOUNT  ",
      displayName: "임시 비밀번호 계정",
      phone: "",
      email: "",
      birthDate: "",
      hireDate: "",
      role: "STAFF",
      isDeveloper: false,
      mobilePackingEnabled: false,
      isActive: true,
      tempPassword: "Temporary!234",
    })
  );
  assert.equal(createResponse.status, 200);
  const createBody = await createResponse.json();
  assert.equal(createBody.item.mustChangePassword, true);
  assert.equal(createBody.item.username, "temporary-account");
  const temporaryUser = await prisma.users.findUniqueOrThrow({
    where: { username: "temporary-account" },
  });
  assert.equal(temporaryUser.must_change_password, 1);

  const temporaryLogin = await loginApi.POST(
    request("/api/auth/login", undefined, {
      username: "Temporary-Account",
      password: "Temporary!234",
    })
  );
  assert.equal(temporaryLogin.status, 200);
  const temporaryLoginBody = await temporaryLogin.clone().json();
  assert.equal(temporaryLoginBody.user.mustChangePassword, true);
  const temporaryToken = responseSessionToken(temporaryLogin);

  const restrictedMe = await meApi.GET(
    request("/api/auth/me", temporaryToken)
  );
  assert.equal(restrictedMe.status, 200);
  const restrictedMeBody = await restrictedMe.json();
  assert.equal(restrictedMeBody.authenticated, true);
  assert.equal(restrictedMeBody.mustChangePassword, true);
  assert.equal(restrictedMeBody.profile, null);
  assert.equal("personalSettings" in restrictedMeBody, false);

  assert.equal(
    (
      await deviceListApi.GET(
        request("/api/inventory/devices?context=INVENTORY", temporaryToken)
      )
    ).status,
    401,
    "A restricted session must not read workspace data."
  );
  assert.equal(
    (
      await totpApi.GET(request("/api/auth/totp", temporaryToken))
    ).status,
    401,
    "A restricted session must not enroll OTP before password change."
  );

  for (const [body, status] of [
    [
      {
        currentPassword: "Wrong!234",
        newPassword: "Changed!234",
        newPasswordConfirm: "Changed!234",
      },
      403,
    ],
    [
      {
        currentPassword: "Temporary!234",
        newPassword: "short",
        newPasswordConfirm: "short",
      },
      400,
    ],
    [
      {
        currentPassword: "Temporary!234",
        newPassword: "Temporary!234",
        newPasswordConfirm: "Temporary!234",
      },
      400,
    ],
  ]) {
    const failedChange = await passwordApi.POST(
      request("/api/auth/password", temporaryToken, body)
    );
    assert.equal(failedChange.status, status);
    assert.equal(
      (
        await prisma.users.findUniqueOrThrow({
          where: { user_id: temporaryUser.user_id },
        })
      ).must_change_password,
      1
    );
  }

  const successfulChange = await passwordApi.POST(
    request("/api/auth/password", temporaryToken, {
      currentPassword: "Temporary!234",
      newPassword: "Changed!234",
      newPasswordConfirm: "Changed!234",
    })
  );
  assert.equal(successfulChange.status, 200);
  const normalToken = responseSessionToken(successfulChange);
  const changedUser = await prisma.users.findUniqueOrThrow({
    where: { user_id: temporaryUser.user_id },
  });
  assert.equal(changedUser.must_change_password, 0);
  assert.equal(
    await verifyPassword("Changed!234", changedUser.password_hash),
    true
  );
  assert.equal(
    await verifyPassword("Temporary!234", changedUser.password_hash),
    false
  );
  assert.equal(
    await authService.getPasswordChangeSessionFromToken(temporaryToken),
    null,
    "The restricted session must be revoked after password change."
  );
  assert.equal(
    (
      await deviceListApi.GET(
        request("/api/inventory/devices?context=INVENTORY", normalToken)
      )
    ).status,
    200
  );

  const passwordLog = await prisma.employee_activity_logs.findFirstOrThrow({
    where: {
      user_id: temporaryUser.user_id,
      action_type: "USER_PASSWORD_CHANGE",
    },
    orderBy: { id: "desc" },
    include: { changes: true },
  });
  const serializedPasswordLog = JSON.stringify(passwordLog);
  assert.equal(serializedPasswordLog.includes("Temporary!234"), false);
  assert.equal(serializedPasswordLog.includes("Changed!234"), false);
  assert.equal(serializedPasswordLog.includes("password_hash"), false);

  const secondNormalToken = await authService.createUserSession(
    temporaryUser.user_id
  );
  const normalChange = await passwordApi.POST(
    request("/api/auth/password", normalToken, {
      currentPassword: "Changed!234",
      newPassword: "ChangedAgain!234",
      newPasswordConfirm: "ChangedAgain!234",
    })
  );
  assert.equal(normalChange.status, 200);
  const refreshedToken = responseSessionToken(normalChange);
  assert.equal(
    await authService.getPasswordChangeSessionFromToken(normalToken),
    null
  );
  assert.equal(
    await authService.getPasswordChangeSessionFromToken(secondNormalToken),
    null
  );
  assert.ok(
    await authService.getAuthSessionFromToken(refreshedToken),
    "The response must issue a new operational session."
  );

  const resetTarget = await createUser({
    username: "account-reset-target",
    password: "Original!234",
    displayName: "초기화 대상",
  });
  const resetTargetSession = await authService.createUserSession(
    resetTarget.user_id
  );
  const resetTargetWithProfile = await prisma.users.findUniqueOrThrow({
    where: { user_id: resetTarget.user_id },
    include: { employee_profiles: true },
  });
  const resetResponse = await adminUsersApi.POST(
    request(
      "/api/admin/users",
      leaderToken,
      adminUserBody(resetTargetWithProfile, "ResetTemp!234")
    )
  );
  assert.equal(resetResponse.status, 200);
  assert.equal((await resetResponse.json()).item.mustChangePassword, true);
  assert.equal(
    await authService.getPasswordChangeSessionFromToken(resetTargetSession),
    null
  );
  const resetProfileOnly = await adminUsersApi.POST(
    request(
      "/api/admin/users",
      leaderToken,
      adminUserBody(
        await prisma.users.findUniqueOrThrow({
          where: { user_id: resetTarget.user_id },
          include: { employee_profiles: true },
        }),
        ""
      )
    )
  );
  assert.equal(resetProfileOnly.status, 200);
  assert.equal(
    (
      await prisma.users.findUniqueOrThrow({
        where: { user_id: resetTarget.user_id },
      })
    ).must_change_password,
    1,
    "Profile-only admin updates must preserve the forced-change state."
  );

  const concurrentUser = await createUser({
    username: "concurrent-password-user",
    password: "Concurrent!234",
  });
  const concurrentTokenA = await authService.createUserSession(
    concurrentUser.user_id
  );
  const concurrentTokenB = await authService.createUserSession(
    concurrentUser.user_id
  );
  const concurrentResults = await Promise.all([
    passwordApi.POST(
      request("/api/auth/password", concurrentTokenA, {
        currentPassword: "Concurrent!234",
        newPassword: "ConcurrentA!234",
        newPasswordConfirm: "ConcurrentA!234",
      })
    ),
    passwordApi.POST(
      request("/api/auth/password", concurrentTokenB, {
        currentPassword: "Concurrent!234",
        newPassword: "ConcurrentB!234",
        newPasswordConfirm: "ConcurrentB!234",
      })
    ),
  ]);
  assert.equal(
    concurrentResults.filter((response) => response.status === 200).length,
    1,
    "Exactly one concurrent password change must succeed."
  );
  assert.equal(
    concurrentResults.filter((response) =>
      [401, 409].includes(response.status)
    ).length,
    1
  );

  const generationBarrierAccount = await createRandomTestAccount({
    databaseUrl: temporaryDatabase.databaseUrl,
    prisma,
    displayName: "Session generation barrier",
  });
  const generationBarrierUser = generationBarrierAccount.user;
  const barrierPool = new Pool({
    connectionString: temporaryDatabase.databaseUrl,
    max: 1,
  });
  const barrierConnection = await barrierPool.connect();
  try {
    await barrierConnection.query("BEGIN");
    await barrierConnection.query(
      `SELECT revision
       FROM server_instance_state
       WHERE singleton_key = 'QUICKHACK'
       FOR SHARE`
    );
    await barrierConnection.query(
      "SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE",
      [generationBarrierUser.user_id]
    );
    await barrierConnection.query(
      `UPDATE users
       SET revision = revision + 1,
           credential_revision = credential_revision + 1
       WHERE user_id = $1`,
      [generationBarrierUser.user_id]
    );

    let lateSessionSettled = false;
    const lateSession = authService
      .createUserSession(
        generationBarrierUser.user_id,
        generationBarrierUser.credential_revision
      )
      .finally(() => {
        lateSessionSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      lateSessionSettled,
      false,
      "Session creation must wait for the independently held user lock."
    );

    await barrierConnection.query("COMMIT");
    await assert.rejects(lateSession, (error) => {
      assert.equal(error?.code, "SESSION_GENERATION_CHANGED");
      return true;
    });
  } catch (error) {
    await barrierConnection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    barrierConnection.release();
    await barrierPool.end();
  }

  const staleSessionToken = await authService.createUserSession(
    generationBarrierUser.user_id
  );
  await prisma.users.update({
    where: { user_id: generationBarrierUser.user_id },
    data: {
      revision: { increment: 1 },
      credential_revision: { increment: 1 },
    },
  });
  assert.equal(
    await authService.getAuthSessionFromToken(staleSessionToken),
    null,
    "A session from an older credential generation must be rejected."
  );
  assert.equal(
    await prisma.user_sessions.count({
      where: {
        session_token_hash: authService.hashSessionToken(staleSessionToken),
      },
    }),
    0,
    "Rejected stale sessions must be removed."
  );

  const leaderSession = await prisma.user_sessions.findUniqueOrThrow({
    where: {
      session_token_hash: authService.hashSessionToken(leaderToken),
    },
  });
  await prisma.user_sensitive_auth_grants.update({
    where: {
      session_id_sensitive_action: {
        session_id: leaderSession.session_id,
        sensitive_action: SENSITIVE_ACTIONS.accountManagement,
      },
    },
    data: {
      verified_until: new Date("2000-01-01T00:00:00+09:00"),
    },
  });
  assert.equal(
    (
      await adminUsersApi.GET(
        request("/api/admin/users", leaderToken)
      )
    ).status,
    403,
    "An expired account grant must not be reused."
  );

  console.log("Account security integration tests passed.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
