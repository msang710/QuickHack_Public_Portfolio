export class PostgresqlServiceCoreError extends Error {
  readonly code: string;
  readonly journal: readonly Readonly<{ step: string; state: string }>[];
  constructor(code: string, message: string, options?: ErrorOptions & { journal?: readonly Readonly<{ step: string; state: string }>[] });
}
export function createPostgresqlServiceCore(adapter: Record<string, (...args: never[]) => unknown>): Readonly<{
  installOrRepair(input: Record<string, unknown>): Promise<Readonly<{
    fresh: boolean;
    flavor: "OPERATIONAL" | "DEMONSTRATION";
    roles: number;
    databases: number;
    serviceName: string;
    clusterDirectory: string;
    journal: readonly Readonly<{ step: string; state: string }>[];
  }>>;
}>;
