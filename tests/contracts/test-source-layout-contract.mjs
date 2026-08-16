import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../support/project-root.mjs";

function collectFiles(directory, predicate, result = []) {
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".next", ".tmp", "node_modules", "release"].includes(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(absolutePath, predicate, result);
    else if (predicate(entry.name)) result.push(absolutePath);
  }
  return result;
}

function relative(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /^\s*import\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']\s*;?/gm,
    /^\s*export\s+(?:type\s+)?[^;]*?\s+from\s+["'](\.[^"']+)["']\s*;?/gm,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveRelativeImport(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), ...specifier.split("/"));
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [
        unresolved,
        `${unresolved}.mjs`,
        `${unresolved}.js`,
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        path.join(unresolved, "index.mjs"),
        path.join(unresolved, "index.js"),
        path.join(unresolved, "index.ts"),
        path.join(unresolved, "index.tsx"),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

assert.equal(
  path.resolve(process.cwd()),
  projectRoot,
  "Test commands must run with the repository root as their working directory."
);
assert.equal(existsSync(path.join(projectRoot, "tools", "test-support")), false);
assert.deepEqual(
  readdirSync(path.join(projectRoot, "tools")).filter((name) => /^test-.*\.mjs$/.test(name)),
  [],
  "tools/ must not own test entrypoints."
);

for (const obsoletePath of [
  "tools/register-ts-alias.mjs",
  "tools/run-postgresql-test-graph.mjs",
  "tools/postgresql-test-manifest.mjs",
  "tools/postgresql-test-replacement-manifest.json",
  "tools/prisma-smoke-test.mjs",
  "packaging/test-postgresql-windows-service.ps1",
  "tools/test-postgresql-operational-roles.mjs",
]) {
  assert.equal(existsSync(path.join(projectRoot, ...obsoletePath.split("/"))), false, obsoletePath);
}
assert.equal(
  existsSync(path.join(projectRoot, "tools", "verify-postgresql-operational-roles.mjs")),
  true
);

const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};
assert.equal(
  scripts["verify:postgresql-operational-roles"],
  "node tools/verify-postgresql-operational-roles.mjs"
);
assert.equal(scripts["test:postgresql-operational-roles"], undefined);

const referencedTestSources = new Set();
const pathPattern = /(?:^|\s)(tests\/[A-Za-z0-9_./-]+\.(?:mjs|ps1))/g;
for (const [scriptName, command] of Object.entries(scripts)) {
  for (const match of command.matchAll(pathPattern)) {
    const referencedPath = match[1];
    assert.equal(
      existsSync(path.join(projectRoot, ...referencedPath.split("/"))),
      true,
      `${scriptName} references a missing test source: ${referencedPath}`
    );
    referencedTestSources.add(referencedPath);
  }
}

const testEntries = collectFiles(
  path.join(projectRoot, "tests"),
  (name) => /^test-.*\.mjs$/.test(name)
).map(relative);
const unreferencedEntries = testEntries.filter((entry) => !referencedTestSources.has(entry));
assert.deepEqual(unreferencedEntries, [], "Every JavaScript test entry must have an npm script owner.");

const testSourceFiles = collectFiles(
  path.join(projectRoot, "tests"),
  (name) => /\.(?:mjs|js|ts|tsx|mts|cts)$/.test(name)
);
const unresolvedImports = [];
for (const importer of testSourceFiles) {
  const source = readFileSync(importer, "utf8");
  for (const specifier of relativeImportSpecifiers(source)) {
    if (!resolveRelativeImport(importer, specifier)) {
      unresolvedImports.push(`${relative(importer)} -> ${specifier}`);
    }
  }
}
assert.deepEqual(unresolvedImports, [], "Every relative test import must resolve from its new owner.");

const productionRoots = [
  "app",
  "mock_server",
  "packaging",
  "quickhack_client",
  "quickhack_server",
  "quickhack_shared",
  "tools",
];
const supportImports = [];
for (const rootName of productionRoots) {
  for (const filePath of collectFiles(
    path.join(projectRoot, rootName),
    (name) => /\.(?:mjs|js|ts|tsx|mts|cts)$/.test(name)
  )) {
    const source = readFileSync(filePath, "utf8");
    if (/tests\/support|tests\\support/.test(source)) supportImports.push(relative(filePath));
  }
}
assert.deepEqual(supportImports, [], "Runtime/product source must not import test support.");

console.log(
  `Test source layout verified (${testEntries.length} JavaScript entries, ${referencedTestSources.size} npm-referenced sources).`
);
