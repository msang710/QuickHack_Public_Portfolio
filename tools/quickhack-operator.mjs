import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";
import { readServerRuntimeConfigSync } from "../quickhack_shared/core/server-runtime-config.mjs";
import { authorizeQhkeyReplacement } from "./qhkey-authorize.mjs";
import {
  cleanupOperatorOneShotRequest,
  createDirectOperatorOneShot,
  prepareOperatorOneShotRequest,
} from "./operator-direct-one-shot.mjs";
import { createQuickHackOperator } from "./quickhack-operator-core.mjs";
import { readPackageRuntimeIdentitySync } from "../quickhack_shared/core/package-runtime-identity.mjs";

function parseArguments(argv) {
  if (argv.length === 0) throw new TypeError("A QuickHack operator command is required.");
  const input = {
    command: argv[0],
    runtimeConfigPath: "",
    installDir: "",
    backupFile: "",
    transactionId: "",
    operation: "",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runtime-config") input.runtimeConfigPath = path.resolve(argv[++index] || "");
    else if (argument === "--install-dir") input.installDir = path.resolve(argv[++index] || "");
    else if (argument === "--backup-file") input.backupFile = argv[++index] || "";
    else if (argument === "--transaction") input.transactionId = argv[++index] || "";
    else if (argument === "--operation") input.operation = argv[++index] || "";
    else throw new TypeError(`Unsupported QuickHack operator argument: ${argument}`);
  }
  if (!input.runtimeConfigPath) throw new TypeError("--runtime-config is required.");
  return input;
}

export function createDefaultQuickHackOperator(options = {}) {
  const root = path.resolve(options.root ?? path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
  const operatorPlatform = options.operatorPlatform ?? composeOperatorPlatform();
  const serverPlatform = options.serverPlatform ?? composeServerPlatform();
  const runtime = operatorPlatform.serverConsoleRuntime;
  const packageIdentity = readPackageRuntimeIdentitySync();
  const linuxServiceUser = packageIdentity?.artifactKind === "DEMONSTRATION_SERVER"
    ? "quickhack-demo-pg"
    : packageIdentity?.artifactKind === "OPERATIONAL_SERVER"
      ? "quickhack-operational-pg"
      : undefined;
  const directOneShot = createDirectOperatorOneShot({
    root,
    runtime,
    readRuntimeConfig: (configPath) => readServerRuntimeConfigSync({ configPath, kind: "operational" }).config,
  });
  const oneShot = operatorPlatform.oneShotProcess.create({ directOneShot });
  const postgresqlService = Object.freeze({
    install(input) {
      const runtimeConfig = readServerRuntimeConfigSync({ configPath: input.runtimeConfigPath, kind: "operational" }).config;
      return serverPlatform.postgresqlService.install({
        installDir: input.installDir || root,
        dataDir: runtimeConfig.dataDirectory,
        runtimeConfig: input.runtimeConfigPath,
        ...(linuxServiceUser ? { serviceUser: linuxServiceUser } : {}),
      });
    },
    repair(input) {
      const runtimeConfig = readServerRuntimeConfigSync({ configPath: input.runtimeConfigPath, kind: "operational" }).config;
      return serverPlatform.postgresqlService.repair({
        installDir: input.installDir || root,
        dataDir: runtimeConfig.dataDirectory,
        runtimeConfig: input.runtimeConfigPath,
        ...(linuxServiceUser ? { serviceUser: linuxServiceUser } : {}),
      });
    },
  });
  return createQuickHackOperator({
    runtimeConfig: (input) => readServerRuntimeConfigSync({ configPath: input.runtimeConfigPath, kind: "operational" }).config,
    postgresqlService,
    oneShot,
    directOneShot,
    applicationService: operatorPlatform.serviceLifecycle,
    prepareOneShot: prepareOperatorOneShotRequest,
    cleanupPreparedOneShot: cleanupOperatorOneShotRequest,
    authorizeQhkey: (transactionId) => authorizeQhkeyReplacement(transactionId, { platform: operatorPlatform.platform }),
    openConsole: (url) => runtime.openUrl(url),
  });
}

async function main() {
  const result = await createDefaultQuickHackOperator().execute(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "OPERATOR_OPERATION_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
