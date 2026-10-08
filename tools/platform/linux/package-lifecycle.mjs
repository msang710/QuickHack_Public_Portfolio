import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstatSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackageInstallPreflight } from "../../../packaging/common/package-install-preflight.mjs";
import { assertOwnedPurgeTargets, createPackageLifecyclePlan } from "../../../packaging/common/package-state-lifecycle.mjs";
import { packageArtifactContract } from "../../../packaging/package-artifact-contract.mjs";
import { linuxArtifactConfig } from "../../../packaging/linux/linux-artifact-config.mjs";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";
import { readServerRuntimeConfigSync } from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { createServerSecretIdentityManifest } from "../../../quickhack_server/platform/server-secret-identity.mjs";
import { systemdCredentialCiphertextPath } from "./systemd-credential-provisioner.mjs";
import { verifyPackageReadinessDigest } from "../../package-readiness-proof.mjs";

const SYSTEM_EXECUTABLES = Object.freeze({
  node: "/usr/bin/node",
  systemctl: "/usr/bin/systemctl",
  systemdRun: "/usr/bin/systemd-run",
  systemdCreds: "/usr/bin/systemd-creds",
  runuser: "/usr/bin/runuser",
  postgres: "/usr/bin/postgres",
  initdb: "/usr/bin/initdb",
  pgCtl: "/usr/bin/pg_ctl",
  psql: "/usr/bin/psql",
  pgDump: "/usr/bin/pg_dump",
  pgRestore: "/usr/bin/pg_restore",
  pgIsReady: "/usr/bin/pg_isready",
  adb: "/usr/bin/adb",
  lp: "/usr/bin/lp",
  lpstat: "/usr/bin/lpstat",
});

function lifecycleError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  return error;
}

export async function ensureConsoleOperatorStateDirectory(dataRoot, uid, gid) {
  const state = path.posix.join(dataRoot, "state");
  const operator = path.posix.join(state, "operator");
  for (const directory of [state, operator]) {
    let stat = await fs.lstat(directory).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      await fs.mkdir(directory, { mode: 0o700 });
      stat = await fs.lstat(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw lifecycleError("CONSOLE_OPERATOR_STATE_INVALID", "Console operator state directory is invalid.");
    }
    await fs.chown(directory, uid, gid);
    await fs.chmod(directory, directory === state ? 0o750 : 0o700);
  }
}

export function childFailureCode(stderr) {
  return /^([A-Z][A-Z0-9_]{2,63}):/u.exec(String(stderr ?? ""))?.[1] ?? null;
}

export function unitJournalFailureCode(output) {
  return [...String(output ?? "").matchAll(/^([A-Z][A-Z0-9_]{2,63}):/gmu)].map((match) => match[1]).at(-1) ?? null;
}

export function parseActiveConsolePid(output) {
  const properties = Object.fromEntries(String(output ?? "").trim().split(/\r?\n/u).map((line) => line.split("=", 2)));
  const pid = Number(properties.MainPID);
  return properties.ActiveState === "active" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export async function readConsoleReadinessProof(dataRoot) {
  const filename = path.posix.join(dataRoot, "state", "operator", "server-console-action.json");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0) {
      throw lifecycleError("CONSOLE_READINESS_PROOF_INVALID", "The console readiness proof is invalid.");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value?.schemaVersion !== 2 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{64}$/u.test(String(value.packageReadinessSecret ?? ""))) {
      throw lifecycleError("CONSOLE_READINESS_PROOF_INVALID", "The console readiness proof is invalid.");
    }
    return { pid: value.pid, secret: value.packageReadinessSecret };
  } finally {
    await handle.close();
  }
}

export function requestVerifiedConsoleReadiness(secret, options = {}) {
  const nonce = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: options.port ?? 2999, path: "/api/internal/package-readiness", headers: { "X-QuickHack-Package-Nonce": nonce }, timeout: options.timeoutMs ?? 4_000 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          response.destroy();
          reject(new Error("Console readiness response too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200 || !verifyPackageReadinessDigest(secret, nonce, response.headers["x-quickhack-package-proof"])) return reject(new Error("Console readiness identity invalid."));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Console status invalid.")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Console status timeout.")));
    request.on("error", reject);
  });
}

