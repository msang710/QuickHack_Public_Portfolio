import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const runtimeRoute = readFileSync(
  path.join(root, "app", "api", "runtime", "route.ts"),
  "utf8"
);
const launcher = readFileSync(
  path.join(root, "tools", "client-runtime-launcher.mjs"),
  "utf8"
);
const mainCommand = readFileSync(path.join(root, "main.cmd"), "utf8");

assert.match(runtimeRoute, /instanceId: clientRuntime/);
assert.match(runtimeRoute, /QUICKHACK_CLIENT_INSTANCE_ID/);
assert.doesNotMatch(runtimeRoute, /instanceToken|QUICKHACK_CLIENT_INSTANCE_TOKEN/);

assert.match(
  launcher,
  /const instanceId = crypto\.randomBytes\(24\)\.toString\("hex"\)/
);
assert.match(launcher, /QUICKHACK_CLIENT_INSTANCE_ID: instanceId/);
assert.match(launcher, /state\.instanceId !== existing\.instanceId/);
assert.match(launcher, /probe\.instanceId === instanceId/);
assert.doesNotMatch(launcher, /instanceToken|QUICKHACK_CLIENT_INSTANCE_TOKEN/);

assert.match(mainCommand, /client-runtime-launcher\.mjs/);
assert.match(mainCommand, /if \/I "%~1"=="status" goto STATUS_ONLY/);

console.log("Client runtime instance ID contract test passed.");
