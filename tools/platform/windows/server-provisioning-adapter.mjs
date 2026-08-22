import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  postgresqlCredentialPath,
  resolvePostgresqlConnectionStringSync,
} from "../../../quickhack_server/core/database/postgresql-credential.mjs";
import { secureWindowsDirectoryAcl } from "../../../quickhack_server/security/windows-user-protected-secret.mjs";
import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";
import { readServerRuntimeConfigSync } from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { postgresqlRoleKindsForFlavor } from "../../../quickhack_shared/core/package-flavor-contract.mjs";
import { POSTGRESQL_MAJOR_VERSION } from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import { auditPostgresqlSchema } from "../../audit-postgresql-schema.mjs";
import { deployPostgresqlMigrations } from "../../deploy-postgresql-migrations.mjs";
import {
  provisionInitialLeaderHandoff,
} from "../../provision-initial-leader.mjs";
import { installPostgresqlService } from "./postgresql-service-install.mjs";
import { classifyLegacyWindowsInstall } from "../../../packaging/windows/msix/legacy-install-detector.mjs";
import { observeLegacyWindowsInstall } from "./legacy-install-observer.mjs";
import {
  matchingBootstrapLeader,
  planExistingBootstrapLeader,
} from "./server-provisioning-leader-policy.mjs";
import { windowsServerProvisioningArtifactConfig } from "./server-provisioning-artifact-config.mjs";

const { Pool } = pg;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function regularFile(filename) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

async function atomicMarker(filename, protocol) {
  const temporaryPath = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${protocol}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filename);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeJsonAtomic(filename, value) {
  const temporaryPath = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filename);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function serviceStates(serviceNames) {
  const result = await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      `$names=@('${serviceNames.join("','")}'); ` +
      "$names | ForEach-Object { $service=Get-Service -Name $_ -ErrorAction SilentlyContinue; if($null -eq $service){\"$_=MISSING\"}else{\"$_=$($service.Status)\"} }",
    { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 }
  );
  return new Map(
    result.split(/\r?\n/u).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1).toUpperCase()];
    })
  );
}

async function startPackagedServices(services) {
  await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      `$postgres=Get-Service -Name '${services.postgresql}' -ErrorAction Stop; ` +
      `$console=Get-Service -Name '${services.console}' -ErrorAction Stop; ` +
      "$stopped=[System.ServiceProcess.ServiceControllerStatus]::Stopped; " +
      "$running=[System.ServiceProcess.ServiceControllerStatus]::Running; " +
      "if($console.Status -ne $stopped){Stop-Service -InputObject $console -Force; $console.WaitForStatus($stopped,[TimeSpan]::FromSeconds(60))}; " +
      "if($postgres.Status -ne $stopped){Stop-Service -InputObject $postgres -Force; $postgres.WaitForStatus($stopped,[TimeSpan]::FromSeconds(60))}; " +
      "Start-Service -InputObject $postgres; $postgres.WaitForStatus($running,[TimeSpan]::FromSeconds(60)); " +
      "Start-Service -InputObject $console; $console.WaitForStatus($running,[TimeSpan]::FromSeconds(60)); 'RUNNING'",
    { timeoutMs: 130_000, maxOutputBytes: 64 * 1024 }
  );
}

async function firewallRuleReady(packageRoot, firewallRuleName) {
  const nodePath = path.join(packageRoot, "runtime", "node", "node.exe");
  const encodedPath = Buffer.from(nodePath, "utf8").toString("base64");
  const result = await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      "$program=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())); " +
      `$rules=@(Get-NetFirewallRule -DisplayName '${firewallRuleName}' -ErrorAction SilentlyContinue); ` +
      "if($rules.Count -ne 1){'NOT_READY'; exit 0}; " +
      "$rule=$rules[0]; $application=$rule | Get-NetFirewallApplicationFilter; $port=$rule | Get-NetFirewallPortFilter; $address=$rule | Get-NetFirewallAddressFilter; " +
      "if($rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and $rule.Enabled -eq 'True' -and $application.Program -eq $program -and $port.Protocol -eq 'TCP' -and $port.LocalPort -eq '3443' -and @($address.RemoteAddress) -contains 'LocalSubnet'){'READY'}else{'NOT_READY'}",
    { inputLine: encodedPath, timeoutMs: 60_000, maxOutputBytes: 64 * 1024 }
  );
  return result === "READY";
}

