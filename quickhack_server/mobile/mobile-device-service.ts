import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { addSeconds, quickHackClock } from "@/quickhack_shared/core/time";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { authorizeAccountMutation } from "@/quickhack_server/auth/account-security-aggregate";
import { lockServerSecurityState } from "@/quickhack_server/auth/security-state";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import {
  apiDateTime,
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  type MobileSerialHmacKeyAccess,
  withMobileSerialHmacKey,
} from "@/quickhack_server/security/mobile-serial-hmac-key-provider";

const PROVISIONING_TTL_SECONDS = 10 * 60;
const HASH_VERSION = "sha256:v2";
const SERIAL_HMAC_VERSION = "hmac-sha256:v2";
const LIST_CURSOR_CONTRACT = "mobile-registered-devices:v1";
type MobileRegistrationState = "PROVISIONING" | "ACTIVE" | "REVOKED";
type MobileDeviceClient = Pick<
  Prisma.TransactionClient,
  "mobile_registered_devices" | "employee_activity_logs"
>;
type MobileDeviceRow = Awaited<ReturnType<typeof findMobileDeviceForDto>>;

export type MobileRegistrationSecurityContext = {
  actor: AuthUser;
  sessionId: number;
  scope: "SELF" | "ACCOUNT_MANAGEMENT";
};

export class MobileDeviceAuthError extends Error {
  readonly status = 403;
  readonly code = "MOBILE_DEVICE_AUTH_FAILED";
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function optionalText(value: unknown, maxLength = 80) {
  const cleaned = cleanText(value).replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function positiveInt(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw publicBadRequest("INVALID_MOBILE_DEVICE_INPUT", "INVALID_MOBILE_DEVICE_INPUT");
  }
  return parsed;
}

function nonNegativeInt(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw publicBadRequest("INVALID_MOBILE_DEVICE_REVISION", "INVALID_MOBILE_DEVICE_REVISION");
  }
  return parsed;
}

function normalizeAdbSerial(value: unknown) {
  return cleanText(value).replace(/\s+/g, "");
}

function maskSerial(serial: string) {
  if (serial.length <= 6) return `${serial.slice(0, 1)}***${serial.slice(-1)}`;
  return `${serial.slice(0, 4)}...${serial.slice(-4)}`;
}

function scopedHash(purpose: string, value: string) {
  const digest = crypto
    .createHash("sha256")
    .update("quickhack-mobile-credential-v2")
    .update("\0")
    .update(purpose)
    .update("\0")
    .update(value)
    .digest("hex");
  return `${HASH_VERSION}:${digest}`;
}

function appInstanceHash(value: string) {
  return scopedHash("app-instance", value);
}

function deviceTokenHash(value: string) {
  return scopedHash("device-token", value);
}

function provisioningTokenHash(value: string) {
  return scopedHash("provisioning-token", value);
}

function randomCredential(value: unknown, label: string) {
  const encoded = cleanText(value);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  }
  const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  try {
    if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
      throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
    }
    return encoded;
  } finally {
    decoded.fill(0);
  }
}

