import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const core = readFileSync(path.join(root, "tools/server-console-core.mjs"), "utf8");
assert.match(core, /spawnOwned\("backend"/);
assert.match(core, /spawnOwned\("gateway"/);
assert.match(core, /const ordered = \["gateway", \.\.\.integration\.childIds\.slice\(\)\.reverse\(\), "backend"\]/);
assert.match(core, /child\.kill\("SIGTERM"\)/);
assert.match(core, /waitForExit\(child, 180_000\)/);
assert.match(core, /applicationState = backend\.ok && gateway\.ok/);
assert.match(core, /\? "DEGRADED"/);
assert.doesNotMatch(core, /systemctl|sc\.exe|taskkill|powershell/iu);

console.log("Console-owned child tree, graceful stop, and degraded state contract verified.");
