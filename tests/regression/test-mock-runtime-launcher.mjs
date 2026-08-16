import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMockRuntimePlan,
  startMockRuntime,
} from "../../tools/mock-runtime-launcher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeExecutable = process.execPath;
const hostileEnvironment = {
  ...process.env,
  Path: "C:\\hostile-bin",
  NODE_OPTIONS: "--require=C:\\hostile.js",
  NODE_PATH: "C:\\hostile-node-path",
  NODE_EXTRA_CA_CERTS: "C:\\hostile-ca.pem",
  QUICKHACK_SUPERVISOR_TOKEN: "parent-supervisor-token",
  COUPANG_MOCK_FAILURE_ENABLED: "1",
  COUPANG_MOCK_RANDOM_FAILURE_RATE: "100",
  LOGEN_MOCK_SECRET_KEY: "parent-secret",
  LOGEN_MOCK_FAILURE_ENABLED: "1",
};

for (const provider of ["coupang", "logen"]) {
  const plan = createMockRuntimePlan({
    root,
    provider,
    args: ["--host", "127.0.0.1", "--port", "3999"],
    sourceEnvironment: hostileEnvironment,
    nodeExecutable,
  });

  assert.equal(plan.provider, provider);
  assert.equal(plan.command, path.resolve(nodeExecutable));
  assert.equal(plan.cwd, root);
  assert.deepEqual(plan.args.slice(-4), ["--host", "127.0.0.1", "--port", "3999"]);
  assert.match(plan.args[0], new RegExp(`mock_server.*${provider === "coupang" ? "coupang-mock-server" : "logen.*server"}`, "i"));

  for (const forbidden of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "QUICKHACK_SUPERVISOR_TOKEN",
    "COUPANG_MOCK_FAILURE_ENABLED",
    "COUPANG_MOCK_RANDOM_FAILURE_RATE",
    "LOGEN_MOCK_SECRET_KEY",
    "LOGEN_MOCK_FAILURE_ENABLED",
  ]) {
    assert.equal(forbidden in plan.env, false, `${provider} inherited ${forbidden}.`);
  }

  let observed = null;
  const fakeChild = { on() {}, once() {} };
  const returned = startMockRuntime(plan, (command, args, options) => {
    observed = { command, args, options };
    return fakeChild;
  });
  assert.equal(returned, fakeChild);
  assert.equal(observed.command, plan.command);
  assert.deepEqual(observed.args, plan.args);
  assert.equal(observed.options.env, plan.env);
  assert.equal(observed.options.stdio, "inherit");
}

assert.throws(
  () => createMockRuntimePlan({ root, provider: "unknown", nodeExecutable }),
  /coupang.*logen/
);

console.log("Direct Mock launchers drop parent provider and Node environment values.");