function publicKeyFingerprint(spki: Buffer) {
  return `sha256:${crypto.createHash("sha256").update(spki).digest("base64url")}`;
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function registrationProofMessage(input: {
  deviceId: number;
  registrationRevision: number;
  provisioningToken: string;
  appInstanceId: string;
  deviceToken: string;
}) {
  const tokenDigest = crypto
    .createHash("sha256")
    .update(input.deviceToken)
    .digest("base64url");
  return [
    "QH-MOBILE-PROVISION-V1",
    String(input.deviceId),
    String(input.registrationRevision),
    input.provisioningToken,
    input.appInstanceId,
    tokenDigest,
  ].join("\n");
}

function decodeBase64(value: unknown, label: string) {
  const encoded = cleanText(value);
  if (!encoded || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  }
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const payload = Buffer.from(normalized, "base64");
  if (!payload.length) throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  return payload;
}

function verifyRegistrationProof(input: {
  deviceId: number;
  registrationRevision: number;
  provisioningToken: string;
  appInstanceId: string;
  deviceToken: string;
  devicePublicKeySpki: unknown;
  signature: unknown;
}) {
  const spki = decodeBase64(input.devicePublicKeySpki, "기기 공개키");
  const signature = decodeBase64(input.signature, "기기 서명");
  try {
    const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    if (
      publicKey.asymmetricKeyType !== "ec" ||
      publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
    }
    const canonicalSpki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const verified = crypto.verify(
      "sha256",
      Buffer.from(registrationProofMessage(input), "utf8"),
      publicKey,
      signature
    );
    if (!verified) throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
    return {
      spki: canonicalSpki.toString("base64"),
      fingerprint: publicKeyFingerprint(canonicalSpki),
    };
  } catch (error) {
    if (error instanceof MobileDeviceAuthError) throw error;
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  } finally {
    spki.fill(0);
    signature.fill(0);
  }
}

async function serialHmac(
  serial: string,
  keyAccess?: MobileSerialHmacKeyAccess
) {
  const operation = (key: Buffer) =>
    `${SERIAL_HMAC_VERSION}:${crypto
      .createHmac("sha256", key)
      .update("quickhack-adb-serial")
      .update("\0")
      .update(serial)
      .digest("base64url")}`;
  return keyAccess
    ? keyAccess.withKey(operation)
    : withMobileSerialHmacKey(operation);
}

async function findMobileDeviceForDto(
  deviceId: number,
  client: MobileDeviceClient = prisma
) {
  return client.mobile_registered_devices.findUnique({
    where: { device_id: deviceId },
    include: {
      user: {
        select: {
          user_id: true,
          username: true,
          is_active: true,
          credential_revision: true,
          mobile_packing_enabled: true,
          employee_profiles: { select: { display_name: true } },
        },
      },
    },
  });
}

function effectiveState(
  row: NonNullable<MobileDeviceRow>,
  serverInstanceEpoch: number
) {
  if (
    row.registration_state === "ACTIVE" &&
    (row.user.is_active !== 1 ||
      row.user.mobile_packing_enabled !== 1 ||
      row.user_credential_revision !== row.user.credential_revision ||
      row.instance_epoch !== serverInstanceEpoch)
  ) {
    return "REAUTH_REQUIRED" as const;
  }
  return row.registration_state as MobileRegistrationState;
}

function toMobileDeviceDto(
  row: NonNullable<MobileDeviceRow>,
  serverInstanceEpoch: number
) {
  return {
    deviceId: row.device_id,
    registrationRevision: row.registration_revision,
    registrationState: effectiveState(row, serverInstanceEpoch),
    userId: row.user_id,
    username: row.user.username,
    displayName: row.user.employee_profiles?.display_name ?? row.user.username,
    userMobilePackingEnabled: row.user.mobile_packing_enabled === 1,
    label: row.label ?? "",
    adbSerialPreview: row.adb_serial_preview,
    publicKeyFingerprint: row.device_public_key_fingerprint ?? "",
    provisioningExpiresAt: apiDateTime(row.provisioning_expires_at) ?? "",
    activatedAt: apiDateTime(row.activated_at) ?? "",
    lastSeenAt: apiDateTime(row.last_seen_at) ?? "",
    revokedAt: apiDateTime(row.revoked_at) ?? "",
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function auditSnapshot(row: NonNullable<MobileDeviceRow>, epoch: number) {
  const dto = toMobileDeviceDto(row, epoch);
  return {
    deviceId: dto.deviceId,
    registrationRevision: dto.registrationRevision,
    registrationState: dto.registrationState,
    userId: dto.userId,
    label: dto.label ? "set" : "cleared",
    adbSerialPreview: dto.adbSerialPreview,
    publicKeyFingerprint: dto.publicKeyFingerprint,
    provisioningExpiresAt: dto.provisioningExpiresAt,
    activatedAt: dto.activatedAt,
    revokedAt: dto.revokedAt,
  };
}

async function writeLog(
  tx: MobileDeviceClient,
  input: {
    actorUserId: number;
    actionType: string;
    deviceId: number;
    beforeValue: unknown;
    afterValue: unknown;
  }
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: input.actorUserId,
      action_type: input.actionType,
      target_type: "MOBILE_REGISTERED_DEVICE",
      target_id: String(input.deviceId),
      ...activityLogChangeData(input.beforeValue, input.afterValue),
      result: "SUCCESS",
      created_at: quickHackClock.nowDate(),
    },
  });
}

