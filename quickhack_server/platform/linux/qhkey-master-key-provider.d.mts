import type { QhkeyMasterKeyProvider } from "../contracts.ts";
import type { ServerSecretIdentity } from "../server-secret-identity.mjs";

export type LinuxQhkeyMasterKeyProvider = QhkeyMasterKeyProvider & Readonly<{
  identity: ServerSecretIdentity;
}>;

export function createLinuxQhkeyMasterKeyProvider(options?: Record<string, unknown>): LinuxQhkeyMasterKeyProvider;
