import { createServerSecretProtectionMetadata } from "../server-secret-contract.mjs";
import { createLinuxServiceCredentialReader } from "./service-credential-reader.mjs";

export const linuxServerSecretProtectionMetadata =
  createServerSecretProtectionMetadata({
    protection: "SYSTEMD_CREDENTIAL_ENCRYPTED",
    identityScope: "SYSTEMD_SERVICE_UNIT",
    portable: false,
    formatVersion: 1,
    lifecycle: "ACTIVATION_CREDENTIAL",
  });

function unsupported() {
  const error = new Error(
    "Linux activation credentials must be provisioned by a privileged operator."
  );
  error.name = "LinuxServerSecretLifecycleError";
  error.code = "SERVER_SECRET_PRIVILEGED_PROVISIONING_REQUIRED";
  throw error;
}

export function createLinuxServerSecretProtector(options = {}) {
  const platform = options.platform ?? "linux";
  const reader = options.reader ?? createLinuxServiceCredentialReader(options);
  return Object.freeze({
    descriptor: Object.freeze({
      id: "server-secret-protector",
      role: "server",
      platform,
      state: "READY",
      ownerStage: "PR-06",
    }),
    metadata: linuxServerSecretProtectionMetadata,
    async protect(_kind, _secret) {
      return unsupported();
    },
    async unprotect(_kind, _payload) {
      return unsupported();
    },
    unprotectSync(_kind, _payload) {
      return unsupported();
    },
    readProvisioned(identity) {
      return reader.read(identity);
    },
    readProvisionedSync(identity) {
      return reader.readSync(identity);
    },
    async ensureDirectory(_directoryPath) {
      return unsupported();
    },
  });
}

export const linuxServerSecretProtector = createLinuxServerSecretProtector();
