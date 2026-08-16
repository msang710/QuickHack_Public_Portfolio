import { fileURLToPath } from "node:url";
import { createQhkeyReplacementService } from "../quickhack_server/security/qhkey-replacement-transaction.mjs";
import { assertQhkeyTransactionId } from "../quickhack_server/platform/qhkey-contract.mjs";
import { getDataDir } from "../quickhack_shared/core/runtime.ts";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";

function parseTransactionArgument(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--transaction"
  ) {
    throw new TypeError("Usage: quickhack-qhkey-publish-helper --transaction <uuid>");
  }
  return assertQhkeyTransactionId(argv[1]);
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
  const service =
    options.service ??
    createQhkeyReplacementService({
      dataDir: options.dataDir ?? getDataDir(),
      platform,
    });
  return service.publishReplacement(id, { requireRoot: platform === "linux", uid });
}

async function main() {
  const transactionId = parseTransactionArgument(process.argv.slice(2));
  const result = await publishQhkeyReplacement(transactionId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "QHKEY_PUBLISH_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