async function authorizeMutation(
  tx: Prisma.TransactionClient,
  context: MobileRegistrationSecurityContext,
  targetUserId: number,
  options: { requirePackingPermission: boolean; requireActiveAccount: boolean }
) {
  let serverState: { instance_epoch: number };
  let actorUserId: number;

  if (context.scope === "ACCOUNT_MANAGEMENT") {
    const authorization = await authorizeAccountMutation(tx, context);
    serverState = authorization.serverState;
    actorUserId = authorization.actor.user_id;
  } else {
    serverState = await lockServerSecurityState(tx);
    const session = await tx.user_sessions.findUnique({
      where: { session_id: context.sessionId },
      include: { users: true },
    });
    const now = databaseNow();
    if (
      !session ||
      session.expires_at <= now ||
      session.instance_epoch !== serverState.instance_epoch ||
      session.credential_revision !== session.users.credential_revision ||
      session.users.is_active !== 1 ||
      session.users.must_change_password === 1 ||
      session.user_id !== context.actor.userId ||
      targetUserId !== context.actor.userId
    ) {
      throw publicConflict(
        "MOBILE_AUTHORIZATION_CHANGED",
        "MOBILE_AUTHORIZATION_CHANGED"
      );
    }
    actorUserId = session.user_id;
  }

  const locked = await tx.$queryRaw<
    Array<{
      user_id: number;
      username: string;
      is_active: number;
      mobile_packing_enabled: number;
      credential_revision: number;
    }>
  >`
    SELECT user_id, username, is_active, mobile_packing_enabled, credential_revision
    FROM users
    WHERE user_id = ${targetUserId}
    FOR UPDATE
  `;
  const target = locked[0];
  if (!target) {
    throw publicNotFound("MOBILE_DEVICE_ACCOUNT_NOT_FOUND", "MOBILE_DEVICE_ACCOUNT_NOT_FOUND");
  }
  if (options.requireActiveAccount && target.is_active !== 1) {
    throw publicConflict("MOBILE_DEVICE_ACCOUNT_INACTIVE", "MOBILE_DEVICE_ACCOUNT_INACTIVE");
  }
  if (options.requirePackingPermission && target.mobile_packing_enabled !== 1) {
    throw publicConflict(
      "MOBILE_DEVICE_PERMISSION_REQUIRED",
      "MOBILE_DEVICE_PERMISSION_REQUIRED"
    );
  }
  return { serverState, actorUserId, target };
}

