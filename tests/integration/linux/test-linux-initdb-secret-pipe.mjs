import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initdbSecretPipeCommand, postgresOfflineResetArguments, renderManagedPostgresqlConfig } from "../../../tools/platform/linux/postgresql-service-install.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-initdb-secret-pipe-"));
const cluster = path.join(root, "data");
try {
  const [executable, ...args] = initdbSecretPipeCommand("/usr/bin/initdb", [
    "--pgdata", cluster,
    "--username", "quickhack_operator",
    "--auth-host", "scram-sha-256",
    "--auth-local", "scram-sha-256",
    "--encoding", "UTF8",
    "--locale", "C",
  ]);
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdio[3].on("error", (error) => { stderr += error.message; });
  child.stdio[3].end(`${"A".repeat(43)}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(readFileSync(path.join(cluster, "PG_VERSION"), "utf8").trim(), "18");
  assert.doesNotMatch(args.join(" "), /A{43}/);
  const managedConfig = path.join(cluster, "quickhack-managed.conf");
  writeFileSync(managedConfig, renderManagedPostgresqlConfig(5543));
  const parsed = spawnSync("/usr/bin/postgres", ["-D", cluster, "-C", "unix_socket_directories", "-c", `config_file=${managedConfig}`], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout.trim(), "");

  async function singleUser(sql) {
    const backend = spawn("/usr/bin/postgres", postgresOfflineResetArguments(cluster), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    backend.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    backend.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    backend.stdin.end(sql);
    const code = await new Promise((resolve, reject) => {
      backend.once("error", reject);
      backend.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /\b(?:ERROR|FATAL|PANIC):/);
    return stdout;
  }
  const before = await singleUser("SELECT rolpassword FROM pg_authid WHERE rolname='quickhack_operator';\n");
  await singleUser(`ALTER ROLE quickhack_operator WITH PASSWORD '${"B".repeat(43)}';\n`);
  const after = await singleUser("SELECT rolpassword FROM pg_authid WHERE rolname='quickhack_operator';\n");
  assert.match(before, /SCRAM-SHA-256\$/);
  assert.match(after, /SCRAM-SHA-256\$/);
  assert.notEqual(after, before);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Linux initdb and offline operator credential recovery succeeded without a password file.");
