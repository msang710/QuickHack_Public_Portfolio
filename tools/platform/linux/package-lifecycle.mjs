import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackageInstallPreflight } from "../../../packaging/common/package-install-preflight.mjs";
import { assertOwnedPurgeTargets, createPackageLifecyclePlan } from "../../../packaging/common/package-state-lifecycle.mjs";
import { packageArtifactContract } from "../../../packaging/package-artifact-contract.mjs";
import { linuxArtifactConfig } from "../../../packaging/linux/linux-artifact-config.mjs";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

const SYSTEM_EXECUTABLES = Object.freeze({
  node: "/usr/bin/node",
  systemctl: "/usr/bin/systemctl",
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

export function linuxPackageDependencies(artifactValue) {
  const artifact = packageArtifactContract(artifactValue);
  return Object.freeze(
    artifact.role === "server"
      ? [SYSTEM_EXECUTABLES.node, SYSTEM_EXECUTABLES.systemctl, SYSTEM_EXECUTABLES.systemdCreds, SYSTEM_EXECUTABLES.runuser, SYSTEM_EXECUTABLES.postgres, SYSTEM_EXECUTABLES.initdb, SYSTEM_EXECUTABLES.pgCtl, SYSTEM_EXECUTABLES.psql, SYSTEM_EXECUTABLES.pgDump, SYSTEM_EXECUTABLES.pgRestore, SYSTEM_EXECUTABLES.pgIsReady]
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
        reject(lifecycleError("PACKAGE_OPERATION_FAILED", `${path.basename(file)} failed.`, { exitCode: error.code ?? null }));
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
    async enableAndStart(units) {
      await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["enable", "--now", ...units]);
    },
    async disableAndStop(units) {
      await defaultExec(SYSTEM_EXECUTABLES.systemctl, ["disable", "--now", ...units]).catch(() => undefined);
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
    if (runtime.getuid() !== 0) throw lifecycleError("ADMIN_AUTHENTICATION_REQUIRED", "Administrator authentication is required for QuickHack setup.");
    const config = linuxArtifactConfig(artifact.packageTarget);
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
    await runtime.enableAndStart([config.services.postgresql, config.services.console]);
    return Object.freeze({ operation, artifactKind: artifact.artifactKind, state: "ACTIVE" });
  }

  const setup = (input) => performSetup(input, "INSTALL");
  const repair = (input) => performSetup(input, "REPAIR");

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
    const ownedRoot = artifact.role === "server" ? "/" : path.posix.dirname(config.applicationRoot);
    const mutablePaths = artifact.role === "server"
      ? [config.configRoot, config.dataRoot, config.cacheRoot, `/var/log/quickhack/${config.flavorSlug}-server`]
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
    if (runtime.getuid() !== 0) throw lifecycleError("ADMIN_AUTHENTICATION_REQUIRED", "Administrator authentication is required for QuickHack purge.");
    await runtime.disableAndStop(plan.removeServiceIdentities);
    await runtime.removeOwnedPaths(plan.removeMutablePaths);
    return plan;
  }

  return Object.freeze({ setup, repair, uninstall, purge });
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
    else throw new TypeError(`Unsupported Linux package lifecycle argument: ${argument}`);
  }
  return input;
}

async function main() {
  const input = parseCli(process.argv.slice(2));
  const lifecycle = createLinuxPackageLifecycle();
  if (!["setup", "repair", "purge"].includes(input.command)) throw new TypeError("Supported commands: setup, repair, purge.");
  const result = await lifecycle[input.command](input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "PACKAGE_OPERATION_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
