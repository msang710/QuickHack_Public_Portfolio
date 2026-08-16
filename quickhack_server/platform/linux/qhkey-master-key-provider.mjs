import { QhkeyPlatformError } from "../qhkey-contract.mjs";
import { serverSecretIdentity } from "../server-secret-identity.mjs";
import { normalizeQhkeyMasterKey } from "../../security/qhkey-format.mjs";
import { createLinuxServiceCredentialReader } from "./service-credential-reader.mjs";

function descriptor(platform) {
  return Object.freeze({
    id: "qhkey-master-key-provider",
    role: "server",
    platform,
    state: "READY",
    ownerStage: "PR-08",
  });
}

function provisioningRequired() {
  return new QhkeyPlatformError(
    "QHKEY_MASTER_PROVISIONING_REQUIRED",
    "The QHKEY master key must be provisioned as a systemd activation credential."
  );
}

export function createLinuxQhkeyMasterKeyProvider(options = {}) {
  const platform = options.platform ?? "linux";
  const reader = options.reader ?? createLinuxServiceCredentialReader(options);
  const identity = serverSecretIdentity({ kind: "QHKEY_MASTER_KEY" });

  function normalize(value) {
    try {
      const key = normalizeQhkeyMasterKey(value);
      if (key !== value) value.fill(0);
      return key;
    } catch {
      value?.fill?.(0);
      throw provisioningRequired();
    }
  }

  async function read() {
    try {
      return normalize(await reader.read(identity));
    } catch (error) {
      if (error instanceof QhkeyPlatformError) throw error;
      throw provisioningRequired();
    }
  }

  function readSync() {
    try {
      return normalize(reader.readSync(identity));
    } catch (error) {
      if (error instanceof QhkeyPlatformError) throw error;
      throw provisioningRequired();
    }
  }

  async function status() {
    try {
      const key = await read();
      key.fill(0);
      return Object.freeze({
        available: true,
        protection: "SYSTEMD_CREDENTIAL",
        warningMessage: null,
        identityToken: identity.id,
        identityPaths: Object.freeze([]),
      });
    } catch {
      return Object.freeze({
        available: false,
        protection: "MISSING",
        warningMessage: null,
        identityToken: identity.id,
        identityPaths: Object.freeze([]),
      });
    }
  }

  async function ensure() {
    throw provisioningRequired();
  }

  return Object.freeze({
    descriptor: descriptor(platform),
    identity,
    read,
    readSync,
    status,
    ensure,
  });
}