export async function waitForVerifiedApplicationReady(config, runtime, options = {}) {
  const installedManifest = JSON.parse(await fs.readFile(path.posix.join(config.applicationRoot, "quickhack-package.json"), "utf8"));
  const expectedVersion = String(installedManifest.version ?? "");
  const expectedBuildId = String(installedManifest.contentInventorySha256 ?? "");
  if (!expectedVersion || !/^[a-f0-9]{64}$/u.test(expectedBuildId)) throw lifecycleError("PACKAGE_ARTIFACT_INVALID", "Installed package identity is invalid.");
  const attempts = options.attempts ?? 60;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const unitPid = await runtime.activeConsolePid(config).catch(() => null);
    const proof = unitPid ? await runtime.consoleReadinessProof(config).catch(() => null) : null;
    if (proof?.pid === unitPid) {
      const status = await runtime.applicationStatus(config, proof.secret).catch(() => null);
      const currentPid = await runtime.activeConsolePid(config).catch(() => null);
      if (currentPid === unitPid && status?.applicationState === "ACTIVE" && status?.runtimeVersion === expectedVersion && status?.runtimeBuildId === expectedBuildId && status?.database?.state === "ACTIVE" && status?.tls?.ready === true && status?.backend?.ok === true && status?.backendReadiness?.databaseReady === true && status?.gateway?.ok === true) return status;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1_000));
  }
  throw lifecycleError("APPLICATION_NOT_READY", "QuickHack console started, but application health did not become ready. Inspect the console service journal.");
}

export function linuxPackageDependencies(artifactValue) {
  const artifact = packageArtifactContract(artifactValue);
  return Object.freeze(
    artifact.role === "server"
      ? [SYSTEM_EXECUTABLES.node, SYSTEM_EXECUTABLES.systemctl, SYSTEM_EXECUTABLES.systemdRun, SYSTEM_EXECUTABLES.systemdCreds, SYSTEM_EXECUTABLES.runuser, SYSTEM_EXECUTABLES.postgres, SYSTEM_EXECUTABLES.initdb, SYSTEM_EXECUTABLES.pgCtl, SYSTEM_EXECUTABLES.psql, SYSTEM_EXECUTABLES.pgDump, SYSTEM_EXECUTABLES.pgRestore, SYSTEM_EXECUTABLES.pgIsReady]
      : [SYSTEM_EXECUTABLES.node, SYSTEM_EXECUTABLES.adb, SYSTEM_EXECUTABLES.lp, SYSTEM_EXECUTABLES.lpstat]
  );
}

function defaultExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const environment = options.env ?? createChildProcessEnvironment({
      policy: createLinuxChildProcessPolicy(process.env),
      source: process.env,
      executableDirectories: [path.posix.dirname(file)],
      overrides: options.overrides ?? {},
    });
    execFile(file, args, { shell: false, timeout: options.timeoutMs ?? 300_000, env: environment }, (error, stdout, stderr) => {
      if (error) {
        const failureCode = childFailureCode(stderr);
        reject(lifecycleError(
          "PACKAGE_OPERATION_FAILED",
          `${path.basename(file)} failed${failureCode ? ` (${failureCode})` : ""}.`,
          { exitCode: error.code ?? null, childFailureCode: failureCode }
        ));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function defaultRuntime() {
  return Object.freeze({
    getuid: () => process.getuid?.(),
    async assertExecutable(filename) {
      const stat = await fs.lstat(filename).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw lifecycleError("DEPENDENCY_MISSING", `Required system executable is unavailable: ${filename}`);
    },
    async postgresqlVersion() {
      const result = await defaultExec(SYSTEM_EXECUTABLES.postgres, ["--version"]);
      return result.stdout;
    },
    async unitExists(unit) {
      const stat = await fs.lstat(path.posix.join("/usr/lib/systemd/system", unit)).catch(() => null);
      return Boolean(stat?.isFile() && !stat.isSymbolicLink());
    },
    async ensureRuntimeConfig(config) {
      await fs.mkdir(config.configRoot, { recursive: true, mode: 0o750 });
      const runtimeConfig = config.runtimeConfig;
      const existing = await fs.lstat(runtimeConfig).catch(() => null);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw lifecycleError("PACKAGE_ARTIFACT_INVALID", "Runtime configuration is not a regular file.");
        return runtimeConfig;
      }
      const template = path.posix.join(config.applicationRoot, "packaging/server-runtime.template.json");
      await fs.copyFile(template, runtimeConfig, constants.COPYFILE_EXCL);
      return runtimeConfig;
    },
    async runOperator(config, command) {
      await defaultExec(SYSTEM_EXECUTABLES.node, [
        path.posix.join(config.applicationRoot, "tools/quickhack-operator.mjs"),
        command,
        "--runtime-config",
        config.runtimeConfig,
        "--install-dir",
        config.applicationRoot,
      ], {
        overrides: {
          QUICKHACK_PACKAGE_MANIFEST: path.posix.join(config.applicationRoot, "quickhack-package.json"),
        },
      });
    },
    async activateServices(config) {
      await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["enable", "--now", config.services.postgresql]);
      await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["enable", config.services.console]);
      await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["restart", config.services.console]);
    },
    async ensureApplicationSecurityDirectory(config) {
      const security = path.posix.join(config.dataRoot, "security");
      const legacy = path.posix.join(security, "initial-leader-result.json");
      if (await fs.lstat(legacy).catch(() => null)) throw lifecycleError("INITIAL_LEADER_RESULT_MIGRATION_REQUIRED", "Initial leader result has not been migrated.");
      const user = config.users.application;
      const uid = Number((await defaultExec("/usr/bin/id", ["-u", user])).stdout.trim());
      const gid = Number((await defaultExec("/usr/bin/id", ["-g", user])).stdout.trim());
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw lifecycleError("APPLICATION_ACCOUNT_INVALID", "Application account is invalid.");
      let stat = await fs.lstat(security).catch(() => null);
      if (!stat) {
        await fs.mkdir(security, { mode: 0o700 });
        stat = await fs.lstat(security);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw lifecycleError("APPLICATION_SECURITY_DIRECTORY_INVALID", "Application security directory is invalid.");
      await fs.chown(security, uid, gid);
      await fs.chmod(security, 0o700);
    },
    async ensureConsoleOperatorStateDirectory(config) {
      const user = config.users.application;
      const uid = Number((await defaultExec("/usr/bin/id", ["-u", user])).stdout.trim());
      const gid = Number((await defaultExec("/usr/bin/id", ["-g", user])).stdout.trim());
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw lifecycleError("APPLICATION_ACCOUNT_INVALID", "Application account is invalid.");
      await ensureConsoleOperatorStateDirectory(config.dataRoot, uid, gid);
    },
    async startInitialTls(unit) {
      const since = new Date(Date.now() - 1_000).toISOString();
      try {
        await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["start", unit]);
      } catch {
        const journal = await defaultExec("/usr/bin/journalctl", ["-u", unit, "--since", since, "-n", "40", "--no-pager", "-o", "cat"], { timeoutMs: 5_000 }).catch(() => null);
        const code = unitJournalFailureCode(journal?.stdout) ?? "INITIAL_TLS_FAILED";
        throw lifecycleError(code, `Initial TLS setup failed (${code}). Inspect ${unit} journal; if host selection is required, set publicHost in the server runtime configuration.`);
      }
    },
    async activeConsolePid(config) {
      const result = await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["show", config.services.console, "--property=ActiveState", "--property=MainPID"]);
      return parseActiveConsolePid(result.stdout);
    },
    async consoleReadinessProof(config) {
      return readConsoleReadinessProof(config.dataRoot);
    },
    async applicationStatus(_config, secret) {
      return requestVerifiedConsoleReadiness(secret);
    },
    async waitForApplicationReady(config) {
      return waitForVerifiedApplicationReady(config, this);
    },
    async clearUpgradePending(config) {
      await fs.rm(`/var/lib/quickhack/upgrade-state/${config.flavorSlug}-upgrade.pending`, { force: true });
    },
    async upgradePending(config) {
      return Boolean(await fs.lstat(`/var/lib/quickhack/upgrade-state/${config.flavorSlug}-upgrade.pending`).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      }));
    },
    async pacmanTransactionActive() {
      return Boolean(await fs.lstat("/var/lib/pacman/db.lck").catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      }));
    },
    async disableAndStop(units) {
      await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["disable", "--now", ...units]).catch(() => undefined);
    },
    purgeCredentialPaths(config) {
      const runtimeConfig = readServerRuntimeConfigSync({ configPath: config.runtimeConfig, kind: "operational" }).config;
      if (runtimeConfig.packageFlavor !== config.packageFlavor || runtimeConfig.dataDirectory !== config.dataRoot) {
        throw lifecycleError("PACKAGE_ARTIFACT_INVALID", "Runtime configuration does not match the purge target.");
      }
      return createServerSecretIdentityManifest(runtimeConfig).identities.map(systemdCredentialCiphertextPath);
    },
    async removeOwnedPaths(paths) {
      const remaining = [];
      for (const target of paths) {
        const stat = await fs.lstat(target).catch(() => null);
        if (!stat) continue;
        if (stat.isSymbolicLink()) throw lifecycleError("PURGE_CONFIRMATION_REQUIRED", "Purge refuses symbolic-link targets.", { target });
        await fs.rm(target, { recursive: true, force: true }).catch(() => remaining.push(target));
      }
      if (remaining.length > 0) throw lifecycleError("PURGE_PARTIAL", "Some QuickHack artifact paths remain.", { remaining });
    },
  });
}

