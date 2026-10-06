export type ServerConsoleComposition = Readonly<{
  flavor: "OPERATIONAL" | "DEMONSTRATION";
  childIds: readonly string[];
  childPorts: Readonly<Record<string, number>>;
  probeChild(id: string, expectedInstanceId?: string): Promise<boolean>;
  startChild?(id: string, context: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>>;
  status(context: Record<string, unknown>): Promise<Readonly<{ ready: boolean } & Record<string, unknown>>>;
  renderHtml(messages: Readonly<Record<string, string>>): string;
  handleAction(pathname: string, context: Record<string, unknown>): Promise<Readonly<{ status?: number; payload: Record<string, unknown> }> | null>;
}>;
export function createServerConsole(input: Record<string, unknown> & { flavor: "OPERATIONAL" | "DEMONSTRATION"; integration: ServerConsoleComposition }): Readonly<Record<string, unknown>>;
export function renderServerConsolePage(input: { flavor: "OPERATIONAL" | "DEMONSTRATION"; actionToken: string; integrationHtml: string; locale: string; view?: string }): string;
export function runServerConsole(input: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>>;
