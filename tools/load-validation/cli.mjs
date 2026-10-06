#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventWriter } from "./collector.mjs";
import { openDedicatedPool } from "./db.mjs";
import { provisionLoadAccounts } from "./accounts.mjs";
import { seedServerDatabase } from "./seed-server.mjs";
import { seedCoupangMock, seedLogenMock } from "./seed-mock.mjs";
import { verifyLoadDatabases } from "./oracle.mjs";
import { monitorResources } from "./monitor.mjs";
import { runLoadPhase } from "./runner.mjs";
import { summarizeLoadRun } from "./report.mjs";
import { DEFAULT_LOAD_PROFILE, ordersPerMinute, profileDigest, validateLoadProfile } from "./profile.mjs";
import { sourceRevision } from "../field-validation/source-snapshot.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const usage = `Usage: node tools/load-validation/cli.mjs profile > profile.json\n       node tools/load-validation/cli.mjs <seed-server|seed-coupang|seed-logen|accounts|verify|run> --profile profile.json [--secrets file] [--out directory] [--phase id] [--target https://host] [--server-pid pid]\nDatabase URLs: QUICKHACK_LOAD_SERVER_DATABASE_URL, QUICKHACK_LOAD_COUPANG_DATABASE_URL, QUICKHACK_LOAD_LOGEN_DATABASE_URL`;

function argsToOptions(args) {
  const [command, ...rest] = args;
  if (!command) throw new Error(usage);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || !rest[index + 1]) throw new Error(usage);
    if (options[key]) throw new Error(`Duplicate ${key}.`);
    options[key] = rest[index + 1];
  }
  return { command, options };
}

function dbUrls() {
  return {
    serverUrl: process.env.QUICKHACK_LOAD_SERVER_DATABASE_URL,
    coupangUrl: process.env.QUICKHACK_LOAD_COUPANG_DATABASE_URL,
    logenUrl: process.env.QUICKHACK_LOAD_LOGEN_DATABASE_URL,
  };
}

async function assertDistinctDatabases(urls) {
  if (Object.values(urls).some((url) => !url)) throw new Error("All three dedicated database URLs are required.");
  const entries = Object.entries(urls).filter(([, url]) => Boolean(url));
  const opened = [];
  try {
    for (const [name, url] of entries) opened.push(await openDedicatedPool(url, `preflight-${name}`));
    if (new Set(opened.map((entry) => entry.identity)).size !== opened.length) throw new Error("Server and Mock databases or schemas must all differ.");
  } finally { await Promise.allSettled(opened.map((entry) => entry.pool.end())); }
}

async function loadProfile(filename) {
  return validateLoadProfile(filename ? JSON.parse(await readFile(filename, "utf8")) : DEFAULT_LOAD_PROFILE);
}