function oppositeServer(config) {
  return linuxArtifactConfig(config.packageFlavor === "DEMONSTRATION" ? "operational-server" : "demo-server");
}

export function createLinuxPackageLifecycle(options = {}) {
  const runtime = options.runtime ?? defaultRuntime();

  async function observedInstalledServiceKinds(config) {
    if (config.role !== "server") return [];
    const opposite = oppositeServer(config);
    return (await Promise.all(Object.values(opposite.services).map((unit) => runtime.unitExists(unit)))).some(Boolean)
      ? [opposite.artifactKind]
      : [];
  }

  async function performSetup(input, operation) {
    const artifact = packageArtifactContract(input?.artifactKind);
    if (artifact.role !== "server") throw lifecycleError("PACKAGE_OPERATION_INVALID", "Linux setup is a server-only operation.");
    if (input?.upgradeRecovery && operation !== "REPAIR") throw lifecycleError("PACKAGE_OPERATION_INVALID", "Upgrade recovery is available only for repair.");
    if (runtime.getuid() !== 0) throw lifecycleError("ADMIN_AUTHENTICATION_REQUIRED", "Administrator authentication is required for QuickHack setup.");
    const config = linuxArtifactConfig(artifact.packageTarget);
    if (typeof runtime.upgradePending === "function" && await runtime.upgradePending(config)) {
      if (!input?.upgradeReconcile && !input?.upgradeRecovery) {
        throw lifecycleError("UPGRADE_RECOVERY_REQUIRED", "The server upgrade is pending. Complete the package transaction, then run repair with --recover-upgrade.");
      }
      if (!input?.upgradeReconcile && typeof runtime.pacmanTransactionActive === "function" && await runtime.pacmanTransactionActive()) {
        throw lifecycleError("PACKAGE_TRANSACTION_ACTIVE", "Wait for the package transaction to complete before recovering the server upgrade.");
      }
    }
    assertPackageInstallPreflight({
      artifactKind: artifact.artifactKind,
      installedServiceKinds: await observedInstalledServiceKinds(config),
      legacyLayoutDetected: Boolean(input?.legacyLayoutDetected),
    });
    for (const executable of linuxPackageDependencies(artifact.artifactKind)) await runtime.assertExecutable(executable);
    const version = await runtime.postgresqlVersion();
    if (!/PostgreSQL\)\s+18(?:\.|\s|$)/u.test(version) && !/postgres\s+\(PostgreSQL\)\s+18/u.test(version)) {
      throw lifecycleError("POSTGRESQL_MAJOR_UNSUPPORTED", "QuickHack requires system PostgreSQL 18.");
    }
    await runtime.ensureRuntimeConfig(config);
    await runtime.runOperator(config, operation);
    await runtime.ensureApplicationSecurityDirectory(config);
    await runtime.ensureConsoleOperatorStateDirectory(config);
    await runtime.startInitialTls(config.services.initialTls);
    await runtime.activateServices(config);
    await runtime.waitForApplicationReady(config);
    if (typeof runtime.clearUpgradePending === "function") await runtime.clearUpgradePending(config);
    return Object.freeze({ operation, artifactKind: artifact.artifactKind, state: "ACTIVE" });
  }

  const setup = (input) => performSetup(input, "INSTALL");
  const repair = (input) => performSetup(input, "REPAIR");

  function initialLogin(input) {
    const artifact = packageArtifactContract(input?.artifactKind);
    if (artifact.role !== "server") throw lifecycleError("PACKAGE_OPERATION_INVALID", "Initial login is a server-only operation.");
    if (runtime.getuid() !== 0) throw lifecycleError("ADMIN_AUTHENTICATION_REQUIRED", "Administrator authentication is required.");
    const config = linuxArtifactConfig(artifact.packageTarget);
    const filename = path.posix.join("/var/lib/quickhack/security", `${path.posix.basename(config.dataRoot)}-initial-leader-result`);
    const result = readInitialLoginResult(filename);
    if (result.status !== "CREATED") throw lifecycleError("INITIAL_LEADER_HANDOFF_UNAVAILABLE", "No initial administrator password is available.");
    return Object.freeze({ username: result.username, temporaryPassword: result.temporaryPassword });
  }

  function uninstall(input) {
    return createPackageLifecyclePlan({
      operation: "UNINSTALL",
      artifactKind: input?.artifactKind,
      serviceIdentities: Object.values(linuxArtifactConfig(packageArtifactContract(input?.artifactKind).packageTarget).services),
    });
  }

  async function purge(input) {
    const artifact = packageArtifactContract(input?.artifactKind);
    const config = linuxArtifactConfig(artifact.packageTarget);
    if (runtime.getuid() !== 0) throw lifecycleError("ADMIN_AUTHENTICATION_REQUIRED", "Administrator authentication is required for QuickHack purge.");
    if (artifact.role === "server" && (await observedInstalledServiceKinds(config)).length > 0) {
      throw lifecycleError("SERVER_FLAVOR_CONFLICT", "An opposite server unit is installed; shared credentials cannot be purged safely.");
    }
    const ownedRoot = artifact.role === "server" ? "/" : path.posix.dirname(config.applicationRoot);
    const mutablePaths = artifact.role === "server"
      ? [config.configRoot, config.dataRoot, config.cacheRoot, `/var/log/quickhack/${config.flavorSlug}-server`, `/var/lib/quickhack/security/${path.posix.basename(config.dataRoot)}-initial-leader-result`, `/var/lib/quickhack/security/${path.posix.basename(config.dataRoot)}-operator`, ...runtime.purgeCredentialPaths(config)]
      : [];
    const targets = assertOwnedPurgeTargets({ platform: "linux", ownedRoot, targets: mutablePaths });
    const plan = createPackageLifecyclePlan({
      operation: "PURGE",
      artifactKind: artifact.artifactKind,
      serviceIdentities: Object.values(config.services),
      mutablePaths: targets,
      backupVerified: input?.backupVerified,
      confirmation: input?.confirmation,
    });
    await runtime.disableAndStop(plan.removeServiceIdentities);
    await runtime.removeOwnedPaths(plan.removeMutablePaths);
    return plan;
  }

  return Object.freeze({ setup, repair, initialLogin, uninstall, purge });
}

