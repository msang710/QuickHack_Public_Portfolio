export function prepareOperatorOneShotRequest(operation: string, input: Record<string, unknown>, runtimeConfig: Record<string, unknown>): void;
export function createDirectOperatorOneShot(options: Record<string, unknown>): Readonly<{ execute(operation: string, input: Record<string, unknown>): Promise<Readonly<{ operation: string; state: "COMPLETED" }>> }>;
