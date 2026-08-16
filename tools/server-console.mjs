import path from "node:path";
import { fileURLToPath } from "node:url";
import { readServerRuntimeConfigSync, sourceServerRuntimeConfigPath } from "../quickhack_shared/core/server-runtime-config.mjs";
import { activatePackageRuntimeIdentity } from "../quickhack_shared/core/package-runtime-identity.mjs";
import { runServerConsole } from "./server-console-core.mjs";

function runtimeConfigArgument(argv) {
  const index = argv.indexOf("--runtime-config");
  return index >= 0 ? path.resolve(argv[index + 1] || "") : "";
}

export async function runCompatibleServerConsole(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const configuredPath = runtimeConfigArgument(argv);
  const loaded = readServerRuntimeConfigSync({
    configPath: configuredPath || sourceServerRuntimeConfigPath(root),
    kind: configuredPath ? "operational" : "source",
    sourceRoot: configuredPath ? "" : root,
  }).config;
  activatePackageRuntimeIdentity({
    argv,
    artifactKind: `${loaded.packageFlavor}_SERVER`,
    runtimeRole: "SERVER",
    deploymentFlavor: loaded.packageFlavor,
  });
  if (loaded.packageFlavor === "OPERATIONAL") {
    const flavorAdapter = await import("./server-console-operational.mjs");
    return runServerConsole({ flavor: "OPERATIONAL", integration: flavorAdapter.operationalConsoleIntegration });
  }
  if (loaded.packageFlavor === "DEMONSTRATION") {
    const flavorAdapter = await import("./server-console-demonstration.mjs");
    return runServerConsole({ flavor: "DEMONSTRATION", integration: flavorAdapter.demonstrationConsoleIntegration });
  }
  const error = new Error("The server console package flavor is invalid.");
  error.code = "PACKAGE_FLAVOR_INVALID";
  throw error;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runCompatibleServerConsole().catch((error) => {
    process.stderr.write(`${error?.code || "SERVER_CONSOLE_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
