import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const core = readFileSync(path.join(root, "tools/server-console-core.mjs"), "utf8");
assert.match(core, /spawnOwned\("backend"/);
assert.match(core, /spawnOwned\("gateway"/);
assert.match(core, /createQuickHackShutdownCoordinator\(/);
assert.match(core, /beginStop\("manual-stop", id === "backend" \? \["gateway", "backend"\] : \[id\]\)/);
assert.match(core, /"\/api\/internal\/supervisor\/shutdown"/);
assert.match(core, /"\/api\/shutdown\/force"/);
assert.match(core, /child\.kill\("SIGTERM"\)/);
assert.match(core, /waitForExit\(child, timeoutMs\)/);
assert.match(core, /stopOwned\(id, 10_000\)/);
assert.doesNotMatch(core.split("async function stopOwned(id,")[1].split("async function start()")[0], /terminateOwnedProcess/);
assert.match(core, /applicationState = mainServerState\(/);
assert.doesNotMatch(core, /backendReadiness\.databaseReady === true && integrationStatus\.ready/);
assert.match(core, /\? "DEGRADED"/);
assert.doesNotMatch(core, /systemctl|sc\.exe|taskkill|powershell/iu);

console.log("Console-owned child tree, graceful stop, and degraded state contract verified.");