async function main() {
  const { command, options } = argsToOptions(process.argv.slice(2));
  const profile = command === "profile" && !options["--profile"]
    ? validateLoadProfile({ ...structuredClone(DEFAULT_LOAD_PROFILE), historyEnd: new Date().toISOString() })
    : await loadProfile(options["--profile"]);
  if (command === "profile") {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    process.stderr.write(`profile SHA-256: ${profileDigest(profile)}\n`);
    return;
  }
  if (!options["--profile"]) throw new Error("--profile is required after generating the run profile.");
  const urls = dbUrls();
  await assertDistinctDatabases(urls);
  const progress = (value) => process.stderr.write(`${JSON.stringify(value)}\n`);
  if (command === "seed-server") return progress(await seedServerDatabase(profile, urls.serverUrl, { onProgress: progress }));
  if (command === "seed-coupang") return progress(await seedCoupangMock(profile, urls.coupangUrl, { onProgress: progress }));
  if (command === "seed-logen") return progress(await seedLogenMock(profile, urls.logenUrl, { onProgress: progress }));
  if (command === "accounts") return progress(await provisionLoadAccounts(profile, urls.serverUrl, options["--secrets"]));
  if (command === "verify") {
    process.stdout.write(`${JSON.stringify(await verifyLoadDatabases(profile, urls), null, 2)}\n`);
    return;
  }
  if (command !== "run") throw new Error(usage);
  const phaseId = options["--phase"];
  const phase = profile.phases.find((item) => item.id === phaseId);
  if (!phase) throw new Error("--phase must name one profile phase.");
  if (!options["--target"] || !options["--out"] || !options["--secrets"]) throw new Error("run requires --target, --out, and --secrets.");
  const target = new URL(options["--target"]);
  if (target.username || target.password || target.search || target.hash || target.pathname !== "/") throw new Error("--target must be a bare origin without credentials or query data.");
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(target.hostname))) throw new Error("--target must use HTTPS except on loopback.");
  if (options["--server-pid"] && (!Number.isSafeInteger(Number(options["--server-pid"])) || Number(options["--server-pid"]) < 1)) throw new Error("--server-pid must be a positive integer.");
  const secretFile = JSON.parse(await readFile(options["--secrets"], "utf8"));
  if (secretFile.schema !== "quickhack-load-secrets/v1" || secretFile.runId !== profile.runId) throw new Error("Secrets do not match profile runId.");
  const out = path.resolve(options["--out"]);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const eventsPath = path.join(out, `${phaseId}.jsonl`);
  const reportPath = path.join(out, `${phaseId}.report.json`);
  const manifestPath = path.join(out, `${phaseId}.manifest.json`);
  const server = await openDedicatedPool(urls.serverUrl, "runner-server");
  let coupang;
  try {
    coupang = await openDedicatedPool(urls.coupangUrl, "runner-coupang");
    if (server.identity === coupang.identity) throw new Error("Target and Mock DB identities must differ.");
    if (Math.floor(ordersPerMinute(profile, phase.orderMultiplier) * phase.durationSeconds / 60) > 0) {
      const worker = await server.pool.query("SELECT status, schedule_enabled, interval_seconds, last_error_code FROM server_worker_jobs WHERE worker_key='coupang-accept-order-sync'");
      const state = worker.rows[0];
      if (!state || state.schedule_enabled !== 1 || !state.interval_seconds || ["DISABLED", "FAILED", "RETRY_WAITING"].includes(state.status)) {
        throw new Error(`Coupang ACCEPT sync worker is not ready for live arrivals: ${JSON.stringify(state ?? null)}.`);
      }
    }
  } catch (error) {
    await Promise.allSettled([server.pool.end(), coupang?.pool.end()].filter(Boolean));
    throw error;
  }
  const writer = createEventWriter(eventsPath);
  const events = [];
  const write = async (event) => { events.push(event); await writer.write(event); };
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let monitor;
  let runResult;
  const revisionAtStart = sourceRevision(projectRoot);
  try {
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "quickhack-load-manifest/v1", runId: profile.runId, phaseId,
      startedAt: new Date().toISOString(), profileDigest: profileDigest(profile),
      sourceRevision: revisionAtStart, target: options["--target"],
      serverDatabase: server.identity, coupangDatabase: coupang.identity,
      serverCpuLimit: profile.serverCpuLimit, serverMemoryMiB: profile.serverMemoryMiB,
      serverPid: options["--server-pid"] ? Number(options["--server-pid"]) : null,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    monitor = monitorResources({ pool: server.pool, pid: options["--server-pid"] ? Number(options["--server-pid"]) : null, write, signal: abort.signal });
    runResult = await runLoadPhase({ profile, phaseId, baseUrl: options["--target"], credentials: secretFile.credentials, serverPool: server.pool, mockPool: coupang.pool, write, signal: abort.signal });
  } finally {
    abort.abort();
    await monitor;
    await writer.close();
    await Promise.all([server.pool.end(), coupang.pool.end()]);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  let oracle = await verifyLoadDatabases(profile, urls);
  for (let attempt = 0; oracle.verdict === "INCONCLUSIVE" && attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    oracle = await verifyLoadDatabases(profile, urls);
  }
  const revisionAtFinish = sourceRevision(projectRoot);
  const summary = summarizeLoadRun(profile, phaseId, events, oracle, runResult);
  const report = { ...summary, verdict: revisionAtStart === revisionAtFinish ? summary.verdict : "INCONCLUSIVE",
    sourceSnapshotStatus: revisionAtStart === revisionAtFinish ? "UNCHANGED" : "CHANGED_DURING_RUN",
    sourceRevisionAtStart: revisionAtStart, sourceRevisionAtFinish: revisionAtFinish,
    runResult, finishedAt: new Date().toISOString() };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ reportPath, eventsPath, manifestPath, verdict: report.verdict })}\n`);
  if (report.verdict !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
