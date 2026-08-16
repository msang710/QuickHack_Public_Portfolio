import { serverSecretIdentity } from "../../../quickhack_server/platform/server-secret-identity.mjs";
import { createSystemdCredentialProvisioner } from "./systemd-credential-provisioner.mjs";

export function createLinuxBackupMasterRecoveryOperator(options = {}) {
  const provisioner =
    options.provisioner ?? createSystemdCredentialProvisioner(options);
  const identity = serverSecretIdentity({ kind: "BACKUP_MASTER_KEY" });

  async function provision(key) {
    const prepared = await provisioner.prepare({ identity, secret: key });
    return provisioner.commit(prepared);
  }

  async function activate(committed, restartAndSmoke) {
    if (typeof restartAndSmoke !== "function") {
      throw new TypeError("A service restart and provider smoke callback is required.");
    }
    try {
      await restartAndSmoke({
        identityId: identity.id,
        generationId: committed.generationId,
      });
      return await provisioner.activate(committed);
    } catch (error) {
      await provisioner.rollback(committed);
      throw error;
    }
  }

  return Object.freeze({ provision, activate, identity });
}
