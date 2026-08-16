import type { ServerSecretProtector } from "../contracts.ts";

export const linuxServerSecretProtectionMetadata: ServerSecretProtector["metadata"];
export function createLinuxServerSecretProtector(options?: {
  platform?: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  reader?: Readonly<{
    read(identity: Parameters<ServerSecretProtector["readProvisioned"]>[0]): Promise<Buffer>;
    readSync(identity: Parameters<ServerSecretProtector["readProvisionedSync"]>[0]): Buffer;
  }>;
}): ServerSecretProtector;
export const linuxServerSecretProtector: ServerSecretProtector;
