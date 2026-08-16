import type { ServiceKind, ServiceLifecycleSnapshot, ServiceOperation } from "../../../quickhack_shared/platform/service-lifecycle-contract.mjs";

export const SYSTEMCTL_EXECUTABLE: "/usr/bin/systemctl";
export class SystemdServiceProcessError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export function createSystemdServiceProcess(options?: Record<string, unknown>): Readonly<{
  executable: string;
  units: Readonly<Record<ServiceKind, string>>;
  status(serviceKind: ServiceKind): Promise<ServiceLifecycleSnapshot>;
  operate(operation: ServiceOperation, serviceKind: ServiceKind): Promise<Readonly<{ operation: ServiceOperation; changed: boolean; snapshot: ServiceLifecycleSnapshot }>>;
}>;
