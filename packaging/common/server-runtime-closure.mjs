import fs from "node:fs";
import path from "node:path";

export const SERVER_RUNTIME_EXPLICIT_SEEDS = Object.freeze([
  "tools/server-console-core.mjs",
  "tools/server-console-qhkey.mjs",
  "tools/server-console-qhkey-common.mjs",
  "tools/server-console-qhkey-demonstration.mjs",
  "tools/server-console-qhkey-operational.mjs",
  "tools/quickhack-operator.mjs",
  "tools/quickhack-operator-core.mjs",
  "tools/operator-direct-one-shot.mjs",
  "tools/deploy-postgresql-migrations.mjs",
  "tools/provision-initial-leader.mjs",
  "tools/postgresql-backup.mjs",
  "tools/postgresql-restore.mjs",
]);

function closureError(message, details = {}) {
  const error = new Error(message);
  error.code = "PACKAGE_RUNTIME_CLOSURE_MISSING";
  error.details = Object.freeze({ ...details });
  return error;
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function resolveImport(importer, specifier, root) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...[".mjs", ".js", ".cjs", ".ts", ".tsx", ".json", ".d.mts"].map((extension) => `${base}${extension}`),
    ...["index.mjs", "index.js", "index.ts", "index.tsx"].map((filename) => path.join(base, filename)),
  ];
  const resolved = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!resolved || path.relative(root, resolved).startsWith("..")) {
    throw closureError("A package runtime relative import could not be resolved.", {
      importer: slash(path.relative(root, importer)),
      specifier,
    });
  }
  return resolved;
}

const IMPORT_PATTERN = /(?:\bimport\s*(?:[^"'()]*?\sfrom\s*)?|\bexport\s+[^"']*?\sfrom\s*|\brequire\s*\(|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu;

export function collectServerRuntimeClosure(input) {
  const root = path.resolve(input?.rootDirectory ?? process.cwd());
  const initial = [...new Set([...(input?.entrypoints ?? []), ...(input?.seeds ?? SERVER_RUNTIME_EXPLICIT_SEEDS)])];
  const pending = initial.map((relativePath) => {
    const filename = path.resolve(root, relativePath);
    if (path.relative(root, filename).startsWith("..") || !fs.existsSync(filename)) {
      throw closureError("A package runtime seed is missing.", { path: slash(relativePath) });
    }
    return filename;
  });
  const visited = new Set();
  while (pending.length > 0) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    visited.add(filename);
    if (path.extname(filename) === ".json") continue;
    const source = fs.readFileSync(filename, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      pending.push(resolveImport(filename, match[1], root));
    }
  }
  return Object.freeze([...visited].map((filename) => slash(path.relative(root, filename))).sort());
}
