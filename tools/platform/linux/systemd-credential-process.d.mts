export const SYSTEMD_CREDS_EXECUTABLE: "/usr/bin/systemd-creds";
export const SYSTEMD_CREDENTIAL_PROCESS_TIMEOUT_MS: number;

export class SystemdCredentialProcessError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function runSystemdCredentialProcess(
  args: readonly string[],
  options?: {
    executable?: "/usr/bin/systemd-creds";
    input?: Buffer;
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    spawnProcess?: (...args: unknown[]) => unknown;
  }
): Promise<Buffer>;
