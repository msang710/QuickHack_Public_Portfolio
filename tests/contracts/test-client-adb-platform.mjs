import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AdbCommandExecutionError,
  createAdbCommandRunner,
} from "../../quickhack_client/adb/adb-command-runner.ts";
import { createLinuxAdbExecutableResolver } from "../../quickhack_client/platform/linux/adb-executable-resolver.ts";
import { createWindowsAdbExecutableResolver } from "../../quickhack_client/platform/windows/adb-executable-resolver.ts";
import { projectRoot } from "../support/project-root.mjs";

const fixture = JSON.parse(
  readFileSync(
    path.join(
      projectRoot,
      "tests",
      "contracts",
      "fixtures",
      "client-hardware-adapter-cases.json"
    ),
    "utf8"
  )
);
assert.equal(fixture.version, 1);

function missing() {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function fileState(size = 128) {
  return {
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

const windowsInspected = [];
const windowsExecuted = [];
const windowsResolver = createWindowsAdbExecutableResolver({
  lstatFile: async (filename) => {
    windowsInspected.push(filename);
    if (filename === fixture.windows.adbCandidates[1]) return fileState();
    throw missing();
  },
  accessFile: async () => {},
  executeFile: async (executable, args, options) => {
    windowsExecuted.push({ executable, args: [...args], options });
    return { stdout: "Android Debug Bridge version 1.0.41\nVersion 37.0.0" };
  },
});
const windowsPlan = await windowsResolver.resolve({
  appRoot: fixture.windows.appRoot,
  runtimeDir: fixture.windows.runtimeDir,
  environment: { Path: "C:\\hostile", SystemRoot: "C:\\Windows" },
});
assert.deepEqual(windowsInspected, fixture.windows.adbCandidates.slice(0, 2));
assert.equal(windowsPlan.executable, fixture.windows.adbCandidates[1]);
assert.equal(windowsPlan.cwd, fixture.windows.appRoot);
assert.equal(Object.isFrozen(windowsPlan), true);
assert.equal(Object.isFrozen(windowsPlan.environment), true);
assert.deepEqual(windowsExecuted[0].args, ["version"]);
assert.doesNotMatch(windowsPlan.environment.Path, /hostile/i);
assert.equal(
  await windowsResolver.resolve({
    appRoot: fixture.windows.appRoot,
    runtimeDir: fixture.windows.runtimeDir,
    environment: { Path: "C:\\changed", SystemRoot: "C:\\Windows" },
  }),
  windowsPlan
);
assert.equal(windowsExecuted.length, 1, "The validated ADB plan was not cached.");

const linuxInspected = [];
const linuxResolver = createLinuxAdbExecutableResolver({
  lstatFile: async (filename) => {
    linuxInspected.push(filename);
    if (filename === "/usr/bin/adb") return fileState();
    throw missing();
  },
  accessFile: async () => {},
  executeFile: async (_executable, args, options) => {
    assert.deepEqual([...args], ["version"]);
    assert.equal(options.env.LC_ALL, "C");
    return { stdout: "Android Debug Bridge version 1.0.41" };
  },
});
const linuxPlan = await linuxResolver.resolve({
  appRoot: fixture.linux.appRoot,
  runtimeDir: fixture.linux.runtimeDir,
  environment: { PATH: "/tmp/hostile", HOME: "/home/quickhack" },
});
assert.deepEqual(linuxInspected, fixture.linux.adbCandidates);
assert.equal(linuxPlan.executable, "/usr/bin/adb");
assert.doesNotMatch(linuxPlan.environment.PATH, /hostile/);
assert.equal(linuxPlan.environment.LC_ALL, "C");

for (const [resolver, code] of [
  [
    createLinuxAdbExecutableResolver({
      lstatFile: async () => {
        throw missing();
      },
      accessFile: async () => {},
      executeFile: async () => ({ stdout: "" }),
    }),
    "DEPENDENCY_MISSING",
  ],
  [
    createLinuxAdbExecutableResolver({
      lstatFile: async () => fileState(),
      accessFile: async () => {},
      executeFile: async () => ({ stdout: "not adb" }),
    }),
    "DEPENDENCY_INVALID",
  ],
]) {
  await assert.rejects(
    resolver.resolve({
      appRoot: fixture.linux.appRoot,
      runtimeDir: fixture.linux.runtimeDir,
      environment: {},
    }),
    (error) => error?.code === code
  );
}

const commandCalls = [];
const run = createAdbCommandRunner({
  executeFile: async (executable, args, options) => {
    commandCalls.push({ executable, args: [...args], options });
    return { stdout: "SERIAL-1\tdevice\n" };
  },
});
const resolver = {
  descriptor: windowsResolver.descriptor,
  async resolve() {
    return windowsPlan;
  },
};
assert.equal(
  await run({
    resolver,
    context: {
      appRoot: fixture.windows.appRoot,
      runtimeDir: fixture.windows.runtimeDir,
    },
    arguments: ["-s", "SERIAL-1", "get-state"],
    timeoutMs: 1000,
  }),
  "SERIAL-1\tdevice"
);
assert.deepEqual(commandCalls[0].args, ["-s", "SERIAL-1", "get-state"]);
assert.equal(commandCalls[0].options.env, windowsPlan.environment);

const allowFailure = createAdbCommandRunner({
  executeFile: async () => {
    throw Object.assign(new Error("rejected"), {
      code: 1,
      stdout: "",
      stderr: "package not found",
    });
  },
});
assert.equal(
  await allowFailure({
    resolver,
    context: {
      appRoot: fixture.windows.appRoot,
      runtimeDir: fixture.windows.runtimeDir,
    },
    arguments: ["shell", "pm", "path", "missing"],
    timeoutMs: 1000,
    allowFailure: true,
  }),
  "package not found"
);

const sensitiveArgument = "PROVISIONING-TOKEN-MUST-NOT-LEAK";
const timedOut = createAdbCommandRunner({
  executeFile: async () => {
    throw Object.assign(new Error(sensitiveArgument), {
      code: null,
      killed: true,
      signal: "SIGTERM",
      stderr: sensitiveArgument,
    });
  },
});
await assert.rejects(
  timedOut({
    resolver,
    context: {
      appRoot: fixture.windows.appRoot,
      runtimeDir: fixture.windows.runtimeDir,
    },
    arguments: ["-s", "SERIAL-1", "shell", sensitiveArgument],
    timeoutMs: 1,
  }),
  (error) =>
    error instanceof AdbCommandExecutionError &&
    error.code === "ADB_TIMEOUT" &&
    !JSON.stringify(error).includes(sensitiveArgument)
);

const adbSource = readFileSync(
  path.join(projectRoot, "quickhack_client", "adb", "adb.ts"),
  "utf8"
);
assert.doesNotMatch(
  adbSource,
  /getAdbPathCandidates|windows\/child-process-policy|node:child_process/
);
assert.match(adbSource, /platform\.adbExecutableResolver/);
assert.match(adbSource, /\["-s", target,/);

console.log("Windows/Linux exact ADB execution plans and redacted command failures verified.");
