import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  QhkeyPlatformError,
  assertQhkeyTransactionId,
} from "../quickhack_server/platform/qhkey-contract.mjs";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";

export const QHKEY_PUBLISH_HELPER_PATH =
  "/usr/lib/quickhack/quickhack-qhkey-publish-helper";

function minimalEnvironment(environment) {
  const result = {};
  for (const key of [
    "LANG",
    "LC_ALL",
    "TERM",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    if (environment?.[key]) result[key] = environment[key];
  }
  return result;
}

export function createQhkeyAuthorizationPlan(input = {}) {
  const transactionId = assertQhkeyTransactionId(input.transactionId);
  const platform = input.platform ?? composeOperatorPlatform().platform;
  if (platform !== "linux") {
    throw new QhkeyPlatformError(
      "QHKEY_AUTHORIZATION_REQUIRED",
      "The external QHKEY authorization broker is used only on Linux."
    );
  }
  const environment = input.environment ?? process.env;
  const graphical = Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
  const executable = graphical ? "/usr/bin/pkexec" : "/usr/bin/sudo";
  const argumentsList = graphical
    ? [QHKEY_PUBLISH_HELPER_PATH, "--transaction", transactionId]
    : ["--", QHKEY_PUBLISH_HELPER_PATH, "--transaction", transactionId];
  return Object.freeze({
    provider: graphical ? "POLKIT" : "SUDO_TTY",
    executable,
    arguments: Object.freeze(argumentsList),
    environment: Object.freeze(minimalEnvironment(environment)),
  });
}

export async function authorizeQhkeyReplacement(transactionId, options = {}) {
  const plan = createQhkeyAuthorizationPlan({
    transactionId,
    platform: options.platform,
    environment: options.environment,
  });
  const run = options.run ?? ((currentPlan) => spawnSync(currentPlan.executable, currentPlan.arguments, {
    env: currentPlan.environment,
    stdio: "inherit",
    windowsHide: true,
  }));
  const result = await run(plan);
  if (result?.status !== 0) {
    throw new QhkeyPlatformError(
      "QHKEY_AUTHORIZATION_CANCELLED",
      "QHKEY replacement authorization was cancelled or failed."
    );
  }
  return Object.freeze({
    transactionId: assertQhkeyTransactionId(transactionId),
    provider: plan.provider,
    authorized: true,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== "--transaction") {
    throw new TypeError("Usage: quickhack-qhkey-authorize --transaction <uuid>");
  }
  await authorizeQhkeyReplacement(argv[1]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "QHKEY_AUTHORIZATION_CANCELLED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
