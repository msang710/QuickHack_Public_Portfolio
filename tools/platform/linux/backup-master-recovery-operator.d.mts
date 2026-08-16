import type { ServerSecretIdentity } from "../../../quickhack_server/platform/server-secret-identity.mjs";
import type { CommittedCredential } from "./systemd-credential-provisioner.mjs";
export function createLinuxBackupMasterRecoveryOperator(options?: Record<string, unknown>): Readonly<{
  identity: ServerSecretIdentity;
  provision(key: Buffer): Promise<CommittedCredential>;
  activate(
    committed: CommittedCredential,
    restartAndSmoke: (input: { identityId: string; generationId: string }) => Promise<void>
  ): Promise<Readonly<{ state: "ACTIVE"; generationId: string; identityId: string }>>;
}>;