async function ensureFirewallRule(packageRoot, firewallRuleName) {
  const nodePath = path.join(packageRoot, "runtime", "node", "node.exe");
  const encodedPath = Buffer.from(nodePath, "utf8").toString("base64");
  await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      "$program=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())); " +
      `Get-NetFirewallRule -DisplayName '${firewallRuleName}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop; ` +
      `New-NetFirewallRule -DisplayName '${firewallRuleName}' -Description 'Allows encrypted QuickHack client access from the local subnet.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3443 -Program $program -RemoteAddress LocalSubnet -Profile Any -Enabled True | Out-Null; 'READY'`,
    { inputLine: encodedPath, timeoutMs: 60_000, maxOutputBytes: 64 * 1024 }
  );
}

async function assertNoOppositeServer(config) {
  const result = await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      `$package=Get-AppxPackage -Name '${config.opposite.identityName}' -ErrorAction SilentlyContinue; ` +
      `$service=@('${config.opposite.services.join("','")}') | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue } | Select-Object -First 1; ` +
      "if($null -ne $package -or $null -ne $service){'CONFLICT'}else{'CLEAR'}",
    { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 }
  );
  if (result !== "CLEAR") {
    throw failure(
      "OPPOSITE_SERVER_FLAVOR_PRESENT",
      `The ${config.opposite.packageTarget} package or service is already present.`
    );
  }
}