export async function listMobileRegisteredDevices(
  input: { userId?: number | null; cursor?: unknown; limit?: unknown } = {}
) {
  const userId = input.userId ?? null;
  const limit = normalizeKeysetLimit(input.limit, { defaultLimit: 50, maxLimit: 100 });
  const queryIdentity = { userId };
  const cursorText = cleanText(input.cursor);
  const decoded = cursorText
    ? decodeKeysetCursor<{ maxDeviceId: number }, { deviceId: number }>({
        cursor: cursorText,
        contract: LIST_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  const newest = decoded
    ? decoded.snapshot.maxDeviceId
    : (
        await prisma.mobile_registered_devices.findFirst({
          where: userId ? { user_id: userId } : undefined,
          select: { device_id: true },
          orderBy: { device_id: "desc" },
        })
      )?.device_id ?? 0;
  const where: Prisma.mobile_registered_devicesWhereInput = {
    ...(userId ? { user_id: userId } : {}),
    device_id: {
      lte: newest,
      ...(decoded ? { lt: decoded.position.deviceId } : {}),
    },
  };
  const [rows, totalCount, activeCount, serverState] = await Promise.all([
    prisma.mobile_registered_devices.findMany({
      where,
      include: {
        user: {
          select: {
            user_id: true,
            username: true,
            is_active: true,
            credential_revision: true,
            mobile_packing_enabled: true,
            employee_profiles: { select: { display_name: true } },
          },
        },
      },
      orderBy: { device_id: "desc" },
      take: limit + 1,
    }),
    prisma.mobile_registered_devices.count({
      where: {
        ...(userId ? { user_id: userId } : {}),
        device_id: { lte: newest },
      },
    }),
    prisma.mobile_registered_devices.count({
      where: {
        ...(userId ? { user_id: userId } : {}),
        registration_state: { in: ["PROVISIONING", "ACTIVE"] },
      },
    }),
    prisma.server_instance_state.findUniqueOrThrow({
      where: { singleton_key: "QUICKHACK" },
      select: { instance_epoch: true },
    }),
  ]);
  const dtoRows = rows.map((row) => toMobileDeviceDto(row, serverState.instance_epoch));
  return {
    ...createKeysetPage({
    rows: dtoRows,
    limit,
    coverage: "COMPLETE",
    totalCount,
    cursorFor: (last) =>
      encodeKeysetCursor({
        contract: LIST_CURSOR_CONTRACT,
        queryIdentity,
        snapshot: { maxDeviceId: newest },
        position: { deviceId: last.deviceId },
      }),
    }),
    activeCount,
  };
}

export async function beginMobileDeviceProvisioning(
  input: {
    userId: unknown;
    adbSerial: unknown;
    label?: unknown;
    deviceId?: unknown;
    expectedRegistrationRevision?: unknown;
  },
  context: MobileRegistrationSecurityContext,
  keyAccess?: MobileSerialHmacKeyAccess
) {
  const userId = positiveInt(input.userId, "등록 계정");
  const serial = normalizeAdbSerial(input.adbSerial);
  if (!serial) throw publicBadRequest("ADB_SERIAL_REQUIRED", "ADB_SERIAL_REQUIRED");
  const deviceId = input.deviceId == null ? null : positiveInt(input.deviceId, "기기");
  const expectedRevision =
    deviceId === null
      ? null
      : nonNegativeInt(input.expectedRegistrationRevision, "기기 등록 revision");
  const hmac = await serialHmac(serial, keyAccess);
  const preview = maskSerial(serial);
  const provisioningToken = randomToken();
  const tokenHash = provisioningTokenHash(provisioningToken);
  const expiresAt = addSeconds(quickHackClock.nowDate(), PROVISIONING_TTL_SECONDS);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const auth = await authorizeMutation(tx, context, userId, {
        requirePackingPermission: true,
        requireActiveAccount: true,
      });
      const now = quickHackClock.nowDate();
      let row: NonNullable<MobileDeviceRow>;
      let before: NonNullable<MobileDeviceRow> | null = null;

      if (deviceId !== null) {
        await tx.$queryRaw`SELECT device_id FROM mobile_registered_devices WHERE device_id = ${deviceId} FOR UPDATE`;
        before = await findMobileDeviceForDto(deviceId, tx);
        if (!before || before.user_id !== userId) {
          throw publicNotFound("MOBILE_DEVICE_NOT_FOUND", "MOBILE_DEVICE_NOT_FOUND");
        }
        if (before.registration_revision !== expectedRevision) {
          throw publicConflict("MOBILE_DEVICE_CHANGED", "MOBILE_DEVICE_CHANGED");
        }
        if (before.registration_state === "REVOKED") {
          throw publicConflict("MOBILE_DEVICE_REVOKED", "MOBILE_DEVICE_REVOKED");
        }
        if (before.adb_serial_hmac !== hmac) {
          throw publicConflict("MOBILE_DEVICE_PHYSICAL_MISMATCH", "MOBILE_DEVICE_PHYSICAL_MISMATCH");
        }
        row = await tx.mobile_registered_devices.update({
          where: { device_id: deviceId },
          data: {
            registration_revision: { increment: 1 },
            registration_state: "PROVISIONING",
            provisioning_token_hash: tokenHash,
            provisioning_expires_at: expiresAt,
            label: optionalText(input.label) ?? before.label,
            app_instance_id_hash: null,
            device_public_key_spki: null,
            device_public_key_fingerprint: null,
            device_token_hash: null,
            user_credential_revision: null,
            instance_epoch: null,
            activated_at: null,
            last_seen_at: null,
            registered_by_user_id: auth.actorUserId,
            updated_at: now,
          },
          include: { user: { select: { user_id: true, username: true, is_active: true, credential_revision: true, mobile_packing_enabled: true, employee_profiles: { select: { display_name: true } } } } },
        });
      } else {
        row = await tx.mobile_registered_devices.create({
          data: {
            user_id: userId,
            label: optionalText(input.label) ?? `${auth.target.username} ${preview}`,
            adb_serial_hmac: hmac,
            adb_serial_preview: preview,
            registration_state: "PROVISIONING",
            provisioning_token_hash: tokenHash,
            provisioning_expires_at: expiresAt,
            registered_by_user_id: auth.actorUserId,
            created_at: now,
            updated_at: now,
          },
          include: { user: { select: { user_id: true, username: true, is_active: true, credential_revision: true, mobile_packing_enabled: true, employee_profiles: { select: { display_name: true } } } } },
        });
      }

      await writeLog(tx, {
        actorUserId: auth.actorUserId,
        actionType: deviceId === null ? "MOBILE_DEVICE_PROVISION_BEGIN" : "MOBILE_DEVICE_REPROVISION_BEGIN",
        deviceId: row.device_id,
        beforeValue: before ? auditSnapshot(before, auth.serverState.instance_epoch) : null,
        afterValue: auditSnapshot(row, auth.serverState.instance_epoch),
      });
      return { row, instanceEpoch: auth.serverState.instance_epoch };
    });

    return {
      item: toMobileDeviceDto(result.row, result.instanceEpoch),
      bootstrap: {
        version: 1,
        deviceId: result.row.device_id,
        registrationRevision: result.row.registration_revision,
        provisioningToken,
        provisioningExpiresAt: requiredApiDateTime(expiresAt),
      },
    };
  } catch (error) {
    if (isPostgresqlUniqueViolation(error)) {
      throw publicConflict(
        "MOBILE_DEVICE_ALREADY_REGISTERED",
        "MOBILE_DEVICE_ALREADY_REGISTERED"
      );
    }
    throw error;
  }
}

