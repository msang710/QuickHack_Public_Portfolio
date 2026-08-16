export const ONE_SHOT_OPERATIONS: readonly ["MIGRATE", "RESTORE", "PROVISION_INITIAL_LEADER"];
export function createSystemdOneShotProcess(options?: Record<string, unknown>): Readonly<{ execute(operation: (typeof ONE_SHOT_OPERATIONS)[number]): Promise<Readonly<{ operation: string; unit: string; state: "COMPLETED"; result: string }>> }>;
