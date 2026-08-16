import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDirectory, "..", "..");
const roots = [
  ".github",
  "mock_server",
  "packaging",
  "prisma",
  "quickhack_client",
  "quickhack_server",
  "quickhack_shared",
  "tools",
  "next.config.ts",
  "package.json",
  "prisma.config.ts",
];
const excluded = new Set([
  "tests/support/postgresql-test-replacement-manifest.json",
  "tests/contracts/test-no-sqlite-runtime.mjs",
  "tests/integration/postgresql/test-postgresql-operations-blocked.mjs",
]);
const sourceExtensions = new Set([
  ".cmd", ".cs", ".js", ".json", ".md", ".mjs", ".mts", ".ps1",
  ".sql", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);
const patterns = [
  ["better", "-sqlite3"].join(""),
  ["PrismaBetter", "Sqlite3"].join(""),
  ["quickhack", String.raw`\.db`].join(""),
  ["file:", String.raw`.*\.db`].join(""),
  ["PRA", "GMA"].join(""),
  ["VACUUM", " INTO"].join(""),
  ["sqlite", "_master"].join(""),
  ["INSERT OR", " IGNORE"].join(""),
  ["BEGIN", " IMMEDIATE"].join(""),
  ["deploy-", "sqlite"].join(""),
].map((source) => new RegExp(source, "i"));

function normalized(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function collect(target, result) {
  const relative = normalized(path.relative(projectRoot, target));
  if (excluded.has(relative)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (sourceExtensions.has(path.extname(target).toLowerCase())) {
      result.push(target);
    }
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if ([
      "node_modules", ".next", "release", ".tmp", "node-portable",
      "android-sdk", "gradle", "platform-tools",
    ].includes(entry.name)) {
      continue;
    }
    collect(path.join(target, entry.name), result);
  }
}

const files = [];
for (const root of roots) {
  const target = path.join(projectRoot, root);
  if (fs.existsSync(target)) collect(target, files);
}

const violations = [];
for (const file of files) {
  const relative = normalized(path.relative(projectRoot, file));
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(source)) violations.push(`${relative}: ${pattern.source}`);
  }
}

assert.deepEqual(
  violations,
  [],
  `PostgreSQL-only boundary violations:\n${violations.join("\n")}`
);
console.log(`PostgreSQL-only source boundary verified across ${files.length} files.`);