export function createWindowsServerProvisioningAdapter(input) {
  if (process.platform !== "win32") {
    throw failure("PROVISIONING_PLATFORM_UNSUPPORTED", "Windows server provisioning requires Windows.");
  }
  const config = windowsServerProvisioningArtifactConfig(input?.artifactKind);
  const packageRoot = path.resolve(String(input?.packageRoot ?? ""));
  const programData = path.resolve(String(input?.programData ?? ""));
  const mutableRoot = path.join(programData, "QuickHack", config.mutableRootName);
  const dataDir = path.join(mutableRoot, "data");
  const runtimeConfigPath = path.join(mutableRoot, "config", "server-runtime.json");
  const provisioningRoot = path.join(mutableRoot, "provisioning");
  const packageManifestPath = path.join(packageRoot, "quickhack-package.json");
  const postgresMarker = path.join(provisioningRoot, "POSTGRES_CLUSTER_READY");
  const servicesMarker = path.join(provisioningRoot, "SERVICES_READY");
  const readyMarker = path.join(provisioningRoot, "READY");
  const journal = input?.journal;
  const allowExistingLeaderAdoption = input?.allowExistingLeaderAdoption === true;

  async function assertPreflight() {
    const build = Number(os.release().split(".")[2] ?? 0);
    if (!Number.isSafeInteger(build) || build < 19041) {
      throw failure("UNSUPPORTED_WINDOWS_VERSION", "QuickHack Server MSIX requires Windows build 19041 or newer.");
    }
    const manifest = JSON.parse(await fs.readFile(packageManifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.artifactKind !== config.artifactKind) {
      throw failure("PACKAGE_FLAVOR_MISMATCH", "The installed package manifest does not match Server Setup.");
    }
    for (const filename of [
      path.join(packageRoot, "runtime", "node", "node.exe"),
      path.join(packageRoot, "runtime", "postgresql", "bin", "postgres.exe"),
      path.join(packageRoot, "Services", "QuickHackPostgresqlServiceHost.exe"),
      path.join(packageRoot, "Services", "QuickHackServerServiceHost.exe"),
    ]) {
      if (!(await regularFile(filename))) {
        throw failure("RUNTIME_INTEGRITY_FAILED", "A required package runtime file is missing.");
      }
    }
    await assertNoOppositeServer(config);
    const legacy = classifyLegacyWindowsInstall({
      target: config.packageTarget,
      observation: await observeLegacyWindowsInstall({
        target: config.packageTarget,
        packageRoot,
        programData,
      }),
    });
    if (legacy.classification === "OPPOSITE") {
      throw failure("OPPOSITE_SERVER_FLAVOR_PRESENT", "The opposite QuickHack server flavor is present.");
    }
    if (legacy.classification === "AMBIGUOUS") {
      throw failure("LEGACY_INSTALL_AMBIGUOUS", "Legacy QuickHack state requires manual diagnosis before provisioning.");
    }
    if (legacy.classification === "INCOMPATIBLE") {
      throw failure(legacy.reasonCode, "Legacy QuickHack state is incompatible with this package.");
    }
    if (legacy.classification === "COMPATIBLE" && legacy.mode === "INSTALLED_INNO") {
      throw failure("LEGACY_INSTALL_MIGRATION_REQUIRED", "Run the explicit legacy migration action before provisioning.");
    }
    return true;
  }

  async function stateRootReady() {
    if (!(await regularFile(runtimeConfigPath))) return false;
    try {
      const loaded = readServerRuntimeConfigSync({
        configPath: runtimeConfigPath,
        kind: "operational",
      }).config;
      return loaded.packageFlavor === config.expectedFlavor && path.resolve(loaded.dataDirectory) === dataDir;
    } catch {
      return false;
    }
  }

  async function prepareStateRoot() {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await secureWindowsDirectoryAcl(mutableRoot, { includeNetworkService: true });
    await writeJsonAtomic(runtimeConfigPath, {
      schemaVersion: 3,
      packageFlavor: config.expectedFlavor,
      environment: "production",
      coupangWriteApiEnabled: false,
      logenWriteApiEnabled: false,
      dataDirectory: dataDir,
      backupRetentionCount: 30,
      database: config.runtimeDatabase,
    });
  }

  async function credentialsReady() {
    return (
      await Promise.all(
        postgresqlRoleKindsForFlavor(config.expectedFlavor).map((role) =>
          regularFile(postgresqlCredentialPath(role, dataDir))
        )
      )
    ).every(Boolean);
  }

  async function installDatabaseRuntime() {
    await installPostgresqlService({
      installDir: packageRoot,
      dataDir,
      runtimeConfig: runtimeConfigPath,
      serviceName: config.services.postgresql,
      serviceOwnership: "PACKAGED",
    });
  }

  async function postgresReady() {
    const versionPath = path.join(
      dataDir,
      "postgresql",
      String(POSTGRESQL_MAJOR_VERSION),
      "data",
      "PG_VERSION"
    );
    if (!(await regularFile(postgresMarker)) || !(await regularFile(versionPath))) return false;
    const version = String(await fs.readFile(versionPath, "utf8")).trim();
    if (version !== String(POSTGRESQL_MAJOR_VERSION)) return false;
    return (await serviceStates([config.services.postgresql])).get(config.services.postgresql) === "RUNNING";
  }

  async function schemaReady() {
    try {
      return (await auditPostgresqlSchema()).ok === true;
    } catch {
      return false;
    }
  }

  async function bootstrapUsers() {
    const pool = new Pool({
      connectionString: resolvePostgresqlConnectionStringSync({
        role: "migrator",
        applicationName: "quickhack-initial-leader-probe",
        runtimeConfigPath,
      }),
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
    try {
      const result = await pool.query(
        `SELECT user_id, username, role, must_change_password, is_active, credential_revision
         FROM users
         ORDER BY user_id`
      );
      return result.rows;
    } finally {
      await pool.end();
    }
  }

  async function leaderState() {
    const record = await journal.read();
    if (!record?.initialLeader?.acknowledgedAt) return { ready: false };
    const rows = await bootstrapUsers();
    const leader = rows.find((row) => Number(row.user_id) === record.initialLeader.userId);
    return { ready: rows.length >= 1 && matchingBootstrapLeader(leader) };
  }

  async function provisionLeader() {
    const record = await journal.read();
    if (record?.initialLeader?.acknowledgedAt) {
      throw failure(
        "INITIAL_LEADER_STATE_CONFLICT",
        "The acknowledged initial LEADER no longer matches observed database state."
      );
    }
    let pending = record?.initialLeader
      ? {
          userId: record.initialLeader.userId,
          generation: record.initialLeader.generation,
        }
      : null;
    if (!pending) {
      const rows = await bootstrapUsers();
      const plan = planExistingBootstrapLeader(rows, { allowExistingLeaderAdoption });
      if (plan.action === "ADOPT") {
        await journal.setInitialLeaderPending({
          transactionId: record.transactionId,
          userId: plan.userId,
          generation: plan.generation,
        });
        await journal.acknowledgeInitialLeader({
          transactionId: record.transactionId,
          generation: plan.generation,
        });
        return { changed: false, adoptedExistingLeader: true };
      }
      if (plan.action === "REISSUE") {
        pending = {
          userId: plan.userId,
          generation: plan.generation,
        };
      } else if (plan.action === "CONFLICT") {
        throw failure(
          "INITIAL_LEADER_STATE_CONFLICT",
          "Existing users cannot be adopted as the protected initial LEADER handoff."
        );
      }
    }
    const result = await provisionInitialLeaderHandoff({
      pending,
    });
    if (result.status === "ALREADY_INITIALIZED") {
      throw failure(
        "INITIAL_LEADER_STATE_CONFLICT",
        "Initial LEADER provisioning did not produce an acknowledgeable credential."
      );
    }
    return {
      pendingAcknowledgement: true,
      userId: result.userId,
      generation: result.generation,
      handoff: Object.freeze({
        status: result.status,
        userId: result.userId,
        generation: result.generation,
        username: result.username,
        temporaryPassword: result.temporaryPassword,
      }),
    };
  }

  async function servicesReady() {
    if (!(await regularFile(servicesMarker))) return false;
    const states = await serviceStates(Object.values(config.services));
    return (
      states.get(config.services.postgresql) === "RUNNING" &&
      states.get(config.services.console) === "RUNNING" &&
      (await firewallRuleReady(packageRoot, config.firewallRuleName))
    );
  }

  async function finalReady() {
    return (await regularFile(readyMarker)) && (await servicesReady()) && (await schemaReady()) && (await leaderState()).ready;
  }

  async function probe(step) {
    switch (step.id) {
      case "PREFLIGHT": return { ready: await assertPreflight() };
      case "STATE_ROOT": return { ready: await stateRootReady() };
      case "CREDENTIALS": return { ready: await credentialsReady() };
      case "POSTGRES_CLUSTER": return { ready: await postgresReady() };
      case "SCHEMA": return { ready: await schemaReady() };
      case "INITIAL_LEADER": return leaderState();
      case "SERVICES": return { ready: await servicesReady() };
      case "FINAL_READINESS": return { ready: await finalReady() };
      default: throw failure("PROVISIONING_STEP_INVALID", "Unknown server provisioning step.");
    }
  }

  async function mutate(step) {
    switch (step.id) {
      case "PREFLIGHT": await assertPreflight(); return { changed: false };
      case "STATE_ROOT": await prepareStateRoot(); return { changed: true };
      case "CREDENTIALS": await installDatabaseRuntime(); return { changed: true };
      case "POSTGRES_CLUSTER": await installDatabaseRuntime(); return { changed: true };
      case "SCHEMA": await deployPostgresqlMigrations(); return { changed: true };
      case "INITIAL_LEADER": return provisionLeader();
      case "SERVICES":
        await ensureFirewallRule(packageRoot, config.firewallRuleName);
        await atomicMarker(servicesMarker, "QUICKHACK_SERVICES_READY_V1");
        await startPackagedServices(config.services);
        return { changed: true };
      case "FINAL_READINESS":
        await atomicMarker(readyMarker, "QUICKHACK_SERVER_READY_V1");
        return { changed: true };
      default: throw failure("PROVISIONING_STEP_INVALID", "Unknown server provisioning step.");
    }
  }

  async function postcondition(step) {
    return probe(step);
  }

  return Object.freeze({
    paths: Object.freeze({
      packageRoot,
      mutableRoot,
      dataDir,
      runtimeConfigPath,
      provisioningRoot,
    }),
    probe,
    mutate,
    postcondition,
  });
}
