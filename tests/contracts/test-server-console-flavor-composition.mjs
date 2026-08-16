import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { operationalConsoleIntegration } from "../../tools/server-console-operational.mjs";
import { demonstrationConsoleIntegration } from "../../tools/server-console-demonstration.mjs";

assert.equal(operationalConsoleIntegration.flavor, "OPERATIONAL");
assert.deepEqual(operationalConsoleIntegration.childIds, []);
assert.equal(demonstrationConsoleIntegration.flavor, "DEMONSTRATION");
assert.deepEqual(demonstrationConsoleIntegration.childIds, ["coupang-simulator", "logen-simulator"]);

const root = path.resolve(import.meta.dirname, "..", "..");
const operational = readFileSync(path.join(root, "tools/server-console-operational.mjs"), "utf8");
const demonstration = readFileSync(path.join(root, "tools/server-console-demonstration.mjs"), "utf8");
const core = readFileSync(path.join(root, "tools/server-console-core.mjs"), "utf8");

function relativeImportClosure(entry) {
  const pending = [path.join(root, entry)];
  const visited = new Set();
  while (pending.length > 0) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    visited.add(filename);
    const source = readFileSync(filename, "utf8");
    const patterns = [
      /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/gu,
      /import\(\s*["'](\.[^"']+)["']\s*\)/gu,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const candidate = path.resolve(path.dirname(filename), match[1]);
        if (existsSync(candidate)) pending.push(candidate);
      }
    }
  }
  return [...visited].map((filename) => path.relative(root, filename).replaceAll("\\", "/"));
}

const operationalClosure = relativeImportClosure("tools/server-console-operational.mjs");
const demonstrationClosure = relativeImportClosure("tools/server-console-demonstration.mjs");
assert.doesNotMatch(operational, /mock_server|mock-issue|coupang-mock|logen-mock/iu);
assert.doesNotMatch(demonstration, /rotateCoupang|rotateLogen|live credential|external credential/iu);
assert.doesNotMatch(core, /mock_server|issueMock|rotateCoupang|rotateLogen/iu);
assert.match(core, /PACKAGE_FLAVOR_MISMATCH/);
assert.match(core, /requiresExternalDatabaseOperations|protected work|operator launcher/iu);
assert.equal(
  operationalClosure.some((filename) => /(?:^|\/)(?:mock_server|mock-runtime-launcher)|server-console-(?:demonstration|qhkey-demonstration)/u.test(filename)),
  false,
  `Operational console imported demonstration source: ${operationalClosure.join(", ")}`
);
assert.equal(
  demonstrationClosure.some((filename) => /server-console-(?:operational|qhkey-operational)/u.test(filename)),
  false,
  `Demonstration console imported operational source: ${demonstrationClosure.join(", ")}`
);

console.log("Operational and demonstration console composition closure verified.");
