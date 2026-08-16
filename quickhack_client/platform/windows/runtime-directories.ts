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
  if (artifactKind === "DEMONSTRATION_CLIENT") return "demonstration-client";
  if (artifactKind === "OPERATIONAL_CLIENT") return "operational-client";
  throw new TypeError("artifactKind is required for an installed Windows client runtime.");
}

export const windowsClientRuntimeDirectories: RuntimeDirectories = Object.freeze({
  descriptor: Object.freeze({
    id: "runtime-directories",
    role: "client",
    platform: "win32",
    state: "READY",
    ownerStage: "PR-04",
  }),
  resolve(input) {
    const environment = input.environment ?? {};
    const appRoot = absolute(input.appRoot, "appRoot");
    const homeDirectory = absolute(
      input.homeDirectory || envValue(environment, "USERPROFILE") || "C:\\Users\\Default",
      "homeDirectory"
    );
    const localAppData = absolute(
      envValue(environment, "LOCALAPPDATA") ||
        path.win32.join(homeDirectory, "AppData", "Local"),
      "LOCALAPPDATA"
    );
    const mutableRoot = path.win32.join(
      localAppData,
      "QuickHack",
      input.deployment === "system-service"
        ? installedRootName(input.artifactKind)
        : "client"
    );
    return createRuntimeDirectorySnapshot({
      appRoot,
      runtimeDir: input.runtimeDir
        ? absolute(input.runtimeDir, "runtimeDir")
        : path.win32.join(appRoot, "runtime"),
      configDir: mutableRoot,
      dataDir: mutableRoot,
      stateDir: mutableRoot,
      logDir: path.win32.join(mutableRoot, "logs"),
      cacheDir: path.win32.join(mutableRoot, "cache"),
      secretDir: path.win32.join(mutableRoot, "security"),
      artifactDir: input.deployment === "system-service"
        ? path.win32.join(mutableRoot, "artifacts")
        : path.win32.join(localAppData, "QuickHackArtifacts"),
    });
  },
});
