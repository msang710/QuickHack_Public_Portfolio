import { fileURLToPath } from "node:url";
import { createQhkeyReplacementService } from "../quickhack_server/security/qhkey-replacement-transaction.mjs";
import { assertQhkeyTransactionId } from "../quickhack_server/platform/qhkey-contract.mjs";
import { readServerRuntimeConfigSync } from "../quickhack_shared/core/server-runtime-config.mjs";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";

function parseTransactionArgument(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 4 ||
    argv[0] !== "--runtime-config" ||
    !argv[1] ||
    argv[2] !== "--transaction"
  ) {
    throw new TypeError("Usage: quickhack-qhkey-publish-helper --runtime-config <file> --transaction <uuid>");
  }
  return { runtimeConfigPath: argv[1], transactionId: assertQhkeyTransactionId(argv[3]) };
}

export async function publishQhkeyReplacement(transactionId, options = {}) {
  const id = assertQhkeyTransactionId(transactionId);
  const getUid = options.getUid ?? (() => (typeof process.getuid === "function" ? process.getuid() : null));
  const platform = options.platform ?? composeServerPlatform().platform;
  const uid = getUid();
  if (platform === "linux" && uid !== 0) {
    const error = new Error("The QHKEY publish helper must run with operating-system administrator authorization.");
    error.code = "QHKEY_AUTHORIZATION_REQUIRED";
    throw error;
  }
  if (!options.service && !options.dataDir) throw new TypeError("A trusted QHKEY data directory is required.");
  const service =
    options.service ??
    createQhkeyReplacementService({
      dataDir: options.dataDir,
      platform,
    });
  return service.publishReplacement(id, { requireRoot: platform === "linux", uid });
}

async function main() {
  const { runtimeConfigPath, transactionId } = parseTransactionArgument(process.argv.slice(2));
  const runtimeConfig = readServerRuntimeConfigSync({ configPath: runtimeConfigPath, kind: "operational" }).config;
  const result = await publishQhkeyReplacement(transactionId, { dataDir: runtimeConfig.dataDirectory });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "QHKEY_PUBLISH_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
