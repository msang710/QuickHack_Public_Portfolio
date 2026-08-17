import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { projectRoot } from "../support/project-root.mjs";

const SOURCE_ROOTS = [
  "app",
  "quickhack_server",
  "quickhack_client",
  "quickhack_shared",
  "tools",
  "packaging",
];
const SOURCE_EXTENSION = /\.(?:mjs|mts|ts|tsx)$/;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".tmp",
  "node_modules",
  "release",
]);
const TOKEN_PATTERNS = Object.freeze({
  "process.platform": /process\.platform/gi,
  "path.win32": /path\.win32/gi,
  powershell: /PowerShell|powershell(?:\.exe)?/gi,
  "cmd.exe": /cmd\.exe/gi,
  "sc.exe": /sc\.exe/gi,
  dpapi: /DPAPI|ProtectedData/gi,
  cups: /\bCUPS\b/gi,
  systemd: /\bsystemd\b/gi,
});
const CLASSIFICATIONS = new Set([
  "composition-root",
  "contract-owned",
  "adapter-owned",
  "build-only",
  "observation-only",
  "transitional",
]);
const COMPOSITION_ROOTS = new Set([
  "quickhack_server/platform/compose-server-platform.ts",
  "quickhack_client/platform/compose-client-platform.ts",
  "tools/platform/compose-operator-platform.mjs",
  "tools/platform/compose-process-execution.mjs",
]);

function sourceFiles(directory, result = []) {
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(filename, result);
    else if (SOURCE_EXTENSION.test(entry.name)) result.push(filename);
  }
  return result;
}

function relative(filename) {
  return path.relative(projectRoot, filename).replaceAll("\\", "/");
}

function observedOwnership() {
  const rows = [];
  for (const rootName of SOURCE_ROOTS) {
    for (const filename of sourceFiles(path.join(projectRoot, rootName))) {
      const source = readFileSync(filename, "utf8");
      for (const [token, pattern] of Object.entries(TOKEN_PATTERNS)) {
        const count = [...source.matchAll(pattern)].length;
        if (count > 0) rows.push({ path: relative(filename), token, count });
      }
    }
  }
  return rows.sort((left, right) =>
    `${left.path}\0${left.token}`.localeCompare(`${right.path}\0${right.token}`)
  );
}

function validateManifest(manifest) {
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.entries));
  const identities = new Set();

  for (const entry of manifest.entries) {
    assert.equal(typeof entry.path, "string");
    assert.doesNotMatch(entry.path, /[*?]/, `Wildcard ownership is forbidden: ${entry.path}`);
    assert.ok(existsSync(path.join(projectRoot, ...entry.path.split("/"))), entry.path);
    assert.ok(Object.hasOwn(TOKEN_PATTERNS, entry.token), entry.token);
    assert.ok(Number.isInteger(entry.count) && entry.count > 0, entry.path);
    assert.ok(CLASSIFICATIONS.has(entry.classification), entry.classification);

    const identity = `${entry.path}\0${entry.token}`;
    assert.equal(identities.has(identity), false, `Duplicate ownership: ${identity}`);
    identities.add(identity);

    if (entry.classification === "transitional") {
      assert.match(entry.ownerStage ?? "", /^PR-0[4-9]$/);
    } else {
      assert.equal(entry.ownerStage, undefined);
    }
    if (entry.classification === "composition-root") {
      assert.ok(COMPOSITION_ROOTS.has(entry.path), entry.path);
      assert.equal(entry.token, "process.platform");
    }
    if (entry.classification === "adapter-owned") {
      assert.match(entry.path, /\/platform\/(?:windows|linux)\//);
    }
  }

  assert.deepEqual(
    new Set(
      manifest.entries
        .filter((entry) => entry.classification === "composition-root")
        .map((entry) => entry.path)
    ),
    COMPOSITION_ROOTS
  );
}

const manifestPath = path.join(
  projectRoot,
  "tests",
  "contracts",
  "fixtures",
  "platform-source-ownership.json"
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
validateManifest(manifest);

const expected = manifest.entries
  .map(({ path: entryPath, token, count }) => ({ path: entryPath, token, count }))
  .sort((left, right) =>
    `${left.path}\0${left.token}`.localeCompare(`${right.path}\0${right.token}`)
  );
const observed = observedOwnership();
assert.deepEqual(
  observed,
  expected,
  "Every native platform token must have exact path, count, classification, and owner."
);

for (const token of manifest.expectedZeroTokens) {
  assert.equal(
    observed.some((entry) => entry.token === token),
    false,
    `Expected zero production references for ${token}.`
  );
}

for (const rootName of SOURCE_ROOTS) {
  for (const filename of sourceFiles(path.join(projectRoot, rootName))) {
    const source = readFileSync(filename, "utf8");
    assert.doesNotMatch(source, /\bPlatformServices\b/, relative(filename));
    if (relative(filename).includes("/platform/")) {
      assert.doesNotMatch(
        source,
        /\b(?:platformServices|capabilities)\s*\[\s*["']/,
        `String capability lookup is forbidden: ${relative(filename)}`
      );
    }
  }
}

assert.throws(
  () =>
    validateManifest({
      ...manifest,
      entries: [...manifest.entries, manifest.entries[0]],
    }),
  /Duplicate ownership/
);
assert.throws(
  () =>
    validateManifest({
      ...manifest,
      entries: [{ ...manifest.entries[0], path: "tools/*" }],
    }),
  /Wildcard ownership/
);

console.log(
  `Platform source ownership verified (${observed.length} exact path/token entries).`
);
