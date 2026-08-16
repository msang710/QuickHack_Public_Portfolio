import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_MIGRATION_ENTRYPOINTS,
  SERVER_MIGRATION_RUNTIME_FILES,
} from "../../packaging/server-migration-runtime-files.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourcePath(relativePath) {
  return path.join(rootDir, ...relativePath.split("/"));
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  const staticImportPattern =
    /^\s*import\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']\s*;?/gm;
  const exportFromPattern =
    /^\s*export\s+(?:type\s+)?[^;]*?\s+from\s+["'](\.[^"']+)["']\s*;?/gm;

  for (const pattern of [staticImportPattern, exportFromPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  for (const match of source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function resolveRelativeImport(importer, specifier) {
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier)
  );
  assert.ok(
    unresolved !== ".." && !unresolved.startsWith("../"),
    `${importer} imports a file outside the repository: ${specifier}`
  );

  const candidates = path.posix.extname(unresolved)
    ? [unresolved]
    : [
        unresolved,
        `${unresolved}.mjs`,
        `${unresolved}.js`,
        `${unresolved}.ts`,
        `${unresolved}/index.mjs`,
        `${unresolved}/index.js`,
        `${unresolved}/index.ts`,
      ];
  const resolved = candidates.find((candidate) => existsSync(sourcePath(candidate)));

  assert.ok(resolved, `${importer} has an unresolved relative import: ${specifier}`);
  return resolved;
}

function collectRuntimeClosure(entrypoints) {
  const pending = [...entrypoints];
  const visited = new Set();

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) {
      continue;
    }

    assert.ok(existsSync(sourcePath(relativePath)), `Runtime file is missing: ${relativePath}`);
    visited.add(relativePath);

    const source = readFileSync(sourcePath(relativePath), "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      pending.push(resolveRelativeImport(relativePath, specifier));
    }
  }

  return [...visited].sort();
}

function manifestIncludes(manifestEntries, relativePath) {
  return manifestEntries.some(
    (entry) =>
      entry === relativePath ||
      (entry.endsWith("/") && relativePath.startsWith(entry))
  );
}

assert.equal(
  new Set(SERVER_MIGRATION_RUNTIME_FILES).size,
  SERVER_MIGRATION_RUNTIME_FILES.length,
  "Server migration runtime contract contains duplicate files."
);
for (const entrypoint of SERVER_MIGRATION_ENTRYPOINTS) {
  assert.ok(
    SERVER_MIGRATION_RUNTIME_FILES.includes(entrypoint),
    `Migration entrypoint is missing from the runtime contract: ${entrypoint}`
  );
}

assert.deepEqual(
  collectRuntimeClosure(SERVER_MIGRATION_ENTRYPOINTS),
  [...SERVER_MIGRATION_RUNTIME_FILES].sort(),
  "Server migration runtime contract must exactly match the relative import closure."
);

const manifest = JSON.parse(
  readFileSync(sourcePath("packaging/demo-build.manifest.json"), "utf8")
);
for (const relativePath of SERVER_MIGRATION_RUNTIME_FILES) {
  assert.ok(
    manifestIncludes(manifest.include, relativePath),
    `Demo build manifest does not include migration runtime file: ${relativePath}`
  );
}
assert.ok(
  manifestIncludes(
    manifest.include,
    "packaging/server-migration-runtime-files.mjs"
  ),
  "Demo build manifest must include the migration runtime contract."
);

const stagingSource = readFileSync(
  sourcePath("packaging/create-staging-package.mjs"),
  "utf8"
);
assert.match(
  stagingSource,
  /import\s*\{\s*collectServerRuntimeClosure\s*\}\s*from\s*["']\.\/common\/server-runtime-closure\.mjs["']/,
  "Staging package must use the recursive server runtime closure collector."
);
assert.match(
  stagingSource,
  /const serverRuntimeFiles = collectServerRuntimeClosure\(\{[\s\S]*?"tools\/deploy-postgresql-migrations\.mjs"[\s\S]*?"tools\/audit-postgresql-schema\.mjs"[\s\S]*?\}\);[\s\S]*?for \(const relativePath of serverRuntimeFiles\)/,
  "Staging package must seed the migration entrypoints and copy their recursive closure."
);
assert.match(
  stagingSource,
  /copyDir\(path\.join\(rootDir,\s*["']prisma["']\),\s*path\.join\(serverTargetDir,\s*["']prisma["']\)\)/,
  "Staging package must copy the Prisma migration directory."
);
assert.match(
  stagingSource,
  /copyInstalledPackageClosure\(["']prisma["']\)/,
  "Staging package must copy the installed Prisma CLI dependency closure."
);
assert.match(
  stagingSource,
  /path\.join\(rootDir, "quickhack_server", "platform"\),\s*path\.join\(outputDir, "quickhack_server", "platform"\)/,
  "The package-level server console must receive the server platform adapter closure."
);
assert.match(
  stagingSource,
  /path\.join\(rootDir, "quickhack_shared", "platform"\),\s*path\.join\(outputDir, "quickhack_shared", "platform"\)/,
  "The package-level server console must receive shared platform dependencies."
);

const migrationSource = readFileSync(
  sourcePath("tools/deploy-postgresql-migrations.mjs"),
  "utf8"
);
assert.match(
  migrationSource,
  /QUICKHACK_PRISMA_RUNTIME_CONFIG_PATH:\s*path\.resolve\(runtimeConfigPath\)/,
  "The Prisma child must receive the selected non-secret server config path."
);
assert.doesNotMatch(
  migrationSource,
  /DATABASE_URL\s*:/,
  "The migration child must not receive a database password through its environment."
);
const prismaConfigSource = readFileSync(sourcePath("prisma.config.ts"), "utf8");
assert.match(
  prismaConfigSource,
  /process\.env\.QUICKHACK_PRISMA_RUNTIME_CONFIG_PATH/,
  "Prisma config must read the scoped runtime config path from its parent."
);
assert.match(
  prismaConfigSource,
  /runtimeConfigPath:/,
  "Prisma config must pass the selected path to the DPAPI credential resolver."
);

const prismaCli = sourcePath("node_modules/prisma/build/index.js");
const prismaResult = spawnSync(
  process.execPath,
  [prismaCli, "--help"],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      QUICKHACK_PRISMA_RUNTIME_CONFIG_PATH: sourcePath(
        ".nonexistent/server-runtime.json"
      ),
      QUICKHACK_TEST_MIGRATOR_DATABASE_URL:
        "postgresql://contract:contract@127.0.0.1:5432/contract",
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }
);
assert.equal(
  prismaResult.status,
  0,
  [prismaResult.stdout, prismaResult.stderr].filter(Boolean).join("\n")
);

console.log(
  "Server PostgreSQL migration entrypoints, dependency closure, manifest, and staging copy contract are aligned."
);
