import path from "node:path";
import { createRuntimeDirectorySnapshot } from "../../../quickhack_shared/platform/runtime-directory-contract.mjs";
import type { RuntimeDirectories } from "../contracts.ts";

function absolute(value: string, fieldName: string) {
  const source = String(value ?? "").trim();
  if (source.split("/").includes("..")) {
    throw new TypeError(`${fieldName} must not contain path traversal.`);
  }
  const normalized = path.posix.normalize(source);
  if (!path.posix.isAbsolute(normalized)) {
    throw new TypeError(`${fieldName} must be an absolute Linux path.`);
  }
  return normalized;
}

function envDirectory(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
  fallback: string
) {
  const value = String(environment[name] ?? "").trim();
  return absolute(value || fallback, name);
}

function installedRootName(artifactKind: string | undefined) {
  if (artifactKind === "DEMONSTRATION_CLIENT") return "demonstration-client";
  if (artifactKind === "OPERATIONAL_CLIENT") return "operational-client";
  throw new TypeError("artifactKind is required for an installed Linux client runtime.");
}

export const linuxClientRuntimeDirectories: RuntimeDirectories = Object.freeze({
  descriptor: Object.freeze({
    id: "runtime-directories",
    role: "client",
    platform: "linux",
    state: "READY",
    ownerStage: "PR-04",
  }),
  resolve(input) {
    const environment = input.environment ?? {};
    const appRoot = absolute(input.appRoot, "appRoot");
    const homeDirectory = absolute(
      input.homeDirectory || String(environment.HOME ?? ""),
      "homeDirectory"
    );
    const configRoot = envDirectory(environment, "XDG_CONFIG_HOME", path.posix.join(homeDirectory, ".config"));
    const dataRoot = envDirectory(environment, "XDG_DATA_HOME", path.posix.join(homeDirectory, ".local", "share"));
    const stateRoot = envDirectory(environment, "XDG_STATE_HOME", path.posix.join(homeDirectory, ".local", "state"));
    const cacheRoot = envDirectory(environment, "XDG_CACHE_HOME", path.posix.join(homeDirectory, ".cache"));
    const relativeRoot = input.deployment === "system-service"
      ? path.posix.join("quickhack", installedRootName(input.artifactKind))
      : "quickhack";
    return createRuntimeDirectorySnapshot({
      appRoot,
      runtimeDir: input.runtimeDir
        ? absolute(input.runtimeDir, "runtimeDir")
        : path.posix.join(appRoot, "runtime"),
      configDir: path.posix.join(configRoot, relativeRoot),
      dataDir: path.posix.join(dataRoot, relativeRoot),
      stateDir: path.posix.join(stateRoot, relativeRoot),
      logDir: path.posix.join(stateRoot, relativeRoot, "logs"),
      cacheDir: path.posix.join(cacheRoot, relativeRoot),
      secretDir: path.posix.join(dataRoot, relativeRoot, "security"),
      artifactDir: path.posix.join(stateRoot, relativeRoot, "artifacts"),
    });
  },
});
