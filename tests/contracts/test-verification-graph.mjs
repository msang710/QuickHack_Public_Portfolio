import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  postgresqlCriticalTestScripts,
  postgresqlSemanticTestScripts,
} from "../integration/postgresql/postgresql-test-manifest.mjs";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDirectory, "..", "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
);
const scripts = packageJson.scripts ?? {};

const npmRunPattern = /npm run ([A-Za-z0-9:_-]+)/g;

function directDependencies(scriptName) {
  if (scriptName === "test:postgresql-existing") {
    return postgresqlSemanticTestScripts;
  }

  const command = scripts[scriptName];
  assert.equal(typeof command, "string", `Missing npm script: ${scriptName}`);
  return [...command.matchAll(npmRunPattern)].map((match) => match[1]);
}

function countPaths(rootScript, targetScript, stack = []) {
  if (rootScript === targetScript) {
    return 1;
  }
  assert.ok(
    !stack.includes(rootScript),
    `Verification graph contains a cycle: ${[...stack, rootScript].join(" -> ")}`
  );
  return directDependencies(rootScript).reduce(
    (count, dependency) =>
      count + countPaths(dependency, targetScript, [...stack, rootScript]),
    0
  );
}

assert.equal(scripts.preverify, undefined, "preverify must not hide a second semantic suite");
assert.equal(scripts.verify, "npm run verify:postgresql");
assert.equal(scripts["test:postgresql-existing"], "node tests/integration/postgresql/run-postgresql-test-graph.mjs");
assert.equal(new Set(postgresqlSemanticTestScripts).size, postgresqlSemanticTestScripts.length);

for (const scriptName of postgresqlSemanticTestScripts) {
  assert.equal(typeof scripts[scriptName], "string", `Manifest script is missing: ${scriptName}`);
}

assert.ok(postgresqlSemanticTestScripts.includes("test:carrier-invoice-issue"));
assert.ok(!postgresqlSemanticTestScripts.includes("test:carrier-invoice-issue-flow"));
assert.ok(!postgresqlSemanticTestScripts.includes("test:carrier-invoice-issue-recovery"));
assert.equal(scripts["test:carrier-invoice-issue-ownership-migration"], undefined);

const nativeDependencyContractScripts = Object.freeze([
  "test:native-runtime-contract",
  "test:postgresql-service-runtime-contract",
  "test:postgresql-staging-runtime-contract",
  "test:android-runtime-contract",
]);

for (const contractScript of nativeDependencyContractScripts) {
  assert.equal(
    countPaths("verify:postgresql", contractScript),
    1,
    `${contractScript} must be reachable exactly once from verify:postgresql`
  );
  assert.equal(
    countPaths("verify:windows-build", contractScript),
    1,
    `${contractScript} must be reachable exactly once from verify:windows-build`
  );
}

for (const criticalScript of postgresqlCriticalTestScripts) {
  assert.equal(
    countPaths("verify:postgresql", criticalScript),
    1,
    `${criticalScript} must be reachable exactly once from verify:postgresql`
  );
  assert.equal(
    countPaths("verify:carrier", criticalScript),
    1,
    `${criticalScript} must be reachable exactly once from verify:carrier`
  );
}

const finalIntegrationWorkflow = fs.readFileSync(
  path.join(projectRoot, ".github/workflows/pull-request-checks.yml"),
  "utf8"
);
assert.equal(
  [...finalIntegrationWorkflow.matchAll(/npm run verify:postgresql/g)].length,
  1,
  "Final Integration must own exactly one full PostgreSQL verification execution"
);
assert.match(finalIntegrationWorkflow, /final-integration-complete:/);
assert.match(finalIntegrationWorkflow, /if: always\(\)/);
assert.doesNotMatch(
  finalIntegrationWorkflow,
  /closure-(?:evidence|attestation)|review-closure|closure-ledger|WINDOWS_PHYSICAL|LINUX_PHYSICAL|HARDWARE_MANUAL/
);

for (const workflowPath of [
  ".github/workflows/windows-release.yml",
  ".github/workflows/linux-release.yml",
]) {
  const workflow = fs.readFileSync(path.join(projectRoot, workflowPath), "utf8");
  assert.doesNotMatch(workflow, /npm run verify(?::postgresql)?(?:\s|$)/m);
  assert.doesNotMatch(workflow, /npm run build(?:\s|$)/m);
  assert.doesNotMatch(workflow, /npm run (?:stage|release):/m);
  assert.match(workflow, /Resolve successful same-revision Final Integration run/);
  assert.match(workflow, /verify-package-release-artifact\.mjs/);
  assert.doesNotMatch(workflow, /closure-(?:evidence|attestation)|review-closure|closure-ledger/);
  assert.match(workflow, /run-id:/);
}

const runnerSource = fs.readFileSync(
  path.join(projectRoot, "tests/integration/postgresql/run-postgresql-test-graph.mjs"),
  "utf8"
);
assert.match(runnerSource, /postgresqlSemanticTestScripts/);
assert.doesNotMatch(runnerSource, /^\s*["']test:/m);

console.log("Verification graph contract passed.");
