export type ServerConsoleComposition = Readonly<{
  flavor: "OPERATIONAL" | "DEMONSTRATION";
  childIds: readonly string[];
  startChildren(context: Record<string, unknown>): Promise<readonly unknown[]>;
  status(context: Record<string, unknown>): Promise<Readonly<{ ready: boolean } & Record<string, unknown>>>;
  renderHtml(messages: Readonly<Record<string, string>>): string;
  handleAction(pathname: string, context: Record<string, unknown>): Promise<Readonly<{ status?: number; payload: Record<string, unknown> }> | null>;
}>;
export function createServerConsole(input: Record<string, unknown> & { flavor: "OPERATIONAL" | "DEMONSTRATION"; integration: ServerConsoleComposition }): Readonly<Record<string, unknown>>;
export function runServerConsole(input: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>>;
