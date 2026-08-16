import { spawnSync } from "node:child_process";
import path from "node:path";
import { postgresqlSemanticTestScripts } from "./postgresql-test-manifest.mjs";
import { projectRoot } from "../../support/project-root.mjs";

const npmCli =
  process.env.npm_execpath ??
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const requestedStart = process.argv[2] ?? null;
const requestedStartIndex = requestedStart
  ? postgresqlSemanticTestScripts.indexOf(requestedStart)
  : 0;
if (requestedStart && requestedStartIndex < 0) {
  throw new Error(`Unknown PostgreSQL test graph script: ${requestedStart}`);
}
const testScripts = postgresqlSemanticTestScripts.slice(requestedStartIndex);
const results = [];
let failed = false;

for (const script of testScripts) {
  if (failed) {
    results.push({
      command: script,
      status: "NOT_RUN",
      exitCode: null,
      durationMs: 0,
      reason: "UPSTREAM_FAILURE",
    });
    continue;
  }
  process.stdout.write(`\n[postgresql-test-graph] ${script}\n`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [npmCli, "run", script], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    results.push({
      command: script,
      status: "FAIL",
      exitCode: Number.isInteger(result.status) && result.status !== 0 ? result.status : 1,
      durationMs: Math.max(0, Date.now() - startedAt),
      reason: result.error ? "PROCESS_START_FAILED" : "NON_ZERO_EXIT",
    });
    failed = true;
  } else {
    results.push({
      command: script,
      status: "PASS",
      exitCode: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      reason: null,
    });
  }
}

if (failed) {
  const failure = results.find((result) => result.status === "FAIL");
  throw new Error(`${failure.command} failed with exit code ${failure.exitCode}`);
}

console.log(`PostgreSQL semantic test graph passed (${testScripts.length} scripts).`);