export async function cancelMobileDeviceProvisioning(
  input: { deviceId: unknown; expectedRegistrationRevision: unknown; provisioningToken: unknown },
  context: MobileRegistrationSecurityContext
) {
  const deviceId = positiveInt(input.deviceId, "기기");
  const expectedRevision = nonNegativeInt(input.expectedRegistrationRevision, "기기 등록 revision");
  const tokenHash = provisioningTokenHash(randomCredential(input.provisioningToken, "USB 등록 토큰"));
  return prisma.$transaction(async (tx) => {
    const discovered = await tx.mobile_registered_devices.findUnique({
      where: { device_id: deviceId },
      select: { user_id: true },
    });
    if (!discovered) throw publicNotFound("MOBILE_DEVICE_NOT_FOUND", "MOBILE_DEVICE_NOT_FOUND");
    const auth = await authorizeMutation(tx, context, discovered.user_id, {
      requirePackingPermission: false,
      requireActiveAccount: false,
    });
    await tx.$queryRaw`SELECT device_id FROM mobile_registered_devices WHERE device_id = ${deviceId} FOR UPDATE`;
    const before = await findMobileDeviceForDto(deviceId, tx);
    if (!before) throw publicNotFound("MOBILE_DEVICE_NOT_FOUND", "MOBILE_DEVICE_NOT_FOUND");
    if (
      before.registration_state !== "PROVISIONING" ||
      before.registration_revision !== expectedRevision ||
      before.provisioning_token_hash !== tokenHash
    ) {
      throw publicConflict("MOBILE_DEVICE_CHANGED", "MOBILE_DEVICE_CHANGED");
    }
    const now = quickHackClock.nowDate();
    const row = await tx.mobile_registered_devices.update({
      where: { device_id: deviceId },
      data: {
        registration_revision: { increment: 1 },
        registration_state: "REVOKED",
        provisioning_token_hash: null,
        provisioning_expires_at: null,
        device_token_hash: null,
        revoked_by_user_id: auth.actorUserId,
        revoked_at: now,
        updated_at: now,
      },
      include: { user: { select: { user_id: true, username: true, is_active: true, credential_revision: true, mobile_packing_enabled: true, employee_profiles: { select: { display_name: true } } } } },
    });
    await writeLog(tx, {
      actorUserId: auth.actorUserId,
      actionType: "MOBILE_DEVICE_PROVISION_CANCEL",
      deviceId,
      beforeValue: auditSnapshot(before, auth.serverState.instance_epoch),
      afterValue: auditSnapshot(row, auth.serverState.instance_epoch),
    });
    return toMobileDeviceDto(row, auth.serverState.instance_epoch);
  });
}

