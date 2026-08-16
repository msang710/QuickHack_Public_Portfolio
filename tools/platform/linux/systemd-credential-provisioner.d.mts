import type { ServerSecretIdentity } from "../../../quickhack_server/platform/server-secret-identity.mjs";

export const QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY: "/var/lib/quickhack/security";
export const SYSTEMD_PERSISTENT_HOST_KEY_PATH: "/var/lib/systemd/credential.secret";

export class SystemdCredentialProvisioningError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type PreparedCredential = Readonly<{
  state: "PREPARED";
  generationId: string;
  identityId: string;
  preparedPath: string;
  targetPath: string;
}>;
export type CommittedCredential = Readonly<{
  state: "COMMITTED_RESTART_REQUIRED";
  generationId: string;
  identityId: string;
  preparedPath: string;
  targetPath: string;
  previousExists: boolean;
  backupPath: string;
}>;

export function systemdCredentialCiphertextPath(identity: ServerSecretIdentity): string;
export function createSystemdCredentialProvisioner(options?: Record<string, unknown>): Readonly<{
  preflight(): Promise<Readonly<{
    version: number;
    keyMode: "AUTO_TPM2_OR_HOST" | "HOST_KEY_ONLY";
  }>>;
  prepare(input: { identity: ServerSecretIdentity; secret: Buffer }): Promise<PreparedCredential>;
  commit(token: PreparedCredential): Promise<CommittedCredential>;
  discard(token: PreparedCredential): Promise<Readonly<{
    state: "DISCARDED";
    generationId: string;
    identityId: string;
  }>>;
  activate(token: CommittedCredential): Promise<Readonly<{
    state: "ACTIVE";
    generationId: string;
    identityId: string;
  }>>;
  rollback(token: CommittedCredential): Promise<Readonly<{
    state: "ROLLED_BACK";
    generationId: string;
    identityId: string;
  }>>;
}>;
