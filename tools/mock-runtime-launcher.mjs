import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";

const filename = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(filename), "..");

const PROVIDER_SCRIPTS = Object.freeze({
  coupang: path.join("mock_server", "coupang-mock-server.mjs"),
  logen: path.join("mock_server", "logen", "server.mjs"),
});

function firstExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function createMockRuntimePlan({
  root = defaultRoot,
  provider,
  args = [],
  sourceEnvironment = process.env,
  nodeExecutable,
} = {}) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const relativeScript = PROVIDER_SCRIPTS[normalizedProvider];

  if (!relativeScript) {
    throw new Error("Mock provider must be either 'coupang' or 'logen'.");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedNodeExecutable = path.resolve(
    nodeExecutable ||
      firstExistingPath([
        path.join(resolvedRoot, "runtime", "node", "node.exe"),
        path.join(
          resolvedRoot,
          "tools",
          "node-portable",
          "node-v24.17.0-win-x64",
          "node.exe"
        ),
        process.execPath,
      ])
  );
  const script = path.join(resolvedRoot, relativeScript);
  const testEnvironment =
    String(sourceEnvironment.NODE_ENV || "") === "test"
      ? {
          NODE_ENV: "test",
          ...(normalizedProvider === "coupang"
            ? {
                QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL:
                  sourceEnvironment.QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL,
              }
            : {
                QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL:
                  sourceEnvironment.QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL,
              }),
        }
      : {};

  if (!fs.existsSync(resolvedNodeExecutable)) {
    throw new Error(`Mock Node runtime was not found: ${resolvedNodeExecutable}`);
  }
  if (!fs.existsSync(script)) {
    throw new Error(`Mock server script was not found: ${script}`);
  }

  return {
    provider: normalizedProvider,
    command: resolvedNodeExecutable,
    args: [script, ...args.map((value) => String(value))],
    cwd: resolvedRoot,
    env: composeOperatorPlatform().processExecution.childEnvironment({
      source: sourceEnvironment,
      executableDirectories: [path.dirname(resolvedNodeExecutable)],
      overrides: testEnvironment,
    }),
  };
}

export function startMockRuntime(plan, spawnImplementation = spawn) {
  return spawnImplementation(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: false,
    stdio: "inherit",
  });
}

function runCli() {
  const [provider, ...args] = process.argv.slice(2);
  const plan = createMockRuntimePlan({ provider, args });
  const child = startMockRuntime(plan);

  child.on("error", (error) => {
    console.error(
      `[QuickHack ${plan.provider} mock] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[QuickHack ${plan.provider} mock] exited by signal ${signal}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    runCli();
  } catch (error) {
    console.error(
      `[QuickHack mock] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
