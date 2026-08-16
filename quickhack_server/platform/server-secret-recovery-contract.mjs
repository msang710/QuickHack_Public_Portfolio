import { assertServerSecretIdentity } from "./server-secret-identity.mjs";

export const SERVER_SECRET_ROTATION_STATES = Object.freeze([
  "PREPARED",
  "COMMITTED_RESTART_REQUIRED",
  "ACTIVE",
  "ROLLED_BACK",
]);

const RECOVERY_ACTIONS = Object.freeze({
  OTP_MASTER_KEY: "TOTP_RESET_REQUIRED",
  BACKUP_MASTER_KEY: "RECOVERY_BUNDLE_REQUIRED",
  POSTGRESQL_CREDENTIAL: "POSTGRESQL_ROLE_ROTATION_REQUIRED",
  MOBILE_SERIAL_HMAC: "MOBILE_REGISTRATION_RESET_REQUIRED",
});

export function serverSecretRecoveryAction(identityValue) {
  const identity = assertServerSecretIdentity(identityValue);
  return RECOVERY_ACTIONS[identity.kind];
}

export function createServerSecretRotationStatus(input) {
  const identity = assertServerSecretIdentity(input?.identity);
  const state = String(input?.state ?? "").trim();
  const generationId = String(input?.generationId ?? "").trim();
  if (!SERVER_SECRET_ROTATION_STATES.includes(state)) {
    throw new TypeError("The server secret rotation state is invalid.");
  }
  if (!/^[0-9a-f-]{36}$/iu.test(generationId)) {
    throw new TypeError("The server secret rotation generation is invalid.");
  }
  return Object.freeze({
    identityId: identity.id,
    state,
    generationId,
    restartRequired: state === "COMMITTED_RESTART_REQUIRED",
    recoveryAction: serverSecretRecoveryAction(identity),
  });
}
