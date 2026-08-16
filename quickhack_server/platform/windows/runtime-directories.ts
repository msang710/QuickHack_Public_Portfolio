import path from "node:path";
import { createRuntimeDirectorySnapshot } from "../../../quickhack_shared/platform/runtime-directory-contract.mjs";
import type { RuntimeDirectories } from "../contracts.ts";

function envValue(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string
) {
  const key = Object.keys(source).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return key ? String(source[key] ?? "").trim() : "";
}

function absolute(value: string, fieldName: string) {
  const source = String(value ?? "").trim();
  if (source.split(/[\\/]+/u).includes("..")) {
    throw new TypeError(`${fieldName} must not contain path traversal.`);
  }
  const normalized = path.win32.normalize(source);
  if (!path.win32.isAbsolute(normalized)) {
    throw new TypeError(`${fieldName} must be an absolute Windows path.`);
  }
  return normalized;
}

function installedRootName(artifactKind: string | undefined) {
  if (artifactKind === "DEMONSTRATION_SERVER") return "demonstration-server";
  if (artifactKind === "OPERATIONAL_SERVER") return "operational-server";
  throw new TypeError("artifactKind is required for an installed Windows server runtime.");
}

export const windowsServerRuntimeDirectories: RuntimeDirectories = Object.freeze({
  descriptor: Object.freeze({
    id: "runtime-directories",
    role: "server",
    platform: "win32",
    state: "READY",
    ownerStage: "PR-04",
  }),
  resolve(input) {
    const environment = input.environment ?? {};
    const appRoot = absolute(input.appRoot, "appRoot");
    const programData = absolute(
      envValue(environment, "ProgramData") || "C:\\ProgramData",
      "ProgramData"
    );
    const homeDirectory = absolute(
      input.homeDirectory || envValue(environment, "USERPROFILE") || "C:\\Users\\Default",
      "homeDirectory"
    );
    const localAppData = absolute(
      envValue(environment, "LOCALAPPDATA") ||
        path.win32.join(homeDirectory, "AppData", "Local"),
      "LOCALAPPDATA"
    );
    const operationalRoot = input.deployment === "system-service"
      ? path.win32.join(programData, "QuickHack", installedRootName(input.artifactKind))
      : path.win32.join(programData, "QuickHack");
    const dataDir = input.dataDirectory
      ? absolute(input.dataDirectory, "dataDirectory")
      : input.deployment === "system-service"
        ? path.win32.join(operationalRoot, "data")
        : path.win32.join(appRoot, "database");
    return createRuntimeDirectorySnapshot({
      appRoot,
      runtimeDir: input.runtimeDir
        ? absolute(input.runtimeDir, "runtimeDir")
        : path.win32.join(appRoot, "runtime"),
      configDir: path.win32.join(operationalRoot, "config"),
      dataDir,
      stateDir: path.win32.join(operationalRoot, "state"),
      logDir: path.win32.join(operationalRoot, "logs"),
      cacheDir: path.win32.join(operationalRoot, "cache"),
      secretDir: path.win32.join(dataDir, "security"),
      artifactDir: input.deployment === "system-service"
        ? path.win32.join(operationalRoot, "artifacts")
        : path.win32.join(localAppData, "QuickHackArtifacts"),
    });
  },
});
