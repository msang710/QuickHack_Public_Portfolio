import crypto from "node:crypto";
import { composeServerPlatform } from "../platform/compose-server-platform.ts";

function activeProvider() {
  return composeServerPlatform().qhkeyMasterKey;
}

export function generateQhkeyMasterKey() {
  return crypto.randomBytes(32);
}

export function readQhkeyMasterKeyFile(filePath) {
  return activeProvider().readSync({ filePath });
}

export function readQhkeyMasterKeyFileAsync(filePath) {
  return activeProvider().read({ filePath });
}

export function writeQhkeyMasterKeyFile(filePath, force = false, options = {}) {
  const provider = activeProvider();
  if (typeof provider.write !== "function") {
    throw new Error(
      "QHKEY master key provisioning is owned by the operating system on this platform."
    );
  }
  provider.write({
    filePath,
    force,
    protection: options.protection,
  });
}

export function getQhkeyMasterKeyFileProtection(filePath) {
  const provider = activeProvider();
  if (typeof provider.protectionSync !== "function") {
    return provider.descriptor.platform === "linux"
      ? "SYSTEMD_CREDENTIAL"
      : "UNKNOWN";
  }
  return provider.protectionSync({ filePath });
}

export function getQhkeyMasterKeyFileProtectionAsync(filePath) {
  const provider = activeProvider();
  if (typeof provider.protection !== "function") {
    return Promise.resolve(
      provider.descriptor.platform === "linux"
        ? "SYSTEMD_CREDENTIAL"
        : "UNKNOWN"
    );
  }
  return provider.protection({ filePath });
}
