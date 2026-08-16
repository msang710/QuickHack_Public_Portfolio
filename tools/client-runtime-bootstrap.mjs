import path from "node:path";
import { fileURLToPath } from "node:url";
import { readClientRuntimeOwnerStateFile } from "./client-runtime-owner-state.mjs";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";

export const CLIENT_RUNTIME_BOOTSTRAP_FILENAME = fileURLToPath(import.meta.url);

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new TypeError("The client runtime bootstrap command is incomplete.");
  }
  const input = { statePath: "", ownerToken: "", instanceId: "", cwd: "" };
  for (let index = 0; index < separator; index += 1) {
    const argument = argv[index];
    if (argument === "--state-path") input.statePath = path.resolve(argv[++index] || "");
    else if (argument === "--owner-token") input.ownerToken = argv[++index] || "";
    else if (argument === "--instance-id") input.instanceId = argv[++index] || "";
    else if (argument === "--cwd") input.cwd = path.resolve(argv[++index] || "");
    else throw new TypeError(`Unsupported client runtime bootstrap argument: ${argument}`);
  }
  if (
    !input.statePath ||
    !input.cwd ||
    !/^[a-f0-9]{48}$/u.test(input.ownerToken) ||
    !/^[a-f0-9]{48}$/u.test(input.instanceId)
  ) {
    throw new TypeError("The client runtime bootstrap ownership input is invalid.");
  }
  return { ...input, runtimeArguments: argv.slice(separator + 1) };
}

async function waitForClaim(input, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readClientRuntimeOwnerStateFile(input.statePath);
    if (
      state?.state === "CLAIMED" &&
      state.ownerToken === input.ownerToken &&
      state.instanceId === input.instanceId &&
      state.pid === process.pid
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export async function runClientRuntimeBootstrap(argv = process.argv.slice(2), options = {}) {
  const input = parseArguments(argv);
  const claim = await waitForClaim(input, options.claimTimeoutMs);
  if (!claim) {
    const error = new Error("The client runtime bootstrap did not receive a durable owner claim.");
    error.code = "CLIENT_RUNTIME_OWNER_CLAIM_TIMEOUT";
    throw error;
  }
  if (path.resolve(input.runtimeArguments[0]) !== path.resolve(claim.entry)) {
    const error = new Error("The client runtime bootstrap entry does not match its durable owner claim.");
    error.code = "CLIENT_RUNTIME_OWNER_MISMATCH";
    throw error;
  }
  const processExecution = options.processExecution ?? composeOperatorPlatform().processExecution;
  if (typeof processExecution.childEnvironment !== "function") {
    throw new TypeError("The client runtime bootstrap requires the platform child environment policy.");
  }
  const child = processExecution.spawnOwnedChild(process.execPath, input.runtimeArguments, {
    cwd: input.cwd,
    env: processExecution.childEnvironment({ source: process.env }),
    stdio: "inherit",
  });
  let stopping = false;
  const forward = (signal) => {
    if (stopping) return;
    stopping = true;
    try { child.kill(signal); } catch {}
  };
  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGINT", () => forward("SIGINT"));
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal && !stopping) {
        const error = new Error(`The client runtime exited from signal ${signal}.`);
        error.code = "CLIENT_RUNTIME_EXITED";
        reject(error);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (path.resolve(process.argv[1] || "") === CLIENT_RUNTIME_BOOTSTRAP_FILENAME) {
  runClientRuntimeBootstrap().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error?.code || "CLIENT_RUNTIME_BOOTSTRAP_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
