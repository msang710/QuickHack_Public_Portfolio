import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const unit = readFileSync(path.join(root, "packaging/linux/systemd/quickhack-console.service.in"), "utf8");
assert.match(unit, /^ExecStart=@QUICKHACK_NODE_EXECUTABLE@ @QUICKHACK_CONSOLE_ENTRY@/m);
assert.match(unit, /^KillMode=mixed$/m);
assert.match(unit, /^KillSignal=SIGTERM$/m);
assert.match(unit, /^TimeoutStopSec=240$/m);
assert.match(unit, /^User=@QUICKHACK_APPLICATION_USER@$/m);
assert.match(unit, /@QUICKHACK_APPLICATION_CREDENTIAL_DIRECTIVES@/);
assert.doesNotMatch(unit, /quickhack-(?:backend|gateway|coupang|logen)\.service/iu);
assert.equal((unit.match(/^ExecStart=/gm) ?? []).length, 1);

console.log("Linux top-level console unit and single application owner verified.");
