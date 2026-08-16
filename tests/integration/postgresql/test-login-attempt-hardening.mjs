import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { createPostgresqlBarrier } from "../../support/postgresql-barrier.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-login-attempt-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

function headers(forwardedFor, realIp) {
  const value = new Headers();
  if (forwardedFor !== undefined) value.set("x-forwarded-for", forwardedFor);
  if (realIp !== undefined) value.set("x-real-ip", realIp);
  return value;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

let prisma;
const additionalClients = [];

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    InvalidTrustedClientAddressError,
    LOGIN_CLIENT_MAX_FAILED_ATTEMPTS,
    executeLoginAttempt,
    loginAttemptIdentity,
    trustedClientAddress,
  } = await import("@/quickhack_server/auth/login-attempt-service");

  assert.equal(trustedClientAddress(headers()), "local");
  assert.equal(
    trustedClientAddress(headers(undefined, "203.0.113.20")),
    "local",
    "X-Real-IP was incorrectly accepted as a login identity fallback."
  );
  assert.equal(
    trustedClientAddress(headers("::ffff:192.0.2.10")),
    "192.0.2.10"
  );
  assert.throws(
    () => trustedClientAddress(headers("203.0.113.10, 203.0.113.11")),
    InvalidTrustedClientAddressError
  );
  assert.throws(
    () => trustedClientAddress(headers("not-an-ip")),
    InvalidTrustedClientAddressError
  );

  const identity = loginAttemptIdentity(headers("192.0.2.10"), " Leader ");
  assert.deepEqual(identity, {
    credentialAttemptKey: "credential:192.0.2.10:leader",
    clientAttemptKey: "client:192.0.2.10",
    ipAddress: "192.0.2.10",
    username: "leader",
  });
  assert.deepEqual(
    loginAttemptIdentity(headers("192.0.2.10"), "LEADER"),
    identity,
    "Case variants did not resolve to one login identity."
  );

  const startedAt = new Date("2026-07-30T03:00:00.000Z");
  let verifierCalls = 0;
  const fail = (attemptIdentity, now = startedAt, owner = prisma) =>
    executeLoginAttempt(
      owner,
      attemptIdentity,
      async () => {
        verifierCalls += 1;
        return { succeeded: false, value: null };
      },
      now
    );

  for (let failure = 1; failure <= 5; failure += 1) {
    assert.equal((await fail(identity)).status, "FAILED");
  }
  assert.equal((await fail(identity)).status, "BLOCKED");
  assert.equal(verifierCalls, 5, "A blocked credential still ran verification.");
  const credentialBucket = await prisma.login_attempts.findUniqueOrThrow({
    where: { attempt_key: identity.credentialAttemptKey },
  });
  const clientBucket = await prisma.login_attempts.findUniqueOrThrow({
    where: { attempt_key: identity.clientAttemptKey },
  });
  assert.equal(credentialBucket.failed_count, 5);
  assert.equal(clientBucket.failed_count, 5);

  await prisma.login_attempts.deleteMany();
  verifierCalls = 0;
  const rotatingIp = "192.0.2.20";
  for (let index = 0; index < LOGIN_CLIENT_MAX_FAILED_ATTEMPTS; index += 1) {
    const rotatingIdentity = loginAttemptIdentity(
      headers(rotatingIp),
      `missing-${index}`
    );
    assert.equal((await fail(rotatingIdentity)).status, "FAILED");
  }
  const rotatedBlocked = await fail(
    loginAttemptIdentity(headers(rotatingIp), "missing-after-limit")
  );
  assert.equal(rotatedBlocked.status, "BLOCKED");
  assert.equal(
    verifierCalls,
    LOGIN_CLIENT_MAX_FAILED_ATTEMPTS,
    "Username rotation continued verification after the client threshold."
  );
  assert.equal(
    await prisma.login_attempts.count({ where: { ip_address: rotatingIp } }),
    LOGIN_CLIENT_MAX_FAILED_ATTEMPTS + 1,
    "Username rotation created rows after the client bucket blocked."
  );

  const recovered = await fail(
    loginAttemptIdentity(headers(rotatingIp), "after-expiry"),
    addSeconds(startedAt, 601)
  );
  assert.equal(recovered.status, "FAILED", "The client bucket did not expire.");

  await prisma.login_attempts.deleteMany();
  verifierCalls = 0;
  const concurrentIp = "192.0.2.30";
  const { createPostgresqlPrismaClient } = await import(
    "@/quickhack_server/core/database/postgresql-client"
  );
  const firstConcurrentClient = createPostgresqlPrismaClient({
    connectionString: temporaryDatabase.databaseUrl,
    applicationName: "login-attempt-concurrency-a",
  }).client;
  const secondConcurrentClient = createPostgresqlPrismaClient({
    connectionString: temporaryDatabase.databaseUrl,
    applicationName: "login-attempt-concurrency-b",
  }).client;
  additionalClients.push(firstConcurrentClient, secondConcurrentClient);
  const concurrentCount = LOGIN_CLIENT_MAX_FAILED_ATTEMPTS + 4;
  const concurrentStart = createPostgresqlBarrier(concurrentCount);
  const concurrentResults = await Promise.all(
    Array.from({ length: concurrentCount }, async (_, index) => {
      await concurrentStart();
      return fail(
        loginAttemptIdentity(headers(concurrentIp), `parallel-${index}`),
        startedAt,
        index % 2 === 0 ? firstConcurrentClient : secondConcurrentClient
      );
    })
  );
  assert.equal(
    concurrentResults.filter((result) => result.status === "FAILED").length,
    LOGIN_CLIENT_MAX_FAILED_ATTEMPTS
  );
  assert.equal(
    concurrentResults.filter((result) => result.status === "BLOCKED").length,
    4
  );
  assert.equal(
    verifierCalls,
    LOGIN_CLIENT_MAX_FAILED_ATTEMPTS,
    "PostgreSQL advisory locking admitted excess concurrent verification."
  );

  await prisma.login_attempts.deleteMany();
  let activeVerifiers = 0;
  let maximumActiveVerifiers = 0;
  const differentIpVerifierBarrier = createPostgresqlBarrier(2);
  const observeDifferentIp = (ipAddress, owner) =>
    executeLoginAttempt(
      owner,
      loginAttemptIdentity(headers(ipAddress), "missing"),
      async () => {
        activeVerifiers += 1;
        maximumActiveVerifiers = Math.max(maximumActiveVerifiers, activeVerifiers);
        await differentIpVerifierBarrier();
        activeVerifiers -= 1;
        return { succeeded: false, value: null };
      },
      startedAt
    );
  await Promise.all([
    observeDifferentIp("192.0.2.40", firstConcurrentClient),
    observeDifferentIp("192.0.2.41", secondConcurrentClient),
  ]);
  assert.equal(
    maximumActiveVerifiers,
    2,
    "Different client IP addresses were globally serialized."
  );

  const successIdentity = loginAttemptIdentity(headers("192.0.2.50"), "leader");
  await fail(successIdentity);
  const success = await executeLoginAttempt(
    prisma,
    successIdentity,
    async () => ({ succeeded: true, value: { userId: 1 } }),
    startedAt
  );
  assert.equal(success.status, "SUCCEEDED");
  assert.equal(
    await prisma.login_attempts.findUnique({
      where: { attempt_key: successIdentity.credentialAttemptKey },
    }),
    null,
    "Successful login did not clear its credential bucket."
  );
  assert.ok(
    await prisma.login_attempts.findUnique({
      where: { attempt_key: successIdentity.clientAttemptKey },
    }),
    "Successful login incorrectly cleared the client-wide history."
  );

  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/quickhack_server/api/auth/login");
  const routeIp = "192.0.2.60";
  function invalidRouteRequest() {
    return new NextRequest("http://127.0.0.1/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": routeIp,
      },
      body: JSON.stringify({
        username: "missing-parallel-user",
        password: "invalid-password",
      }),
    });
  }
  const routeResponses = await Promise.all(
    Array.from({ length: 8 }, () => POST(invalidRouteRequest()))
  );
  assert.equal(
    routeResponses.filter((response) => response.status === 401).length,
    5
  );
  assert.equal(
    routeResponses.filter((response) => response.status === 429).length,
    3
  );

  const malformedRouteResponse = await POST(
    new NextRequest("http://127.0.0.1/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10, 203.0.113.11",
      },
      body: JSON.stringify({
        username: "malformed-address",
        password: "invalid-password",
      }),
    })
  );
  assert.equal(malformedRouteResponse.status, 400);

  console.log(
    "Canonical login identity, PostgreSQL dual buckets, rotation limits, and concurrency verified."
  );
} finally {
  for (const client of additionalClients) await client.$disconnect();
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
