import type { ServiceKind, ServiceLifecycleSnapshot, ServiceOperation } from "../../../quickhack_shared/platform/service-lifecycle-contract.mjs";
export function createWindowsServiceProcess(options?: Record<string, unknown>): Readonly<{
  serviceNames: Readonly<Record<ServiceKind, string>>;
  status(serviceKind: ServiceKind): Promise<ServiceLifecycleSnapshot>;
  operate(operation: ServiceOperation, serviceKind: ServiceKind): Promise<Readonly<{ operation: ServiceOperation; changed: boolean; snapshot: ServiceLifecycleSnapshot }>>;
}>;
