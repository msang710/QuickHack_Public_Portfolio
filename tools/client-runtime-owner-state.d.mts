export type ClientRuntimeOwnerState = Readonly<{
  schemaVersion: 2;
  kind: "QUICKHACK_CLIENT_RUNTIME_OWNER";
  state: "PREPARED" | "CLAIMED";
  ownerToken: string;
  launcherPid: number;
  pid: number | null;
  port: number;
  clientUrl: string;
  serverUrl: string;
  caCertificateFile: string;
  instanceId: string;
  entry: string;
  runtimeMode: string;
  artifactKind: string;
  startedAt: string;
  payloadChecksum: string;
}>;
export type ClientRuntimeStateRead = Readonly<{
  status: "MISSING" | "VALID" | "LEGACY" | "INVALID";
  state: ClientRuntimeOwnerState | Record<string, unknown> | null;
  error?: unknown;
}>;
export function createClientRuntimeOwnerStateStore(options: Record<string, unknown>): Readonly<{
  statePath: string;
  read(): ClientRuntimeStateRead;
  publishPrepared(input: Record<string, unknown>): ClientRuntimeOwnerState;
  publishClaimed(prepared: ClientRuntimeOwnerState, pid: number): ClientRuntimeOwnerState;
  removeOwned(expected: Readonly<{ ownerToken: string; instanceId: string; pid?: number }>): boolean;
  recoverInactive(): boolean;
  adoptLegacy(observed: Record<string, unknown>): ClientRuntimeOwnerState;
  acquireCommandLock(): Readonly<{ ownerToken: string; release(): boolean }>;
}>;
export function assertObservedClientRuntimeOwnership(observed: Record<string, unknown>, stateResult: ClientRuntimeStateRead, isProcessRunning?: (pid: number) => boolean): ClientRuntimeOwnerState;
export function waitForClientRuntime<T>(predicate: () => T | Promise<T>, timeoutMs: number, intervalMs?: number): Promise<T | null>;
export function launchClientRuntimeWithOwnerState(options: Record<string, unknown>): Promise<Readonly<{ ready: unknown; state: ClientRuntimeOwnerState }>>;
export function readClientRuntimeOwnerStateFile(filename: string, fileSystem?: typeof import("node:fs")): ClientRuntimeOwnerState | null;