function readInitialLoginResult(filename) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw lifecycleError("INITIAL_LEADER_RESULT_INVALID", "Initial login result is invalid.");
  const lines = readFileSync(filename, "utf8").trimEnd().split("\n");
  if (lines.shift() !== "QUICKHACK_INITIAL_LEADER_RESULT_V1") throw lifecycleError("INITIAL_LEADER_RESULT_INVALID", "Initial login result protocol is invalid.");
  const fields = Object.fromEntries(lines.map((line) => line.split("=", 2)));
  if (fields.status !== "CREATED" || fields.username !== "admin" || !/^[A-Za-z0-9_-]{32}$/u.test(fields.temporaryPassword ?? "")) throw lifecycleError("INITIAL_LEADER_RESULT_INVALID", "Initial login result is invalid.");
  return fields;
}

function parseCli(argv) {
  const input = { command: String(argv[0] ?? "").toLowerCase(), artifactKind: "", backupVerified: false, confirmation: { artifactKind: "", irreversible: false, noRecoveryAcknowledged: false } };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact") input.artifactKind = argv[++index] || "";
    else if (argument === "--confirm-artifact") input.confirmation.artifactKind = argv[++index] || "";
    else if (argument === "--irreversible") input.confirmation.irreversible = true;
    else if (argument === "--verified-backup") input.backupVerified = true;
    else if (argument === "--ack-no-recovery") input.confirmation.noRecoveryAcknowledged = true;
    else if (argument === "--recover-upgrade") input.upgradeRecovery = true;
    else throw new TypeError(`Unsupported Linux package lifecycle argument: ${argument}`);
  }
  return input;
}

async function main() {
  const input = parseCli(process.argv.slice(2));
  const lifecycle = createLinuxPackageLifecycle();
  if (!["setup", "repair", "purge", "initial-login"].includes(input.command)) throw new TypeError("Supported commands: setup, repair, purge, initial-login.");
  const result = input.command === "initial-login" ? lifecycle.initialLogin(input) : await lifecycle[input.command](input);
  if (input.command === "initial-login") process.stdout.write(`Initial administrator: ${result.username}\nTemporary password: ${result.temporaryPassword}\nChange this password at first login.\n`);
  else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (input.command === "setup" || input.command === "repair") process.stdout.write(`Initial administrator credentials: sudo /usr/bin/quickhack-${linuxArtifactConfig(packageArtifactContract(input.artifactKind).packageTarget).flavorSlug}-server-initial-login\n`);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "PACKAGE_OPERATION_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