export async function revokeMobileDevice(
  input: { deviceId: unknown; expectedRegistrationRevision: unknown },
  context: MobileRegistrationSecurityContext
) {
  const deviceId = positiveInt(input.deviceId, "기기");
  const expectedRevision = nonNegativeInt(input.expectedRegistrationRevision, "기기 등록 revision");
  return prisma.$transaction(async (tx) => {
    const discovered = await tx.mobile_registered_devices.findUnique({
      where: { device_id: deviceId },
      select: { user_id: true },
    });
    if (!discovered) throw publicNotFound("MOBILE_DEVICE_NOT_FOUND", "MOBILE_DEVICE_NOT_FOUND");
    const auth = await authorizeMutation(tx, context, discovered.user_id, {
      requirePackingPermission: false,
      requireActiveAccount: false,
    });
    await tx.$queryRaw`SELECT device_id FROM mobile_registered_devices WHERE device_id = ${deviceId} FOR UPDATE`;
    const before = await findMobileDeviceForDto(deviceId, tx);
    if (!before) throw publicNotFound("MOBILE_DEVICE_NOT_FOUND", "MOBILE_DEVICE_NOT_FOUND");
    if (before.registration_revision !== expectedRevision) {
      throw publicConflict("MOBILE_DEVICE_CHANGED", "MOBILE_DEVICE_CHANGED");
    }
    if (before.registration_state === "REVOKED") {
      throw publicConflict("MOBILE_DEVICE_REVOKED", "MOBILE_DEVICE_REVOKED");
    }
    const now = quickHackClock.nowDate();
    const row = await tx.mobile_registered_devices.update({
      where: { device_id: deviceId },
      data: {
        registration_revision: { increment: 1 },
        registration_state: "REVOKED",
        provisioning_token_hash: null,
        provisioning_expires_at: null,
        device_token_hash: null,
        revoked_by_user_id: auth.actorUserId,
        revoked_at: now,
        updated_at: now,
      },
      include: { user: { select: { user_id: true, username: true, is_active: true, credential_revision: true, mobile_packing_enabled: true, employee_profiles: { select: { display_name: true } } } } },
    });
    await writeLog(tx, {
      actorUserId: auth.actorUserId,
      actionType: "MOBILE_DEVICE_REVOKE",
      deviceId,
      beforeValue: auditSnapshot(before, auth.serverState.instance_epoch),
      afterValue: auditSnapshot(row, auth.serverState.instance_epoch),
    });
    return toMobileDeviceDto(row, auth.serverState.instance_epoch);
  });
}

export async function activateMobileDevice(
  input: {
    deviceId?: unknown;
    registrationRevision?: unknown;
    provisioningToken?: unknown;
    appInstanceId?: unknown;
    clientId?: unknown;
    deviceToken?: unknown;
    devicePublicKeySpki?: unknown;
    signature?: unknown;
  },
  context: MobileRegistrationSecurityContext
) {
  if (context.scope !== "SELF") throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  const deviceId = positiveInt(input.deviceId, "기기");
  const expectedRevision = nonNegativeInt(input.registrationRevision, "기기 등록 revision");
  const provisioningToken = randomCredential(input.provisioningToken, "USB 등록 토큰");
  const appInstanceId = cleanText(input.appInstanceId ?? input.clientId);
  const deviceToken = randomCredential(input.deviceToken, "기기 토큰");
  if (!appInstanceId) {
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  }
  const proof = verifyRegistrationProof({
    deviceId,
    registrationRevision: expectedRevision,
    provisioningToken,
    appInstanceId,
    deviceToken,
    devicePublicKeySpki: input.devicePublicKeySpki,
    signature: input.signature,
  });
  const provisionHash = provisioningTokenHash(provisioningToken);
  const appHash = appInstanceHash(appInstanceId);
  const tokenHash = deviceTokenHash(deviceToken);

  return prisma.$transaction(async (tx) => {
    const auth = await authorizeMutation(tx, context, context.actor.userId, {
      requirePackingPermission: true,
      requireActiveAccount: true,
    });
    await tx.$queryRaw`SELECT device_id FROM mobile_registered_devices WHERE device_id = ${deviceId} FOR UPDATE`;
    const before = await findMobileDeviceForDto(deviceId, tx);
    if (!before || before.user_id !== context.actor.userId) {
      throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
    }

    if (
      before.registration_state === "ACTIVE" &&
      before.registration_revision === expectedRevision + 1 &&
      before.provisioning_token_hash === provisionHash &&
      before.app_instance_id_hash === appHash &&
      before.device_token_hash === tokenHash &&
      before.device_public_key_fingerprint === proof.fingerprint &&
      before.user_credential_revision === auth.target.credential_revision &&
      before.instance_epoch === auth.serverState.instance_epoch
    ) {
      return { ...toMobileDeviceDto(before, auth.serverState.instance_epoch), deviceToken };
    }

    if (
      before.registration_state !== "PROVISIONING" ||
      before.registration_revision !== expectedRevision ||
      before.provisioning_token_hash !== provisionHash
    ) {
      throw publicConflict(
        "MOBILE_DEVICE_PROVISIONING_INVALIDATED",
        "MOBILE_DEVICE_PROVISIONING_INVALIDATED"
      );
    }

    if (
      !before.provisioning_expires_at ||
      before.provisioning_expires_at <= databaseNow()
    ) {
      throw publicConflict(
        "MOBILE_DEVICE_PROVISIONING_EXPIRED",
        "MOBILE_DEVICE_PROVISIONING_EXPIRED"
      );
    }

    let row: NonNullable<MobileDeviceRow>;
    try {
      row = await tx.mobile_registered_devices.update({
        where: { device_id: deviceId },
        data: {
          registration_revision: { increment: 1 },
          registration_state: "ACTIVE",
          app_instance_id_hash: appHash,
          device_public_key_spki: proof.spki,
          device_public_key_fingerprint: proof.fingerprint,
          device_token_hash: tokenHash,
          user_credential_revision: auth.target.credential_revision,
          instance_epoch: auth.serverState.instance_epoch,
          activated_at: quickHackClock.nowDate(),
          last_seen_at: quickHackClock.nowDate(),
          updated_at: quickHackClock.nowDate(),
        },
        include: { user: { select: { user_id: true, username: true, is_active: true, credential_revision: true, mobile_packing_enabled: true, employee_profiles: { select: { display_name: true } } } } },
      });
    } catch (error) {
      if (isPostgresqlUniqueViolation(error)) {
        throw publicConflict("MOBILE_DEVICE_KEY_ALREADY_REGISTERED", "MOBILE_DEVICE_KEY_ALREADY_REGISTERED");
      }
      throw error;
    }

    await writeLog(tx, {
      actorUserId: auth.actorUserId,
      actionType: "MOBILE_DEVICE_ACTIVATE",
      deviceId,
      beforeValue: auditSnapshot(before, auth.serverState.instance_epoch),
      afterValue: auditSnapshot(row, auth.serverState.instance_epoch),
    });
    return { ...toMobileDeviceDto(row, auth.serverState.instance_epoch), deviceToken };
  });
}

