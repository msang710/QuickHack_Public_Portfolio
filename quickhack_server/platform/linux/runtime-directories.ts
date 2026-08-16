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
  if (artifactKind === "DEMONSTRATION_SERVER") return "demonstration-server";
  if (artifactKind === "OPERATIONAL_SERVER") return "operational-server";
  throw new TypeError("artifactKind is required for an installed Linux server runtime.");
}

export const linuxServerRuntimeDirectories: RuntimeDirectories = Object.freeze({
  descriptor: Object.freeze({
    id: "runtime-directories",
    role: "server",
    platform: "linux",
    state: "READY",
    ownerStage: "PR-04",
  }),
  resolve(input) {
    const appRoot = absolute(input.appRoot, "appRoot");
    const runtimeDir = input.runtimeDir
      ? absolute(input.runtimeDir, "runtimeDir")
      : path.posix.join(appRoot, "runtime");
    if (input.deployment === "system-service") {
      const rootName = installedRootName(input.artifactKind);
      const configDir = path.posix.join("/etc/quickhack", rootName);
      const dataDir = path.posix.join("/var/lib/quickhack", rootName);
      const cacheDir = path.posix.join("/var/cache/quickhack", rootName);
      return createRuntimeDirectorySnapshot({
        appRoot,
        runtimeDir,
        configDir,
        dataDir,
        stateDir: path.posix.join(dataDir, "state"),
        logDir: path.posix.join("/var/log/quickhack", rootName),
        cacheDir,
        secretDir: path.posix.join(dataDir, "security"),
        artifactDir: path.posix.join(dataDir, "artifacts"),
      });
    }
    const environment = input.environment ?? {};
    const homeDirectory = absolute(
      input.homeDirectory || String(environment.HOME ?? ""),
      "homeDirectory"
    );
    const configRoot = envDirectory(environment, "XDG_CONFIG_HOME", path.posix.join(homeDirectory, ".config"));
    const dataRoot = envDirectory(environment, "XDG_DATA_HOME", path.posix.join(homeDirectory, ".local", "share"));
    const stateRoot = envDirectory(environment, "XDG_STATE_HOME", path.posix.join(homeDirectory, ".local", "state"));
    const cacheRoot = envDirectory(environment, "XDG_CACHE_HOME", path.posix.join(homeDirectory, ".cache"));
    const dataDir = path.posix.join(dataRoot, "quickhack");
    return createRuntimeDirectorySnapshot({
      appRoot,
      runtimeDir,
      configDir: path.posix.join(configRoot, "quickhack"),
      dataDir,
      stateDir: path.posix.join(stateRoot, "quickhack"),
      logDir: path.posix.join(stateRoot, "quickhack", "logs"),
      cacheDir: path.posix.join(cacheRoot, "quickhack"),
      secretDir: path.posix.join(dataDir, "security"),
      artifactDir: path.posix.join(stateRoot, "quickhack", "artifacts"),
    });
  },
});
