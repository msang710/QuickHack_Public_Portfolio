import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-mobile-aggregate-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const keyAccess = {
  async withKey(operation) {
    const key = Buffer.alloc(32, 0x4d);
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  },
};

function authUser(row) {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.username,
    role: row.role,
    isDeveloper: false,
    mobilePackingEnabled: true,
    mustChangePassword: false,
  };
}

function proof(input) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const tokenDigest = crypto
    .createHash("sha256")
    .update(input.deviceToken)
    .digest("base64url");
  const message = [
    "QH-MOBILE-PROVISION-V1",
    String(input.deviceId),
    String(input.registrationRevision),
    input.provisioningToken,
    input.appInstanceId,
    tokenDigest,
  ].join("\n");
  return {
    devicePublicKeySpki: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    signature: crypto.sign("sha256", Buffer.from(message), privateKey).toString("base64"),
  };
}

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { createUserSession, hashSessionToken } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const { hashPassword } = await import("@/quickhack_server/core/password");
  const service = await import("@/quickhack_server/mobile/mobile-device-service");
  const now = new Date("2026-08-14T09:00:00+09:00");

  async function createUser(username) {
    const row = await prisma.users.create({
      data: {
        username,
        password_hash: await hashPassword("Mobile!234"),
        role: "STAFF",
        is_active: 1,
        mobile_packing_enabled: 1,
        created_at: now,
        updated_at: now,
      },
    });
    await prisma.employee_profiles.create({
      data: { user_id: row.user_id, display_name: username, created_at: now, updated_at: now },
    });
    const sessionToken = await createUserSession(row.user_id, row.credential_revision);
    const session = await prisma.user_sessions.findUniqueOrThrow({
      where: { session_token_hash: hashSessionToken(sessionToken) },
    });
    return {
      row,
      context: {
        actor: authUser(row),
        sessionId: session.session_id,
        scope: "SELF",
      },
    };
  }

  const owner = await createUser("mobile-owner");
  const other = await createUser("mobile-other");
  const first = await service.beginMobileDeviceProvisioning(
    { userId: owner.row.user_id, adbSerial: "PHYSICAL-USB-001", label: "line one" },
    owner.context,
    keyAccess
  );
  assert.equal(first.item.registrationState, "PROVISIONING");
  assert.equal("activationCode" in first, false);

  await assert.rejects(
    () =>
      service.beginMobileDeviceProvisioning(
        { userId: other.row.user_id, adbSerial: "PHYSICAL-USB-001" },
        other.context,
        keyAccess
      ),
    (error) => error?.status === 409 && error?.code === "MOBILE_DEVICE_ALREADY_REGISTERED"
  );

  const appInstanceId = "app-instance-one";
  const deviceToken = crypto.randomBytes(32).toString("base64url");
  const activationInput = {
    deviceId: first.bootstrap.deviceId,
    registrationRevision: first.bootstrap.registrationRevision,
    provisioningToken: first.bootstrap.provisioningToken,
    appInstanceId,
    deviceToken,
    ...proof({
      deviceId: first.bootstrap.deviceId,
      registrationRevision: first.bootstrap.registrationRevision,
      provisioningToken: first.bootstrap.provisioningToken,
      appInstanceId,
      deviceToken,
    }),
  };
  await assert.rejects(
    () =>
      service.activateMobileDevice(
        { ...activationInput, deviceToken: "predictable-token" },
        owner.context
      ),
    (error) =>
      error?.status === 403 && error?.code === "MOBILE_DEVICE_AUTH_FAILED"
  );
  const activated = await service.activateMobileDevice(activationInput, owner.context);
  assert.equal(activated.registrationState, "ACTIVE");
  assert.equal(activated.deviceToken, deviceToken);

  const replay = await service.activateMobileDevice(activationInput, owner.context);
  assert.equal(replay.deviceToken, deviceToken);
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "MOBILE_DEVICE_ACTIVATE",
        target_id: String(first.bootstrap.deviceId),
      },
    }),
    1,
    "An activation response retry wrote a duplicate audit event."
  );

  await prisma.$transaction((tx) =>
    service.requireMobilePackingDeviceInTransaction(
      tx,
      { appInstanceId, deviceToken },
      owner.context
    )
  );

  await assert.rejects(
    () =>
      service.revokeMobileDevice(
        {
          deviceId: first.bootstrap.deviceId,
          expectedRegistrationRevision: first.bootstrap.registrationRevision,
        },
        owner.context
      ),
    (error) => error?.status === 409 && error?.code === "MOBILE_DEVICE_CHANGED"
  );

  const revoked = await service.revokeMobileDevice(
    {
      deviceId: first.bootstrap.deviceId,
      expectedRegistrationRevision: activated.registrationRevision,
    },
    owner.context
  );
  assert.equal(revoked.registrationState, "REVOKED");
  assert.equal(
    (await prisma.mobile_registered_devices.findUniqueOrThrow({
      where: { device_id: first.bootstrap.deviceId },
    })).device_token_hash,
    null
  );

  const second = await service.beginMobileDeviceProvisioning(
    { userId: other.row.user_id, adbSerial: "PHYSICAL-USB-001" },
    other.context,
    keyAccess
  );
  assert.equal(second.item.userId, other.row.user_id);

  await prisma.mobile_registered_devices.createMany({
    data: Array.from({ length: 301 }, (_, index) => ({
      user_id: other.row.user_id,
      label: `page-${index}`,
      adb_serial_hmac: `test-hmac-${index}`,
      adb_serial_preview: `test-${index}`,
      registration_state: "PROVISIONING",
      provisioning_token_hash: `test-token-${index}`,
      provisioning_expires_at: new Date("2030-01-01T00:00:00Z"),
      registered_by_user_id: other.row.user_id,
    })),
  });
  const listedIds = [];
  let cursor = null;
  do {
    const page = await service.listMobileRegisteredDevices({
      userId: other.row.user_id,
      cursor,
      limit: 100,
    });
    listedIds.push(...page.items.map((item) => item.deviceId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(listedIds.length, 302);
  assert.equal(new Set(listedIds).size, listedIds.length);

  console.log(
    "Mobile physical-device uniqueness, signed activation idempotency, revision CAS, revocation, and keyset paging verified."
  );
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
