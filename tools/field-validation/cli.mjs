import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRunManifest } from "./manifest.mjs";
import { materializeScenario, runHttpScenario } from "./runner.mjs";
import { sourceRevision } from "./source-snapshot.mjs";

export function parseScenarioConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Scenario config must be an object.");
  if (value.environment !== "isolated") throw new TypeError("Scenario environment must be isolated.");
  if (value.networkProfile !== undefined && value.networkProfile !== "baseline") {
    throw new TypeError("Only baseline network is supported by this HTTP runner; use the isolated network lab for measured profiles.");
  }
  const base = new URL(value.baseUrl);
  if (!["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol)) {
    throw new TypeError("Scenario baseUrl must be loopback.");
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0) throw new TypeError("Scenario actions are required.");
  if (!value.expectedState || typeof value.expectedState !== "object" || Array.isArray(value.expectedState)) {
    throw new TypeError("Scenario expectedState is required.");
  }
  for (const key of ["runId", "seed", "scenarioId", "snapshotPath"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new TypeError(`Scenario ${key} is required.`);
  }
  return value;
}

export async function runScenarioConfig(config, options = {}) {
  const value = parseScenarioConfig(config);
  const initialRevision = options.sourceRevision ?? sourceRevision(options.sourceRoot);
  const manifest = createRunManifest({
    runId: value.runId,
    seed: value.seed,
    scenarioId: value.scenarioId,
    sourceRevision: initialRevision,
    environment: value.environment,
    networkProfile: value.networkProfile ?? "baseline",
  });
  const scenario = materializeScenario(value, manifest);
  const result = await runHttpScenario({
    manifest,
    baseUrl: scenario.baseUrl,
    actions: scenario.actions,
    snapshotPath: scenario.snapshotPath,
    expectedState: scenario.expectedState,
    timeoutMs: scenario.timeoutMs,
    cookie: options.cookie,
    fetchImpl: options.fetchImpl,
  });
  if (options.sourceRevision !== undefined) return result;
  const finalRevision = sourceRevision(options.sourceRoot);
  if (finalRevision === initialRevision) return result;
  return { ...result, verdict: result.verdict === "FAIL" ? "FAIL" : "INCONCLUSIVE", sourceSnapshotStatus: "CHANGED_DURING_RUN", sourceRevisionAfter: finalRevision };
}

async function main() {
  const [command, configPath] = process.argv.slice(2);
  if (command !== "run" || !configPath) {
    throw new Error("Usage: node tools/field-validation/cli.mjs run <scenario.json>");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const result = await runScenarioConfig(config, { cookie: process.env.QUICKHACK_FIELD_VALIDATION_COOKIE });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.sourceSnapshotStatus === "CHANGED_DURING_RUN") process.exitCode = 2;
  else if (result.verdict === "FAIL") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Field validation failed."}\n`);
    process.exitCode = 1;
  });
}
