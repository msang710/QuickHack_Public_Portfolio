import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_CHILD_PROCESS_FILES = new Set([
  "quickhack_client/adb/adb-command-runner.ts",
  "quickhack_client/platform/linux/adb-executable-resolver.ts",
  "quickhack_client/platform/linux/printer-backend.ts",
  "quickhack_client/platform/windows/adb-executable-resolver.ts",
  "quickhack_client/platform/windows/printer-backend.ts",
  "quickhack_server/core/database/postgresql-native-operations.mjs",
  "quickhack_server/platform/windows/security-process.mjs",
  "tools/client-runtime-launcher.mjs",
  "tools/mock-runtime-launcher.mjs",
  "tools/platform/linux/package-lifecycle.mjs",
  "tools/platform/linux/server-console-runtime.mjs",
  "tools/platform/linux/postgresql-service-install.mjs",
  "tools/platform/linux/systemd-credential-process.mjs",
  "tools/platform/linux/systemd-one-shot-process.mjs",
  "tools/platform/linux/systemd-service-process.mjs",
  "tools/platform/windows/postgresql-service-install.mjs",
  "tools/platform/windows/process-execution.mjs",
  "tools/platform/windows/server-console-runtime.mjs",
  "tools/qhkey-authorize.mjs",
  "tools/server-console-core.mjs",
]);
const NON_RUNTIME_CHILD_PROCESS_FILES = new Set([
  "packaging/create-staging-package.mjs",
  "packaging/linux/build-arch-package.mjs",
  "packaging/sanitize-standalone.mjs",
  "tools/deploy-postgresql-migrations.mjs",
]);
const SOURCE_ROOTS = ["packaging", "quickhack_client", "quickhack_server", "quickhack_shared", "tools"];

function relativePath(filename) {
  return path.relative(ROOT, filename).replaceAll("\\", "/");
}

function sourceFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", "release"].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...sourceFiles(filename));
      continue;
    }
    if (/\.(?:mjs|mts|ts)$/.test(entry.name)) result.push(filename);
  }
  return result;
}

const observedChildProcessFiles = new Set();

for (const rootName of SOURCE_ROOTS) {
  for (const filename of sourceFiles(path.join(ROOT, rootName))) {
    const relative = relativePath(filename);
    const source = fs.readFileSync(filename, "utf8");
    if (source.includes("node:child_process")) observedChildProcessFiles.add(relative);
  }
}

assert.deepEqual(
  [...observedChildProcessFiles].sort(),
  [...RUNTIME_CHILD_PROCESS_FILES, ...NON_RUNTIME_CHILD_PROCESS_FILES].sort(),
  "Every production child_process caller must be classified as runtime-isolated or build-only."
);

for (const relative of RUNTIME_CHILD_PROCESS_FILES) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
  assert.match(
    source,
    /child-process-environment\.mjs|processExecution\.(?:childEnvironment|terminateOwnedProcess)|runtime\.(?:childEnvironment|terminateOwnedProcess)|minimalEnvironment/,
    `${relative} must use the common environment contract or an injected process adapter.`
  );
  assert.doesNotMatch(
    source,
    /\.\.\.\s*process\.env/,
    `${relative} must not spread the parent environment.`
  );
  assert.doesNotMatch(
    source,
    /env\s*:\s*process\.env/,
    `${relative} must not pass the parent environment directly.`
  );
}

const clientLauncher = fs.readFileSync(
  path.join(ROOT, "tools", "client-runtime-launcher.mjs"),
  "utf8"
);
assert.doesNotMatch(clientLauncher, /QUICKHACK_CA_CERT_FILE/);
assert.match(clientLauncher, /NODE_EXTRA_CA_CERTS:\s*caCertificateFile/);

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
for (const provider of ["coupang", "logen"]) {
  assert.match(
    packageJson.scripts[`mock:${provider}`],
    new RegExp(`tools/mock-runtime-launcher\\.mjs ${provider}$`)
  );
  assert.match(
    packageJson.scripts[`mock:${provider}:init`],
    new RegExp(`tools/mock-runtime-launcher\\.mjs ${provider} --init-db$`)
  );
}

for (const commandFile of ["mock.cmd", "logen-mock.cmd"]) {
  const source = fs.readFileSync(path.join(ROOT, commandFile), "utf8");
  assert.match(source, /mock-runtime-launcher\.mjs/);
  assert.doesNotMatch(source, /set\s+"PATH=.*%PATH%/i);
}

console.log("Runtime child_process callers and normal Mock entries use explicit environments.");
