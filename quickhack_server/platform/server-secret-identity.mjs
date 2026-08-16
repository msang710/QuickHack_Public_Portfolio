import {
  assertPackageFlavor,
  createPostgresqlPackageManifest,
} from "../../quickhack_shared/core/package-flavor-contract.mjs";
import { assertServerSecretKind } from "./server-secret-contract.mjs";

export const SERVER_SECRET_LIFECYCLES = Object.freeze([
  "OPAQUE_PAYLOAD",
  "ACTIVATION_CREDENTIAL",
]);

export const SERVER_SECRET_CONSUMER_CLASSES = Object.freeze([
  "LONG_LIVED_APPLICATION",
  "PRIVILEGED_ONE_SHOT",
  "DEMONSTRATION_MOCK",
]);

const BASE_IDENTITIES = Object.freeze({
  OTP_MASTER_KEY: Object.freeze({
    id: "quickhack.otp-master-key",
    kind: "OTP_MASTER_KEY",
    consumerClass: "LONG_LIVED_APPLICATION",
    maxBytes: 32,
    generationGuard: "NO_EXISTING_TOTP_CREDENTIALS",
    recovery: "RESET_AFTER_OTP_CREDENTIALS_CLEARED",
  }),
  BACKUP_MASTER_KEY: Object.freeze({
    id: "quickhack.backup-master-key",
    kind: "BACKUP_MASTER_KEY",
    consumerClass: "LONG_LIVED_APPLICATION",
    maxBytes: 32,
    generationGuard: "NO_EXISTING_BACKUP_ARTIFACTS",
    recovery: "RESTORE_FROM_RECOVERY_ENVELOPE",
  }),
  MOBILE_SERIAL_HMAC: Object.freeze({
    id: "quickhack.mobile-serial-hmac",
    kind: "MOBILE_SERIAL_HMAC",
    consumerClass: "LONG_LIVED_APPLICATION",
    maxBytes: 32,
    generationGuard: "NO_LIVE_MOBILE_REGISTRATIONS",
    recovery: "RE_REGISTER_MOBILE_DEVICES",
  }),
  QHKEY_MASTER_KEY: Object.freeze({
    id: "quickhack.qhkey-master-key",
    kind: "QHKEY_MASTER_KEY",
    consumerClass: "LONG_LIVED_APPLICATION",
    maxBytes: 32,
    generationGuard: "NO_EXISTING_QHKEY_PAYLOADS",
    recovery: "RESTORE_OR_REISSUE_QHKEY_CREDENTIALS",
  }),
});

const POSTGRESQL_IDENTITY_SUFFIXES = Object.freeze({
  operator: "operator",
  migrator: "migrator",
  runtime: "runtime",
  backup: "backup",
  coupangMock: "coupang-mock",
  logenMock: "logen-mock",
});

const POSTGRESQL_CONSUMER_CLASSES = Object.freeze({
  operator: "PRIVILEGED_ONE_SHOT",
  migrator: "PRIVILEGED_ONE_SHOT",
  runtime: "LONG_LIVED_APPLICATION",
  backup: "LONG_LIVED_APPLICATION",
  coupangMock: "DEMONSTRATION_MOCK",
  logenMock: "DEMONSTRATION_MOCK",
});

function fail(code, message) {
  const error = new Error(message);
  error.name = "ServerSecretIdentityError";
  error.code = code;
  throw error;
}

function postgresqlIdentity(role) {
  const suffix = POSTGRESQL_IDENTITY_SUFFIXES[role.kind];
  if (!suffix) {
    fail(
      "SERVER_SECRET_IDENTITY_INVALID",
      "The PostgreSQL credential role is not a finite QuickHack identity."
    );
  }
  return Object.freeze({
    id: `quickhack.postgresql.${suffix}`,
    kind: "POSTGRESQL_CREDENTIAL",
    postgresqlRole: role.kind,
    consumerClass: role.consumerClass,
    maxBytes: 4 * 1024,
    generationGuard: "PRIVILEGED_ROTATION_ONLY",
    recovery: "ROTATE_POSTGRESQL_ROLE_CREDENTIAL",
  });
}

export function createServerSecretIdentityManifest(runtimeConfig) {
  const packageFlavor = assertPackageFlavor(runtimeConfig?.packageFlavor);
  const postgresql = createPostgresqlPackageManifest(runtimeConfig);
  const identities = [
    ...Object.values(BASE_IDENTITIES),
    ...postgresql.roles.map(postgresqlIdentity),
  ];
  return Object.freeze({
    packageFlavor,
    identities: Object.freeze(identities),
  });
}

export function serverSecretIdentity(input) {
  const kind = assertServerSecretKind(input?.kind);
  if (kind !== "POSTGRESQL_CREDENTIAL") return BASE_IDENTITIES[kind];
  const manifest = createServerSecretIdentityManifest(input?.runtimeConfig);
  const postgresqlRole = String(input?.postgresqlRole ?? "").trim();
  const identity = manifest.identities.find(
    (candidate) => candidate.postgresqlRole === postgresqlRole
  );
  if (!identity) {
    fail(
      "SERVER_SECRET_IDENTITY_NOT_IN_PACKAGE",
      "The requested PostgreSQL credential identity is not present in this package flavor."
    );
  }
  return identity;
}

export function assertServerSecretIdentity(value) {
  const id = String(value?.id ?? "").trim();
  const kind = assertServerSecretKind(value?.kind);
  if (!/^quickhack\.[a-z0-9.-]+$/u.test(id)) {
    fail("SERVER_SECRET_IDENTITY_INVALID", "The server secret identity is invalid.");
  }
  if (!SERVER_SECRET_CONSUMER_CLASSES.includes(value?.consumerClass)) {
    fail(
      "SERVER_SECRET_IDENTITY_INVALID",
      "The server secret consumer class is invalid."
    );
  }
  if (!Number.isSafeInteger(value?.maxBytes) || value.maxBytes < 1) {
    fail(
      "SERVER_SECRET_IDENTITY_INVALID",
      "The server secret payload limit is invalid."
    );
  }
  let canonical = Object.values(BASE_IDENTITIES).find(
    (candidate) => candidate.id === id && candidate.kind === kind
  );
  if (!canonical && kind === "POSTGRESQL_CREDENTIAL") {
    const postgresqlRole = String(value?.postgresqlRole ?? "").trim();
    if (
      Object.hasOwn(POSTGRESQL_CONSUMER_CLASSES, postgresqlRole) &&
      id ===
        `quickhack.postgresql.${POSTGRESQL_IDENTITY_SUFFIXES[postgresqlRole]}`
    ) {
      canonical = postgresqlIdentity({
        kind: postgresqlRole,
        consumerClass: POSTGRESQL_CONSUMER_CLASSES[postgresqlRole],
      });
    }
  }
  if (
    !canonical ||
    canonical.consumerClass !== value.consumerClass ||
    canonical.maxBytes !== value.maxBytes ||
    canonical.generationGuard !== value.generationGuard ||
    canonical.recovery !== value.recovery
  ) {
    fail(
      "SERVER_SECRET_IDENTITY_INVALID",
      "The server secret identity is not a finite QuickHack identity."
    );
  }
  return canonical;
}
