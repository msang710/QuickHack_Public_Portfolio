import path from "node:path";
import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";
import { msixArtifactConfig } from "../../../packaging/windows/msix/msix-artifact-config.mjs";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serverConfigs(value) {
  const own = msixArtifactConfig(value);
  if (own.role !== "server") {
    throw failure("LEGACY_INSTALL_TARGET_INVALID", "Legacy observation requires a server artifact.");
  }
  const opposite = msixArtifactConfig(
    own.packageTarget === "demo-server" ? "operational-server" : "demo-server"
  );
  return { own, opposite };
}

function serviceNames(config) {
  return config.services.map((service) => service.name);
}

const OBSERVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json

function Read-UninstallRegistration([string]$appId) {
  $registryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($appId)_is1"
  if (-not (Test-Path -LiteralPath $registryPath -PathType Container)) { return $null }
  $item = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
  $command = if ([string]::IsNullOrWhiteSpace([string]$item.QuietUninstallString)) {
    [string]$item.UninstallString
  } else {
    [string]$item.QuietUninstallString
  }
  $uninstaller = ''
  if ($command.StartsWith('"')) {
    $end = $command.IndexOf('"', 1)
    if ($end -gt 1) { $uninstaller = $command.Substring(1, $end - 1) }
  } elseif ($command -match '^(.*?\.exe)(?:\s|$)') {
    $uninstaller = $Matches[1]
  }
  $regular = $false
  if (-not [string]::IsNullOrWhiteSpace($uninstaller) -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    $file = Get-Item -LiteralPath $uninstaller -Force
    $regular = ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  }
  return [ordered]@{
    appId = $appId
    displayName = [string]$item.DisplayName
    displayVersion = [string]$item.DisplayVersion
    installLocation = [string]$item.InstallLocation
    uninstallString = [string]$item.UninstallString
    quietUninstallString = [string]$item.QuietUninstallString
    uninstallerRegularFile = $regular
  }
}

$serviceNames = @($request.ownServices) + @($request.oppositeServices) + @('QuickHackPostgreSQL')
$services = @(
  Get-CimInstance -ClassName Win32_Service -ErrorAction Stop |
    Where-Object { $serviceNames -contains $_.Name } |
    ForEach-Object {
      [ordered]@{
        name = [string]$_.Name
        pathName = [string]$_.PathName
        status = [string]$_.State
        startName = [string]$_.StartName
      }
    }
)
$packages = @(
  Get-AppxPackage -Name $request.ownIdentity -ErrorAction SilentlyContinue
  Get-AppxPackage -Name $request.oppositeIdentity -ErrorAction SilentlyContinue
) | Where-Object { $null -ne $_ } | ForEach-Object {
  [ordered]@{ identityName = [string]$_.Name; installLocation = [string]$_.InstallLocation }
}

$stateRoot = Join-Path $request.programData "QuickHack\$($request.mutableRootName)"
$stateExists = Test-Path -LiteralPath $stateRoot -PathType Container
$stateReparse = $false
$runtimeConfig = $null
$postgresqlMajor = $null
if ($stateExists) {
  $stateItem = Get-Item -LiteralPath $stateRoot -Force
  $stateReparse = ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if (-not $stateReparse) {
    $runtimeConfigPath = Join-Path $stateRoot 'config\server-runtime.json'
    if (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf) {
      $parsed = Get-Content -LiteralPath $runtimeConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
      $runtimeConfig = [ordered]@{
        schemaVersion = $parsed.schemaVersion
        packageFlavor = [string]$parsed.packageFlavor
        dataDirectory = [string]$parsed.dataDirectory
      }
    }
    $pgVersionPath = Join-Path $stateRoot "data\postgresql\$($request.postgresqlMajor)\data\PG_VERSION"
    if (Test-Path -LiteralPath $pgVersionPath -PathType Leaf) {
      $postgresqlMajor = (Get-Content -LiteralPath $pgVersionPath -Raw -Encoding ascii).Trim()
    }
  }
}

$result = [ordered]@{
  programFiles = [string]$env:ProgramFiles
  programData = [string]$request.programData
  packageRoot = [string]$request.packageRoot
  registry = [ordered]@{
    own = Read-UninstallRegistration ([string]$request.ownAppId)
    opposite = Read-UninstallRegistration ([string]$request.oppositeAppId)
  }
  packages = @($packages)
  services = @($services)
  sharedLegacyService = @($services | Where-Object name -eq 'QuickHackPostgreSQL').Count -gt 0
  state = [ordered]@{
    exists = $stateExists
    root = $stateRoot
    reparsePoint = $stateReparse
    runtimeConfig = $runtimeConfig
    postgresqlMajor = $postgresqlMajor
  }
}
$result | ConvertTo-Json -Depth 8 -Compress
`;

export async function observeLegacyWindowsInstall(input) {
  if (process.platform !== "win32" && input?.allowNonWindows !== true) {
    throw failure("LEGACY_INSTALL_PLATFORM_UNSUPPORTED", "Legacy Windows observation requires Windows.");
  }
  const { own, opposite } = serverConfigs(input?.target ?? input?.artifactKind);
  const packageRoot = path.win32.resolve(String(input?.packageRoot ?? ""));
  const programData = path.win32.resolve(String(input?.programData ?? ""));
  if (!path.win32.isAbsolute(packageRoot) || !path.win32.isAbsolute(programData)) {
    throw failure("LEGACY_INSTALL_OBSERVATION_INVALID", "Package root and ProgramData must be absolute Windows paths.");
  }
  const request = {
    ownAppId: own.legacyAppId,
    oppositeAppId: opposite.legacyAppId,
    ownIdentity: own.identityName,
    oppositeIdentity: opposite.identityName,
    ownServices: serviceNames(own),
    oppositeServices: serviceNames(opposite),
    mutableRootName: own.mutableRootName,
    postgresqlMajor: 18,
    packageRoot,
    programData,
  };
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const source = await (input?.runPowerShellScript ?? runPowerShellScript)(OBSERVE_SCRIPT, {
    inputLine: encoded,
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
  });
  try {
    return Object.freeze(JSON.parse(source));
  } catch {
    throw failure("LEGACY_INSTALL_OBSERVATION_INVALID", "Legacy Windows observation returned invalid JSON.");
  }
}

export const LEGACY_INSTALL_OBSERVE_SCRIPT = OBSERVE_SCRIPT;
