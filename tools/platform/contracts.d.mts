export const OPERATOR_PLATFORM_CAPABILITIES: readonly [
  "process-execution",
  "launcher",
  "package-lifecycle",
  "removable-volume-provider",
  "server-console-runtime",
  "one-shot-process",
  "service-lifecycle"
];
export const OPERATOR_PACKAGE_TARGETS: readonly [
  "demo-server",
  "demo-client",
  "operational-server",
  "operational-client"
];

export type OperatorPlatformCapabilityId =
  (typeof OPERATOR_PLATFORM_CAPABILITIES)[number];
export type OperatorPackageTarget = (typeof OPERATOR_PACKAGE_TARGETS)[number];

export type OperatorCapabilityDescriptor = Readonly<{
  id: OperatorPlatformCapabilityId;
  role: "operator";
  platform: string;
  state: "READY" | "COMPATIBILITY" | "UNAVAILABLE";
  ownerStage: "PR-04" | "PR-08" | "PR-09" | "PR-10";
}>;

export type OperatorProcessExecution = Readonly<{
  descriptor: OperatorCapabilityDescriptor;
  childEnvironment(input?: Readonly<{
    source?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    executableDirectories?: readonly string[];
    overrides?: Record<string, string | number | boolean | undefined>;
  }>): NodeJS.ProcessEnv;
  spawnOwnedDetached(executable: string, argumentsList?: readonly string[], options?: Record<string, unknown>): Readonly<{ pid?: number; unref(): void }>;
  spawnOwnedChild(executable: string, argumentsList?: readonly string[], options?: Record<string, unknown>): Readonly<{ pid?: number; kill(signal?: string): boolean; once(event: string, listener: (...args: unknown[]) => void): unknown }>;
  terminateOwnedProcess(pid: number): void;
  terminateOwnedDetachedProcess(pid: number, options?: Readonly<{ force?: boolean }>): void;
  sameExecutablePath(left: string, right: string): boolean;
}>;

export type OperatorLauncher = Readonly<{
  descriptor: OperatorCapabilityDescriptor;
  resolveClientRuntimePlan(input: unknown): Promise<unknown>;
}>;

export type PackageStageCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
}>;

export type OperatorPackageLifecycle = Readonly<{
  descriptor: OperatorCapabilityDescriptor;
  stageCommand(target: OperatorPackageTarget): PackageStageCommand;
}>;

export type RemovableVolumeProvider = Readonly<{
  descriptor: OperatorCapabilityDescriptor;
  list(input?: Readonly<{ production?: boolean }>): Promise<readonly import("../../quickhack_server/platform/qhkey-contract.mjs").QhkeyVolumeIdentity[]>;
  locate(input?: Readonly<{
    volumeId?: string;
    rootPath?: string;
    requireProvider?: import("../../quickhack_server/platform/qhkey-contract.mjs").QhkeyProvider;
    requireWritable?: boolean;
    production?: boolean;
  }>): Promise<import("../../quickhack_server/platform/qhkey-contract.mjs").QhkeyVolumeIdentity>;
  validate(identity: import("../../quickhack_server/platform/qhkey-contract.mjs").QhkeyVolumeIdentity, input?: Readonly<{ production?: boolean }>): Promise<import("../../quickhack_server/platform/qhkey-contract.mjs").QhkeyVolumeIdentity>;
}>;

export type OperatorPlatformCapabilities = Readonly<{
  processExecution: OperatorProcessExecution;
  launcher: OperatorLauncher;
  packageLifecycle: OperatorPackageLifecycle;
  removableVolume: RemovableVolumeProvider;
  serverConsoleRuntime: import("./server-console-runtime.d.mts").ServerConsoleRuntime;
  oneShotProcess: Readonly<{
    descriptor: OperatorCapabilityDescriptor;
    create(input: Readonly<{ directOneShot: Readonly<{ execute(operation: string, input: Record<string, unknown>): Promise<unknown> }> }>): Readonly<{ execute(operation: string, input: Record<string, unknown>): Promise<unknown> }>;
  }>;
  serviceLifecycle: Readonly<{
    descriptor: OperatorCapabilityDescriptor;
    status(serviceKind: "POSTGRESQL" | "APPLICATION"): Promise<unknown>;
    operate(operation: "START" | "STOP" | "RESTART" | "STATUS", serviceKind: "POSTGRESQL" | "APPLICATION"): Promise<unknown>;
  }>;
}>;

export type OperatorPlatform = OperatorPlatformCapabilities &
  Readonly<{
    role: "operator";
    platform: string;
  }>;

export function assertOperatorPlatform(value: unknown): OperatorPlatform;
