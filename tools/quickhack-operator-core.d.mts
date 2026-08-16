export const QUICKHACK_OPERATOR_COMMANDS: readonly string[];
export function readConsoleActionToken(dataDirectory: string): string;
export function callLocalServerConsole(dataDirectory: string, pathname: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function createQuickHackOperator(dependencies: Record<string, unknown>): Readonly<{ execute(input: Record<string, unknown> & { command: string }): Promise<Readonly<{ command: string; state: "COMPLETED"; result: unknown }>> }>;
