import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server.js";

import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { createDeterministicTotpService } from "../../support/deterministic-totp-service.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sensitive-action-policy-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

function currentTotpCode(secret) {
  const step = Math.floor(Date.now() / 1000 / 30);
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

function postRequest(path, token, body) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie: `quickhack_session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function statusRequest(token, action) {
  return new NextRequest(
    `http://localhost/api/auth/sensitive-status?action=${encodeURIComponent(
      action
    )}`,
    {
      headers: token
        ? { cookie: `quickhack_session=${token}` }
        : undefined,
    }
  );
}

async function createUser(prisma, hashPassword, input) {
  const now = new Date("2026-07-31T12:00:00+09:00");
  const user = await prisma.users.create({
    data: {
      username: input.username,
      password_hash: await hashPassword("Sensitive!234"),
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

async function enrollTotp(totpService, user) {
  const enrollment = await totpService.createTotpEnrollment(
    user.user_id,
    user.username
  );
  const confirmation = await totpService.confirmTotpEnrollment(
    user.user_id,
    currentTotpCode(enrollment.secret),
    enrollment.enrollmentToken
  );
  assert.equal(confirmation.confirmed, true);

  return enrollment.secret;
}

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { hashPassword } = await import("@/quickhack_server/core/password");
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const sensitivePolicy = await import(
    "@/quickhack_shared/auth/sensitive-auth"
  );
  const totpModule = await import(
    "@/quickhack_server/auth/totp-service"
  );
  const totpService = createDeterministicTotpService(totpModule);
  const sensitiveVerifyModule = await import(
    "@/quickhack_server/api/auth/sensitive-verify"
  );
  const sensitiveVerifyApi = {
    POST: sensitiveVerifyModule.createSensitiveVerifyHandler({
      loadTotpService: async () => ({
        verifySensitiveSession: totpService.verifySensitiveSession,
      }),
    }),
  };
  const sensitiveStatusApi = await import(
    "@/quickhack_server/api/auth/sensitive-status"
  );

  const rank = {
    VIEWER: 0,
    STAFF: 1,
    MANAGER: 2,
    LEADER: 3,
  };
  const roles = Object.keys(rank);

  for (const [action, policy] of Object.entries(
    sensitivePolicy.SENSITIVE_ACTION_POLICIES
  )) {
    assert.equal(sensitivePolicy.parseSensitiveAction(action), action);

    for (const role of roles) {
      assert.equal(
        sensitivePolicy.canUseSensitiveAction(role, action),
        rank[role] >= rank[policy.minRole],
        `${role} policy mismatch for ${action}`
      );
    }
  }
  assert.equal(sensitivePolicy.parseSensitiveAction("UNKNOWN_ACTION"), null);
  assert.equal(sensitivePolicy.parseSensitiveAction("X".repeat(65)), null);
  assert.equal(sensitivePolicy.parseSensitiveAction(""), null);

  const leader = await createUser(prisma, hashPassword, {
    username: "sensitive-policy-leader",
    role: "LEADER",
  });
  const manager = await createUser(prisma, hashPassword, {
    username: "sensitive-policy-manager",
    role: "MANAGER",
  });
  const staff = await createUser(prisma, hashPassword, {
    username: "sensitive-policy-staff",
    role: "STAFF",
  });
  const leaderSecret = await enrollTotp(totpService, leader);
  const managerSecret = await enrollTotp(totpService, manager);
  await enrollTotp(totpService, staff);
  const leaderToken = await authService.createUserSession(leader.user_id);
  const managerToken = await authService.createUserSession(manager.user_id);
  const staffToken = await authService.createUserSession(staff.user_id);

  assert.equal(
    await prisma.user_sensitive_auth_grants.count({
      where: { sensitive_action: "UNKNOWN_ACTION" },
    }),
    0
  );

  const leaderCredentialBeforeUnknown =
    await prisma.user_totp_credentials.findUniqueOrThrow({
      where: { user_id: leader.user_id },
    });
  for (const action of ["UNKNOWN_ACTION", "X".repeat(65), ""]) {
    const response = await sensitiveVerifyApi.POST(
      postRequest("/api/auth/sensitive-verify", leaderToken, {
        sensitiveAction: action,
        otpCode: "000000",
      })
    );
    assert.equal(response.status, 400);
  }
  assert.deepEqual(
    await prisma.user_totp_credentials.findUniqueOrThrow({
      where: { user_id: leader.user_id },
    }),
    leaderCredentialBeforeUnknown,
    "Unknown actions consumed TOTP state."
  );
  assert.equal(
    (
      await sensitiveStatusApi.GET(
        statusRequest(leaderToken, "UNKNOWN_ACTION")
      )
    ).status,
    400
  );

  const staffCredentialBefore =
    await prisma.user_totp_credentials.findUniqueOrThrow({
      where: { user_id: staff.user_id },
    });
  const forbiddenVerify = await sensitiveVerifyApi.POST(
    postRequest("/api/auth/sensitive-verify", staffToken, {
      sensitiveAction:
        sensitivePolicy.SENSITIVE_ACTIONS.accountManagement,
      otpCode: "000000",
    })
  );
  assert.equal(forbiddenVerify.status, 403);
  assert.deepEqual(
    await prisma.user_totp_credentials.findUniqueOrThrow({
      where: { user_id: staff.user_id },
    }),
    staffCredentialBefore,
    "A forbidden action consumed TOTP state."
  );
  assert.equal(
    (
      await sensitiveStatusApi.GET(
        statusRequest(
          staffToken,
          sensitivePolicy.SENSITIVE_ACTIONS.accountManagement
        )
      )
    ).status,
    403
  );

  const managerAction = sensitivePolicy.SENSITIVE_ACTIONS.inventoryEdit;
  const managerVerify = await sensitiveVerifyApi.POST(
    postRequest("/api/auth/sensitive-verify", managerToken, {
      sensitiveAction: managerAction,
      otpCode: currentTotpCode(managerSecret),
    })
  );
  assert.equal(managerVerify.status, 200);
  assert.equal(
    await prisma.user_sensitive_auth_grants.count({
      where: { sensitive_action: managerAction },
    }),
    1
  );
  const managerStatus = await sensitiveStatusApi.GET(
    statusRequest(managerToken, managerAction)
  );
  assert.equal(managerStatus.status, 200);
  assert.equal((await managerStatus.json()).sensitiveAuthenticated, true);

  const leaderAction =
    sensitivePolicy.SENSITIVE_ACTIONS.accountManagement;
  const leaderVerify = await sensitiveVerifyApi.POST(
    postRequest("/api/auth/sensitive-verify", leaderToken, {
      sensitiveAction: leaderAction,
      otpCode: currentTotpCode(leaderSecret),
    })
  );
  assert.equal(leaderVerify.status, 200);
  assert.equal(
    await prisma.user_sensitive_auth_grants.count({
      where: { sensitive_action: leaderAction },
    }),
    1
  );

  console.log(
    "Sensitive action closed set, role policy, and pre-TOTP rejection verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
