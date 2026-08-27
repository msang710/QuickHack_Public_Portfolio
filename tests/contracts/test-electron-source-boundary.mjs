import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../support/project-root.mjs";

const roots = ["app", "quickhack_server", "quickhack_client", "quickhack_shared"];
const sourcePattern = /\.(?:ts|tsx|mjs|mts)$/u;

function files(directory, result = []) {
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".quickhack-electron"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files(target, result);
    else if (sourcePattern.test(entry.name)) result.push(target);
  }
  return result;
}

for (const root of roots) {
  for (const filename of files(path.join(projectRoot, root))) {
    const source = readFileSync(filename, "utf8");
    assert.doesNotMatch(source, /from\s+["']electron["']|import\s*\(["']electron["']\)/u, filename);
    assert.doesNotMatch(source, /quickhack_desktop\/(?:main|preload)/u, filename);
  }
}

console.log("Electron source remains isolated from server and browser sources.");
