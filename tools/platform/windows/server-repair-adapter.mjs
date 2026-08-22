import fs from "node:fs/promises";
import path from "node:path";
import { classifyLegacyWindowsInstall } from "../../../packaging/windows/msix/legacy-install-detector.mjs";
import { msixArtifactConfig } from "../../../packaging/windows/msix/msix-artifact-config.mjs";
import { packageArtifactContract } from "../../../packaging/package-artifact-contract.mjs";
import { verifyMsixPackage } from "../../verify-msix-package.mjs";
import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";
import { observeLegacyWindowsInstall } from "./legacy-install-observer.mjs";
import { inspectWindowsServerSecretScopes } from "./server-secret-scope-migration.mjs";

const STATE_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json
$root = [string]$request.root
$firewallName = [string]$request.firewallName
$serviceStates = [ordered]@{}
foreach ($name in @($request.serviceNames)) {
  $serviceName = [string]$name
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  $serviceStates[$serviceName] = if ($null -eq $service) {
    'MISSING'
  } else {
    $service.Status.ToString().ToUpperInvariant()
  }
}
$aclReady = $false
if (Test-Path -LiteralPath $root -PathType Container) {
  $acl = Get-Acl -LiteralPath $root
  $expected = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    'S-1-5-18',
    'S-1-5-20',
    'S-1-5-32-544'
  )
  $observed = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  $aclReady = $acl.AreAccessRulesProtected -and @($expected | Where-Object { $observed -notcontains $_ }).Count -eq 0
}
$rules = @(Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue)
[ordered]@{
  aclReady = $aclReady
  firewallReady = $rules.Count -eq 1
  serviceStates = $serviceStates
} | ConvertTo-Json -Compress
`;

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

export function createWindowsServerRepairAdapter(input) {
  if (process.platform !== "win32" && input?.allowNonWindows !== true) {
    throw failure("PROVISIONING_PLATFORM_UNSUPPORTED", "Windows server repair requires Windows.");
  }
  const config = msixArtifactConfig(
    packageArtifactContract(input?.target ?? input?.artifactKind).packageTarget
  );
  if (config.role !== "server") throw failure("LEGACY_INSTALL_TARGET_INVALID", "Server repair requires a server artifact.");
  const packageRoot = path.win32.resolve(String(input?.packageRoot ?? ""));
  const programData = path.win32.resolve(String(input?.programData ?? ""));
  const mutableRoot = path.win32.join(programData, "QuickHack", config.mutableRootName);
  const dataDir = path.win32.join(mutableRoot, "data");
  const logDirectory = path.win32.join(mutableRoot, "logs");
  const observer = input?.observe ?? observeLegacyWindowsInstall;
  const runPowerShell = input?.runPowerShellScript ?? runPowerShellScript;
  if (typeof input?.provision !== "function") throw new TypeError("Windows server repair requires provision().");

  async function packageStatus(observation) {
    let contentVerified = false;
    try {
      const evidence = JSON.parse(await fs.readFile(path.win32.join(packageRoot, "quickhack-msix-build.json"), "utf8"));
      const revision = Number(String(evidence.msixVersion ?? "").split(".")[3]);
      verifyMsixPackage({
        directory: packageRoot,
        target: config.packageTarget,
        version: evidence.semanticVersion,
        revision,
        publisher: evidence.publisher,
        signatureMode: "SIGNED",
        includeServices: true,
        includeServerSetup: true,
      });
      contentVerified = true;
    } catch {}
    const registered = (observation.packages ?? []).find((item) => item.identityName === config.identityName);
    let manifestMatches = false;
    try {
      const manifest = JSON.parse(await fs.readFile(path.win32.join(packageRoot, "quickhack-package.json"), "utf8"));
      manifestMatches = manifest.schemaVersion === 1 && manifest.artifactKind === config.artifactKind;
    } catch {}
    const requiredFilesRegular = (
      await Promise.all([
        "runtime\\node\\node.exe",
        "runtime\\postgresql\\bin\\postgres.exe",
        "Services\\QuickHackPostgresqlServiceHost.exe",
        "Services\\QuickHackServerServiceHost.exe",
      ].map((relative) => regularFile(path.win32.join(packageRoot, relative))))
    ).every(Boolean);
    return {
      registered: Boolean(registered),
      identityMatches: Boolean(registered && path.win32.normalize(registered.installLocation).toLowerCase() === packageRoot.toLowerCase()),
      manifestMatches,
      requiredFilesRegular,
      contentVerified,
    };
  }

  async function diagnose() {
    const observation = await observer({ target: config.packageTarget, packageRoot, programData });
    const legacy = classifyLegacyWindowsInstall({ target: config.packageTarget, observation });
    const stateExists = observation.state?.exists === true;
    const expectedServices = new Set(config.services.map((service) => service.name));
    const securityRequest = Buffer.from(JSON.stringify({
      root: mutableRoot,
      firewallName: "QuickHack HTTPS Server (Local Subnet)",
      serviceNames: [...expectedServices],
    }), "utf8").toString("base64");
    const security = stateExists
      ? JSON.parse(await runPowerShell(STATE_SECURITY_SCRIPT, {
          inputLine: securityRequest,
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024,
        }))
      : { aclReady: false, firewallReady: false, serviceStates: {} };
    const servicesReady = [...expectedServices].every((name) =>
      String(security.serviceStates?.[name] ?? "").toUpperCase() === "RUNNING"
    );
    let secretScopes = [];
    if (stateExists) {
      try { secretScopes = await inspectWindowsServerSecretScopes({ dataDir }); } catch {
        secretScopes = [{ scope: "UNREADABLE" }];
      }
    }
    let provisioningReady = false;
    try {
      const markerReady = await regularFile(path.win32.join(mutableRoot, "provisioning", "READY"));
      const journal = JSON.parse(await fs.readFile(
        path.win32.join(mutableRoot, "provisioning", "server-provisioning-v1.json"),
        "utf8"
      ));
      provisioningReady = markerReady && journal.state === "READY";
    } catch {}
    return {
      logDirectory,
      package: await packageStatus(observation),
      state: {
        exists: stateExists,
        reparsePoint: observation.state?.reparsePoint === true,
        legacyMode: legacy.classification === "COMPATIBLE" ? legacy.mode : null,
        runtimeConfig: legacy.classification === "INCOMPATIBLE"
          ? "INCOMPATIBLE"
          : stateExists && legacy.classification === "COMPATIBLE"
            ? "MATCH"
            : stateExists
              ? "DRIFTED"
              : "MISSING",
        acl: security.aclReady ? "READY" : "DRIFTED",
        services: legacy.classification === "OPPOSITE"
          ? "CONFLICT"
          : servicesReady ? "READY" : "DRIFTED",
        firewall: security.firewallReady ? "READY" : "DRIFTED",
      },
      database: {
        integrity: provisioningReady ? "PASSED" : "UNKNOWN",
        schema: legacy.classification === "INCOMPATIBLE"
          ? "INCOMPATIBLE"
          : provisioningReady ? "CURRENT" : "MIGRATABLE",
        credentials: secretScopes.some((descriptor) => descriptor.scope === "UNREADABLE")
          ? "UNREADABLE"
          : secretScopes.length === 0
            ? "MISSING"
            : secretScopes.every((descriptor) => descriptor.scope === "LOCAL_MACHINE")
              ? "READABLE"
              : "UNREADABLE",
      },
    };
  }

  async function repair() {
    const result = await input.provision();
    if (result?.state !== "READY") {
      throw failure("INITIAL_LEADER_ACK_REQUIRED", "Product repair requires initial leader acknowledgement.");
    }
    return result;
  }

  return Object.freeze({ diagnose, repair, logDirectory });
}

export const SERVER_REPAIR_STATE_SECURITY_SCRIPT = STATE_SECURITY_SCRIPT;
