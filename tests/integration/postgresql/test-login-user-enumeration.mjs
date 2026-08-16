import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { NextRequest } from "next/server.js";

import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-login-user-enumeration-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
process.env.QUICKHACK_RUNTIME_ROLE = "server";

function loginRequest(username, password, ipAddress) {
  return new NextRequest("http://127.0.0.1/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ipAddress,
    },
    body: JSON.stringify({ username, password }),
  });
}

async function createUser(prisma, hashPassword, input) {
  const now = new Date("2026-07-31T03:00:00.000Z");
  const user = await prisma.users.create({
    data: {
      username: input.username,
      password_hash: await hashPassword(input.password),
      role: "STAFF",
      is_active: input.active ? 1 : 0,
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(operation, count = 5) {
  const values = [];

  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }

  return median(values);
}

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const passwordService = await import(
    "@/quickhack_server/core/password"
  );
  const loginApi = await import("@/quickhack_server/api/auth/login");
  const active = await createUser(prisma, passwordService.hashPassword, {
    username: "timing-active",
    password: "Active!234",
    active: true,
  });
  const inactive = await createUser(prisma, passwordService.hashPassword, {
    username: "timing-inactive",
    password: "Inactive!234",
    active: false,
  });

  for (const [hash, expected] of [
    [null, false],
    [inactive.password_hash, false],
    [active.password_hash, true],
  ]) {
    let verifierCalls = 0;
    let verifiedHash = "";
    const result = await passwordService.verifyLoginPassword(
      "fixture-password",
      hash === inactive.password_hash ? null : hash,
      async (_password, storedHash) => {
        verifierCalls += 1;
        verifiedHash = storedHash;
        return expected;
      }
    );
    assert.equal(verifierCalls, 1);
    assert.match(verifiedHash, /^scrypt\$/);
    assert.equal(result, expected);
  }

  const cases = [
    {
      username: "timing-missing",
      ipAddress: "192.0.2.41",
    },
    {
      username: inactive.username,
      ipAddress: "192.0.2.42",
    },
    {
      username: active.username,
      ipAddress: "192.0.2.43",
    },
  ];
  const failureBodies = [];

  for (const item of cases) {
    const response = await loginApi.POST(
      loginRequest(item.username, "Wrong!234", item.ipAddress)
    );
    assert.equal(response.status, 401);
    failureBodies.push(await response.json());
    const attempt = await prisma.login_attempts.findUniqueOrThrow({
      where: {
        attempt_key: `credential:${item.ipAddress}:${item.username}`,
      },
    });
    assert.equal(attempt.failed_count, 1);
  }
  assert.deepEqual(failureBodies[1], failureBodies[0]);
  assert.deepEqual(failureBodies[2], failureBodies[0]);

  const successfulLogin = await loginApi.POST(
    loginRequest(`  ${active.username.toUpperCase()}  `, "Active!234", "192.0.2.44")
  );
  assert.equal(
    successfulLogin.status,
    200,
    "A case variant did not resolve to the canonical stored username."
  );

  await passwordService.verifyLoginPassword("warm-up", null);
  await passwordService.verifyLoginPassword(
    "warm-up",
    active.password_hash
  );
  const dummyMedian = await measure(() =>
    passwordService.verifyLoginPassword("Wrong!234", null)
  );
  const userHashMedian = await measure(() =>
    passwordService.verifyLoginPassword(
      "Wrong!234",
      active.password_hash
    )
  );
  const timingRatio = dummyMedian / userHashMedian;
  assert.ok(
    timingRatio >= 0.25 && timingRatio <= 4,
    `Dummy and user scrypt costs diverged: ratio=${timingRatio.toFixed(2)}`
  );

  console.log(
    "Missing, inactive, and wrong-password login cost contracts verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
