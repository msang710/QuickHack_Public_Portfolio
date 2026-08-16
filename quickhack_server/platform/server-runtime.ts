import os from "node:os";
import {
  RuntimeConfigService,
} from "../../quickhack_shared/core/runtime-config-service.ts";
import {
  findQuickHackSourceRoot,
  readServerRuntimeConfigSync,
  resolveServerRuntimeConfigLocation,
} from "../../quickhack_shared/core/server-runtime-config.mjs";
import { composeServerPlatform } from "./compose-server-platform.ts";

const serverPlatform = composeServerPlatform();

function resolveServerRuntimeDirectories(input: {
  role: "server" | "client";
  appRoot: string;
  runtimeDir?: string;
  dataDirectory?: string;
  environment: NodeJS.ProcessEnv;
  deployment: "development" | "system-service";
}) {
  if (input.role !== "server") {
    throw new TypeError("The server runtime service cannot resolve client paths.");
  }
  return serverPlatform.runtimeDirectories.resolve({
    ...input,
    homeDirectory: os.homedir(),
  });
}

function readConfiguredServerRuntime() {
  const startDirectory = process.cwd();
  const sourceRoot = findQuickHackSourceRoot(startDirectory);
  const hasExplicitRuntimeConfig = process.argv.includes("--runtime-config");
  if (sourceRoot || hasExplicitRuntimeConfig) {
    return readServerRuntimeConfigSync(
      resolveServerRuntimeConfigLocation({ startDirectory, argv: process.argv })
    );
  }
  const directories = serverPlatform.runtimeDirectories.resolve({
    appRoot: startDirectory,
    homeDirectory: os.homedir(),
    environment: process.env,
    deployment: "system-service",
    artifactKind: process.env.QUICKHACK_ARTIFACT_KIND as
      | "DEMONSTRATION_SERVER"
      | "OPERATIONAL_SERVER"
      | undefined,
  });
  const location = resolveServerRuntimeConfigLocation({
    startDirectory,
    operationalConfigDirectory: directories.configDir,
    argv: process.argv,
  });
  return readServerRuntimeConfigSync(location);
}

export function createServerRuntimeConfigService(
  readServerConfig = readConfiguredServerRuntime
) {
  return new RuntimeConfigService({
    readServerConfig,
    resolveRuntimeDirectories: resolveServerRuntimeDirectories,
  });
}

export const serverRuntimeConfigService = createServerRuntimeConfigService();

export function getServerSecretProtector() {
  return serverPlatform.secretProtector;
}

export function getServerQhkeyMasterKeyProvider() {
  return serverPlatform.qhkeyMasterKey;
}

export function getServerRemovableVolumeProvider() {
  return serverPlatform.removableVolume;
}
