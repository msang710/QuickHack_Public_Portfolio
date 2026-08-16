import assert from "node:assert/strict";
import { createChildProcessEnvironment } from "../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../quickhack_shared/platform/linux/child-process-policy.mjs";
import {
  createWindowsChildProcessPolicy,
  resolveWindowsSystemExecutable,
  windowsSystemPaths,
} from "../../quickhack_shared/platform/windows/child-process-policy.mjs";

const source = {
  systemroot: "C:\\Windows",
  windir: "C:\\hostile-windir",
  SYSTEMDRIVE: "C:",
  temp: "C:\\Temp",
  TMP: "C:\\Tmp",
  ProgramData: "C:\\ProgramData",
  userprofile: "C:\\Users\\worker",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\worker",
  LocalAppData: "C:\\Users\\worker\\AppData\\Local",
  APPDATA: "C:\\Users\\worker\\AppData\\Roaming",
  Path: "C:\\hostile-bin",
  ComSpec: "C:\\hostile-bin\\cmd.exe",
  PATHEXT: ".JS",
  PSModulePath: "C:\\hostile-modules",
  NODE_OPTIONS: "--require=C:\\hostile.js",
  NODE_PATH: "C:\\hostile-node-path",
  NODE_EXTRA_CA_CERTS: "C:\\hostile-ca.pem",
  HTTPS_PROXY: "https://proxy.invalid",
  QUICKHACK_SUPERVISOR_TOKEN: "parent-token",
};
const snapshot = structuredClone(source);
const environment = createChildProcessEnvironment({
  policy: createWindowsChildProcessPolicy(source),
  source,
  executableDirectories: [
    "C:\\QuickHack\\runtime\\node",
    "c:\\quickhack\\runtime\\node",
  ],
  overrides: {
    PORT: 3000,
    NODE_ENV: "production",
    QUICKHACK_RUNTIME_ROLE: "client",
    OPTIONAL_VALUE: undefined,
  },
});

assert.deepEqual(source, snapshot);
assert.equal(environment.SystemRoot, "C:\\Windows");
assert.equal(environment.WINDIR, "C:\\Windows");
assert.equal(environment.ComSpec, "C:\\Windows\\System32\\cmd.exe");
assert.equal(environment.PATHEXT, ".COM;.EXE;.BAT;.CMD");
assert.equal(
  environment.Path,
  [
    "C:\\QuickHack\\runtime\\node",
    "C:\\Windows\\System32",
    "C:\\Windows",
    "C:\\Windows\\System32\\Wbem",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  ].join(";")
);
assert.equal(environment.PORT, "3000");
for (const forbidden of [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "QUICKHACK_SUPERVISOR_TOKEN",
]) {
  assert.equal(forbidden in environment, false, `${forbidden} must not be inherited.`);
}

const paths = windowsSystemPaths(source);
assert.equal(
  paths.powerShell,
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
);
assert.equal(
  resolveWindowsSystemExecutable("taskkill", source),
  "C:\\Windows\\System32\\taskkill.exe"
);
assert.throws(
  () => resolveWindowsSystemExecutable("arbitrary", source),
  /Unsupported Windows system executable key/
);
assert.throws(
  () => createChildProcessEnvironment({ source, overrides: {} }),
  /policy is required/
);
assert.throws(
  () =>
    createChildProcessEnvironment({
      policy: createWindowsChildProcessPolicy(source),
      source,
      overrides: { INVALID: {} },
    }),
  /must be scalar/
);

const linuxSource = {
  HOME: "/home/worker",
  TMPDIR: "/tmp/worker",
  USER: "worker",
  LANG: "ko_KR.UTF-8",
  PATH: "/hostile/bin",
  NODE_OPTIONS: "--require=/tmp/hostile.js",
  LD_PRELOAD: "/tmp/hostile.so",
};
const posixEnvironment = createChildProcessEnvironment({
  policy: createLinuxChildProcessPolicy(linuxSource),
  source: linuxSource,
  executableDirectories: ["/opt/quickhack/node/bin", "/opt/quickhack/node/bin"],
  overrides: { NODE_ENV: "production" },
});
assert.equal(posixEnvironment.HOME, "/home/worker");
assert.equal(posixEnvironment.NODE_ENV, "production");
assert.equal(
  posixEnvironment.PATH,
  [
    "/opt/quickhack/node/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":")
);
assert.equal("NODE_OPTIONS" in posixEnvironment, false);
assert.equal("LD_PRELOAD" in posixEnvironment, false);

const credentialStrippedEnvironment = createChildProcessEnvironment({
  policy: Object.freeze({
    ...createLinuxChildProcessPolicy(linuxSource),
    inheritedNames: Object.freeze([
      ...createLinuxChildProcessPolicy(linuxSource).inheritedNames,
      "CREDENTIALS_DIRECTORY",
    ]),
  }),
  source: { ...linuxSource, CREDENTIALS_DIRECTORY: "/run/credentials/quickhack-console.service" },
  overrides: { CREDENTIALS_DIRECTORY: undefined },
});
assert.equal(
  "CREDENTIALS_DIRECTORY" in credentialStrippedEnvironment,
  false,
  "An undefined override must actively remove an inherited credential directory."
);

console.log("Child process environments require injected OS policies and explicit overrides.");
