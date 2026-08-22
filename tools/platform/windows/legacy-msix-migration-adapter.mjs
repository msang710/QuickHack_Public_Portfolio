import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { classifyLegacyWindowsInstall } from "../../../packaging/windows/msix/legacy-install-detector.mjs";
import { msixArtifactConfig } from "../../../packaging/windows/msix/msix-artifact-config.mjs";
import { packageArtifactContract } from "../../../packaging/package-artifact-contract.mjs";
import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";
import { observeLegacyWindowsInstall } from "./legacy-install-observer.mjs";
import {
  inspectWindowsServerSecretScopes,
  migrateWindowsServerSecretScope,
} from "./server-secret-scope-migration.mjs";

const execFileAsync = promisify(execFile);
const STOP_SERVICES_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$names = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json
foreach ($name in @($names)) {
  $service = Get-Service -Name ([string]$name) -ErrorAction SilentlyContinue
  if ($null -ne $service -and $service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
    Stop-Service -InputObject $service -Force -ErrorAction Stop
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60))
  }
}
'STOPPED'
`;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameWindowsPath(left, right) {
  const normalize = (value) => path.win32.normalize(String(value ?? "")).replace(/[\\/]+$/u, "").toLowerCase();
  return Boolean(left && right && normalize(left) === normalize(right));
}

async function regularFile(filename) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

async function boundedSnapshot(discovery, config, programData) {
  const stateRoot = path.win32.join(programData, "QuickHack", config.mutableRootName);
  const candidates = discovery.stateRoot
    ? [
        path.win32.join(stateRoot, "config", "server-runtime.json"),
        path.win32.join(stateRoot, "data", "postgresql", "18", "data", "PG_VERSION"),
        path.win32.join(stateRoot, "provisioning", "server-provisioning-v1.json"),
      ]
    : [];
  const inventory = [];
  for (const filename of candidates) {
    if (!(await regularFile(filename))) continue;
    const bytes = await fs.readFile(filename);
    inventory.push({
      relativePath: path.win32.relative(stateRoot, filename).replaceAll("\\", "/"),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const inventorySha256 = createHash("sha256")
    .update(JSON.stringify(inventory.sort((a, b) => a.relativePath.localeCompare(b.relativePath))))
    .digest("hex");
  return Object.freeze({
    schemaVersion: 1,
    stateExists: Boolean(discovery.stateRoot),
    stateRoot: discovery.stateRoot,
    inventorySha256,
    legacyInstallRoot: discovery.legacyInstallRoot,
    legacyUninstaller: discovery.legacyUninstaller,
    legacyServices: Object.freeze([...(discovery.legacyServices ?? [])]),
  });
}

export function createWindowsLegacyMsixMigrationAdapter(input) {
  if (process.platform !== "win32" && input?.allowNonWindows !== true) {
    throw failure("LEGACY_INSTALL_PLATFORM_UNSUPPORTED", "Legacy migration adapter requires Windows.");
  }
  const config = msixArtifactConfig(
    packageArtifactContract(input?.target ?? input?.artifactKind).packageTarget
  );
  if (config.role !== "server") throw failure("LEGACY_INSTALL_TARGET_INVALID", "Legacy migration requires a server artifact.");
  const packageRoot = path.win32.resolve(String(input?.packageRoot ?? ""));
  const programData = path.win32.resolve(String(input?.programData ?? ""));
  const observer = input?.observe ?? observeLegacyWindowsInstall;
  const runPowerShell = input?.runPowerShellScript ?? runPowerShellScript;
  const runExecutable = input?.execFile ?? execFileAsync;
  const provision = input?.provision;
  if (typeof provision !== "function") throw new TypeError("Legacy migration adapter requires provision().");
  let currentDiscovery = null;
  let provisioningConverged = false;

  async function discover(context) {
    const observation = await observer({
      target: config.packageTarget,
      packageRoot,
      programData,
    });
    let result = classifyLegacyWindowsInstall({ target: config.packageTarget, observation });
    if (
      context?.record?.mode === "INSTALLED_INNO" &&
      context.record.completedSteps.includes("REMOVE_LEGACY_BINARY") &&
      result.classification === "NONE"
    ) {
      result = Object.freeze({
        classification: "COMPATIBLE",
        reasonCode: "LEGACY_BINARY_ALREADY_REMOVED",
        mutationAllowed: true,
        mode: "INSTALLED_INNO",
        stateRoot: context.record.snapshot?.stateRoot ?? null,
        legacyInstallRoot: context.record.snapshot?.legacyInstallRoot ?? null,
        legacyUninstaller: context.record.snapshot?.legacyUninstaller ?? null,
        legacyServices: context.record.snapshot?.legacyServices ?? Object.freeze([]),
      });
    }
    currentDiscovery = result;
    return { observation, discovery: result };
  }

  async function provePackage() {
    const manifestPath = path.win32.join(packageRoot, "quickhack-package.json");
    if (!(await regularFile(manifestPath))) return false;
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { return false; }
    if (manifest?.schemaVersion !== 1 || manifest?.artifactKind !== config.artifactKind) return false;
    for (const relative of [
      "runtime\\node\\node.exe",
      "runtime\\postgresql\\bin\\postgres.exe",
      "Services\\QuickHackPostgresqlServiceHost.exe",
      "Services\\QuickHackServerServiceHost.exe",
    ]) {
      if (!(await regularFile(path.win32.join(packageRoot, relative)))) return false;
    }
    const observed = await observer({ target: config.packageTarget, packageRoot, programData });
    return (observed.packages ?? []).some((item) =>
      item.identityName === config.identityName && sameWindowsPath(item.installLocation, packageRoot)
    );
  }

  async function stateAttached(snapshot) {
    if (!snapshot?.stateExists) return true;
    const observed = await observer({ target: config.packageTarget, packageRoot, programData });
    const result = classifyLegacyWindowsInstall({ target: config.packageTarget, observation: observed });
    return result.classification === "COMPATIBLE" && Boolean(result.stateRoot);
  }

  async function credentialScopeReady(snapshot) {
    if (!snapshot?.stateExists) return true;
    const dataDir = path.win32.join(snapshot.stateRoot, "data");
    const files = await inspectWindowsServerSecretScopes({ dataDir });
    return files.every((descriptor) => descriptor.scope === "LOCAL_MACHINE");
  }

  async function probe(step, context) {
    if (step.id === "DISCOVER") {
      const result = await discover(context);
      return { ready: true, discovery: result.discovery };
    }
    if (step.id === "SNAPSHOT") {
      if (!context.record.snapshot) return { ready: false };
      const current = await boundedSnapshot(currentDiscovery, config, programData);
      return { ready: current.inventorySha256 === context.record.snapshot.inventorySha256 };
    }
    if (step.id === "STOP_LEGACY_SERVICES") {
      const observed = await observer({ target: config.packageTarget, packageRoot, programData });
      const names = new Set(context.record.snapshot?.legacyServices ?? []);
      return {
        ready: (observed.services ?? [])
          .filter((service) => names.has(service.name))
          .every((service) => service.status === "STOPPED"),
      };
    }
    if (step.id === "REMOVE_LEGACY_BINARY") {
      const observed = await observer({ target: config.packageTarget, packageRoot, programData });
      const installRoot = context.record.snapshot?.legacyInstallRoot;
      const installRootExists = installRoot
        ? await fs.lstat(installRoot).then(() => true).catch((error) => error?.code === "ENOENT" ? false : Promise.reject(error))
        : false;
      return { ready: !observed.registry?.own && !installRootExists };
    }
    if (step.id === "PROVE_MSIX") return { ready: await provePackage() };
    if (step.id === "ATTACH_STATE") return { ready: await stateAttached(context.record.snapshot) };
    if (step.id === "REPROTECT_CREDENTIALS") {
      return { ready: await credentialScopeReady(context.record.snapshot) };
    }
    if (step.id === "CONVERGE_PROVISIONING") return { ready: provisioningConverged };
    if (step.id === "READY") {
      return { ready: provisioningConverged && await provePackage() && await stateAttached(context.record.snapshot) };
    }
    throw failure("LEGACY_MIGRATION_STEP_INVALID", "Unknown legacy migration step.");
  }

  async function mutate(step, context) {
    if (step.id === "SNAPSHOT") {
      return { snapshot: await boundedSnapshot(currentDiscovery, config, programData) };
    }
    if (step.id === "STOP_LEGACY_SERVICES") {
      const names = context.record.snapshot?.legacyServices ?? [];
      if (names.length > 0) {
        await runPowerShell(STOP_SERVICES_SCRIPT, {
          inputLine: Buffer.from(JSON.stringify(names), "utf8").toString("base64"),
          timeoutMs: 130_000,
          maxOutputBytes: 64 * 1024,
        });
      }
      return {};
    }
    if (step.id === "REMOVE_LEGACY_BINARY") {
      const uninstaller = context.record.snapshot?.legacyUninstaller;
      if (uninstaller) {
        await runExecutable(
          uninstaller,
          ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
          { cwd: path.win32.dirname(uninstaller), windowsHide: true, timeout: 10 * 60_000, shell: false }
        );
      }
      return {};
    }
    if (step.id === "PROVE_MSIX") {
      throw failure("RUNTIME_INTEGRITY_FAILED", "Installed MSIX package proof failed.");
    }
    if (step.id === "ATTACH_STATE") {
      if (!(await stateAttached(context.record.snapshot))) {
        throw failure("STATE_SCHEMA_INCOMPATIBLE", "Preserved legacy state is no longer compatible.");
      }
      return {};
    }
    if (step.id === "REPROTECT_CREDENTIALS") {
      if (context.record.snapshot?.stateExists) {
        await migrateWindowsServerSecretScope({
          dataDir: path.win32.join(context.record.snapshot.stateRoot, "data"),
        });
      }
      return {};
    }
    if (step.id === "CONVERGE_PROVISIONING") {
      const result = await provision();
      if (result?.state !== "READY") {
        throw failure("LEGACY_STATE_LEADER_MISSING", "Legacy state unexpectedly requires initial leader provisioning.");
      }
      provisioningConverged = true;
      return {};
    }
    if (step.id === "READY") {
      if (!provisioningConverged) {
        throw failure("LEGACY_MIGRATION_PROVISIONING_NOT_READY", "Provisioning did not converge before migration readiness.");
      }
      if (!(await provePackage())) {
        throw failure("RUNTIME_INTEGRITY_FAILED", "Installed MSIX proof changed before migration readiness.");
      }
      if (!(await stateAttached(context.record.snapshot))) {
        throw failure("LEGACY_MIGRATION_STATE_ATTACH_FAILED", "Preserved state proof changed before migration readiness.");
      }
      return {};
    }
    throw failure("LEGACY_MIGRATION_STEP_INVALID", "Legacy migration mutation is invalid.");
  }

  async function postcondition(step, context) {
    if (step.id === "REMOVE_LEGACY_BINARY") {
      const deadline = Date.now() + 30_000;
      do {
        const observed = await probe(step, context);
        if (observed.ready) return observed;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      return { ready: false };
    }
    return probe(step, context);
  }

  return Object.freeze({ config, packageRoot, programData, probe, mutate, postcondition });
}

export const LEGACY_MIGRATION_STOP_SERVICES_SCRIPT = STOP_SERVICES_SCRIPT;
