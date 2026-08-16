import type { ServerSecretIdentity } from "./server-secret-identity.mjs";

export const SERVER_SECRET_ROTATION_STATES: readonly [
  "PREPARED",
  "COMMITTED_RESTART_REQUIRED",
  "ACTIVE",
  "ROLLED_BACK"
];
export type ServerSecretRotationState =
  (typeof SERVER_SECRET_ROTATION_STATES)[number];
export type ServerSecretRecoveryAction =
  | "TOTP_RESET_REQUIRED"
  | "RECOVERY_BUNDLE_REQUIRED"
  | "POSTGRESQL_ROLE_ROTATION_REQUIRED"
  | "MOBILE_REGISTRATION_RESET_REQUIRED";

export function serverSecretRecoveryAction(
  identity: ServerSecretIdentity
): ServerSecretRecoveryAction;
export function createServerSecretRotationStatus(input: {
  identity: ServerSecretIdentity;
  state: ServerSecretRotationState;
  generationId: string;
}): Readonly<{
  identityId: string;
  state: ServerSecretRotationState;
  generationId: string;
  restartRequired: boolean;
  recoveryAction: ServerSecretRecoveryAction;
}>;
