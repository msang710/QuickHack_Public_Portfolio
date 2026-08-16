export function createDefaultQuickHackOperator(options?: Record<string, unknown>): Readonly<{ execute(input: Record<string, unknown> & { command: string }): Promise<Record<string, unknown>> }>;