export async function requireMobilePackingDeviceInTransaction(
  tx: Prisma.TransactionClient,
  input: { clientId?: unknown; appInstanceId?: unknown; deviceToken?: unknown },
  context: MobileRegistrationSecurityContext
) {
  if (context.scope !== "SELF") throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  const appInstanceId = cleanText(input.appInstanceId ?? input.clientId);
  const deviceToken = cleanText(input.deviceToken);
  if (!appInstanceId || !deviceToken) {
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  }
  const auth = await authorizeMutation(tx, context, context.actor.userId, {
    requirePackingPermission: true,
    requireActiveAccount: true,
  });
  const tokenHash = deviceTokenHash(deviceToken);
  const matches = await tx.$queryRaw<Array<{ device_id: number }>>`
    SELECT device_id
    FROM mobile_registered_devices
    WHERE device_token_hash = ${tokenHash}
    FOR UPDATE
  `;
  if (matches.length !== 1) {
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  }
  const row = await findMobileDeviceForDto(matches[0].device_id, tx);
  if (
    !row ||
    row.registration_state !== "ACTIVE" ||
    row.user_id !== context.actor.userId ||
    row.app_instance_id_hash !== appInstanceHash(appInstanceId) ||
    row.user_credential_revision !== auth.target.credential_revision ||
    row.instance_epoch !== auth.serverState.instance_epoch
  ) {
    throw new MobileDeviceAuthError("MOBILE_DEVICE_AUTH_FAILED");
  }
  const now = quickHackClock.nowDate();
  const updated = await tx.mobile_registered_devices.update({
    where: { device_id: row.device_id },
    data: { last_seen_at: now, updated_at: now },
    include: { user: { select: { user_id: true, username: true, is_active: true, credential_revision: true, mobile_packing_enabled: true, employee_profiles: { select: { display_name: true } } } } },
  });
  return toMobileDeviceDto(updated, auth.serverState.instance_epoch);
}

export function mobileDeviceErrorStatus(error: unknown) {
  return error instanceof MobileDeviceAuthError ? error.status : 400;
}
