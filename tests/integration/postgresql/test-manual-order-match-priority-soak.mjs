import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requestedIndex = process.argv.indexOf("--iterations");
const iterations = requestedIndex >= 0
  ? Number(process.argv[requestedIndex + 1])
  : 30;
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) {
  throw new Error("--iterations must be an integer between 1 and 100.");
}

const artifact = {
  version: 1,
  suite: "manual-order-match-priority-soak",
  iterations,
  results: [],
};
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/support/register-ts-alias.mjs",
      "tests/integration/postgresql/test-manual-order-match-execution.mjs",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        QUICKHACK_PRIORITY_ITERATION: String(iteration),
      },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  const entry = {
    iteration,
    status: result.status === 0 ? "PASS" : "FAIL",
    durationMs: Date.now() - startedAt,
  };
  artifact.results.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    process.exitCode = result.status ?? 1;
    break;
  }
}
if (!process.exitCode) {
  process.stdout.write(`${JSON.stringify({
    ...artifact,
    status: "PASS",
  }, null, 2)}\n`);
}
