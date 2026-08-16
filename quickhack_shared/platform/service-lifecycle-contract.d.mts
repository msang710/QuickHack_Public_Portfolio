export const SERVICE_KINDS: readonly ["POSTGRESQL", "APPLICATION"];
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_OPERATIONS: readonly ["INSTALL", "REPAIR", "START", "STOP", "RESTART", "STATUS"];
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];
export const SERVICE_STATES: readonly ["MISSING", "INACTIVE", "ACTIVATING", "ACTIVE", "DEACTIVATING", "FAILED", "UNKNOWN"];
export type ServiceState = (typeof SERVICE_STATES)[number];

export class ServiceLifecycleContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ServiceLifecycleSnapshot = Readonly<{
  serviceKind: ServiceKind;
  state: ServiceState;
  installed: boolean | null;
  enabled: boolean | null;
  mainPid: number | null;
  result: string;
  subState: string;
  recovery: Readonly<{ code: string; message: string }>;
}>;

export function assertServiceKind(value: unknown): ServiceKind;
export function assertServiceOperation(value: unknown): ServiceOperation;
export function assertServiceState(value: unknown): ServiceState;
export function serviceLifecycleSnapshot(input: Record<string, unknown>): ServiceLifecycleSnapshot;
export function serviceOperationResult(input: { operation: ServiceOperation; changed?: boolean; snapshot: Record<string, unknown> }): Readonly<{ operation: ServiceOperation; changed: boolean; snapshot: ServiceLifecycleSnapshot }>;
