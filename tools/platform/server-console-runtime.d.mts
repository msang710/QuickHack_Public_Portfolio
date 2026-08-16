export type ServerConsoleProcessResult = Readonly<{ ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null }>;
export type ServerConsoleRuntime = Readonly<{
  descriptor: Readonly<{ id: "server-console-runtime"; role: "operator"; platform: string; state: "READY" | "COMPATIBILITY"; ownerStage: "PR-09" }>;
  interactive: boolean;
  requiresExternalDatabaseOperations: boolean;
  childEnvironment(input?: { executableDirectories?: readonly string[]; overrides?: Record<string, string | number | boolean | undefined> }): NodeJS.ProcessEnv;
  execFileText(file: string, args: readonly string[], options?: Record<string, unknown>): Promise<ServerConsoleProcessResult>;
  timeStatus(): Promise<Readonly<{ ok: boolean; source: string; rawStatus: string; error: string }>>;
  portPids(port: number, options?: { strict?: boolean }): Promise<readonly number[]>;
  terminateOwnedProcess(pid: number): Promise<boolean>;
  processMetadata(pid: number): Promise<Readonly<{ ProcessId: number; ExecutablePath: string; CommandLine: string }> | null>;
  sameExecutablePath(left: string, right: string): boolean;
  commandContainsPath(commandLine: string, expectedPath: string): boolean;
  openUrl(url: string): boolean | void;
  openPath(targetPath: string): boolean | void;
  secureDirectory(directoryPath: string): Promise<void>;
  initializeTls(input: Record<string, unknown>): Promise<void>;
}>;
