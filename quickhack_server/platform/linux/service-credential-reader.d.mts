import type { ServerSecretIdentity } from "../server-secret-identity.mjs";

export class LinuxServiceCredentialError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function createLinuxServiceCredentialReader(options?: {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform?: string;
  readFile?: (path: string) => Promise<Buffer>;
  lstat?: (path: string) => Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
  }>;
  readFileSync?: (path: string) => Buffer;
  lstatSync?: (path: string) => {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
  };
}): Readonly<{
  read(identity: ServerSecretIdentity): Promise<Buffer>;
  readSync(identity: ServerSecretIdentity): Buffer;
}>;
