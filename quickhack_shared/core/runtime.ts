import os from "node:os";
import { composeClientPlatform } from "../../quickhack_client/platform/compose-client-platform.ts";
import { composeServerPlatform } from "../../quickhack_server/platform/compose-server-platform.ts";
import {
  findQuickHackSourceRoot,
  readServerRuntimeConfigSync,
  resolveServerRuntimeConfigLocation,
} from "./server-runtime-config.mjs";
import {
  RuntimeConfigService,
  normalizeInternalServerOrigin,
  type RuntimeRole,
} from "./runtime-config-service.ts";

const serverPlatform = composeServerPlatform();
const clientPlatform = composeClientPlatform();

function resolveRuntimeDirectories(input: {
  role: "server" | "client";
  appRoot: string;
  runtimeDir?: string;
  dataDirectory?: string;
  environment: NodeJS.ProcessEnv;
  deployment: "development" | "system-service";
}) {
  const provider =
    input.role === "client"
      ? clientPlatform.runtimeDirectories
      : serverPlatform.runtimeDirectories;
  return provider.resolve({ ...input, homeDirectory: os.homedir() });
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

export const runtimeConfigService = new RuntimeConfigService({
  readServerConfig: readConfiguredServerRuntime,
  resolveRuntimeDirectories,
});

export { RuntimeConfigService, normalizeInternalServerOrigin };
export type { RuntimeRole };

export function getRuntimeConfig() {
  return runtimeConfigService.read();
}

export function getQuickHackEnvironment() {
  return runtimeConfigService.read().environment;
}

export function isProductionRuntime() {
  return runtimeConfigService.isProduction();
}

export function getRuntimeRole(): RuntimeRole {
  return runtimeConfigService.read().role as RuntimeRole;
}

export function isClientRuntime() {
  return getRuntimeRole() === "client";
}

export function isServerRuntime() {
  return getRuntimeRole() === "server";
}

export function isSingleRuntime() {
  return getRuntimeRole() === "single";
}

export function getRemoteServerUrl() {
  return runtimeConfigService.read().endpoints.remoteServerUrl;
}

export function requireRemoteServerUrl() {
  const serverUrl = getRemoteServerUrl();
  if (!serverUrl) throw new Error("QUICKHACK_SERVER_URL is not configured.");
  return serverUrl;
}

export function getInternalServerUrl() {
  return runtimeConfigService.read().endpoints.internalServerUrl;
}

export function requireInternalServerUrl() {
  return normalizeInternalServerOrigin(getInternalServerUrl());
}

export function getAppRoot() {
  return runtimeConfigService.read().paths.appRoot;
}

export function getRuntimeDir() {
  return runtimeConfigService.read().paths.runtimeDir;
}

export function getDataDir() {
  return runtimeConfigService.read().paths.dataDir;
}

export function getPostgresqlDatabaseConfig() {
  return runtimeConfigService.getDatabaseConfig();
}
