[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,

  [Parameter(Mandatory = $true)]
  [string]$CertificatePath,

  [string]$EvidencePath = "",

  [switch]$AcknowledgeTestStatePurge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$validationRoot = [IO.Path]::GetFullPath((Join-Path $releaseRoot "windows\msix\pr06-demo-server-test"))
if (-not $EvidencePath) {
  $EvidencePath = Join-Path $releaseRoot "windows\msix\evidence\pr06-demo-server-msix.json"
}
$EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
$identityName = "QuickHack.Demonstration.Server"
$legacyAppId = "{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}"
$legacyRegistryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($legacyAppId)_is1"
$legacyInstallRoot = Join-Path $env:ProgramFiles "QuickHack Demo Server"
$mutableRoot = Join-Path $env:ProgramData "QuickHack\demonstration-server"
$provisioningRoot = Join-Path $mutableRoot "provisioning"
$migrationJournalPath = Join-Path $mutableRoot "migration\legacy-msix-v1.json"
$provisioningJournalPath = Join-Path $provisioningRoot "server-provisioning-v1.json"
$canaryPath = Join-Path $mutableRoot "data\pr06-migration-canary.txt"
$firewallRuleName = "QuickHack HTTPS Server (Local Subnet)"
$services = @("QuickHackDemoServerConsole", "QuickHackDemoPostgreSQL")
$certificateThumbprint = ""
$phaseFailure = $null
$cleanupFailure = $null

foreach ($boundedPath in @($validationRoot, $EvidencePath)) {
  if (-not $boundedPath.StartsWith(
    $releaseRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe QuickHack PR-06 validation path: $boundedPath"
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-NativeArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.Contains('"')) { throw "Native argument contains a quote." }
  return '"' + $Value + '"'
}

function Stop-QuickHackServices {
  foreach ($serviceName in $services) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne "Stopped") {
      Stop-Service -InputObject $service -Force
      $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(60))
    }
  }
}

function Invoke-SetupAction {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("PROVISION", "ACKNOWLEDGE", "MIGRATE", "REPAIR")][string]$Action,
    [Parameter(Mandatory = $true)][string]$InstallLocation,
    [string]$TransactionId = "",
    [int]$Generation = 0
  )
  $setup = Join-Path $InstallLocation "QuickHack-Demo-Server-Setup.exe"
  $arguments = @("--native-test-stdio", $Action)
  if ($Action -eq "ACKNOWLEDGE") {
    if ($TransactionId -notmatch '^[0-9a-fA-F-]{36}$' -or $Generation -lt 1) {
      throw "QuickHack acknowledgement identity is invalid."
    }
    $arguments += @($TransactionId, $Generation.ToString([Globalization.CultureInfo]::InvariantCulture))
  }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $setup
  $startInfo.Arguments = ($arguments | ForEach-Object { Quote-NativeArgument $_ }) -join " "
  $startInfo.WorkingDirectory = $InstallLocation
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["QUICKHACK_SERVER_SETUP_NATIVE_TEST_GATE"] = "PR05_MSIX_GATE"
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "QuickHack Server Setup did not start." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if ($process.ExitCode -ne 0) {
    $errorCode = if ($stderr -match 'errorCode=([A-Z][A-Z0-9_]{2,95})') { $Matches[1] } else { "SERVER_SETUP_NATIVE_TEST_FAILED" }
    throw "QuickHack Server Setup $Action stopped with $errorCode."
  }
  $lines = @($stdout -split "`r?`n" | Where-Object { $_ })
  if ($lines.Count -lt 3 -or $lines[0] -ne "QUICKHACK_SERVER_SETUP_HANDOFF_V1") {
    throw "QuickHack Server Setup returned an invalid handoff."
  }
  $fields = @{}
  foreach ($line in $lines[1..($lines.Count - 1)]) {
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { throw "QuickHack Server Setup returned an invalid field." }
    $fields[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
  }
  return [pscustomobject]@{
    status = [string]$fields.status
    transactionId = [string]$fields.transactionId
    userId = if ($fields.ContainsKey("userId")) { [int]$fields.userId } else { 0 }
    generation = if ($fields.ContainsKey("generation")) { [int]$fields.generation } else { 0 }
    temporaryPassword = if ($fields.ContainsKey("temporaryPassword")) { [string]$fields.temporaryPassword } else { "" }
  }
}

function Convert-CredentialsToCurrentUserScope {
  Add-Type -AssemblyName System.Security
  $credentialRoot = Join-Path $mutableRoot "data\security"
  $credentials = @(Get-ChildItem -LiteralPath $credentialRoot -Filter "*.credential" -File)
  if ($credentials.Count -lt 4) { throw "QuickHack PostgreSQL credential fixture is incomplete." }
  foreach ($credential in $credentials) {
    $source = Get-Content -LiteralPath $credential.FullName -Raw -Encoding utf8
    if ($source -notmatch '^QHPG1\r?\nDPAPI_LOCAL_MACHINE\r?\n([A-Za-z0-9+/=]+)\r?\n$') {
      throw "QuickHack credential is not machine-scoped before the migration fixture."
    }
    $machinePayload = [Convert]::FromBase64String($Matches[1])
    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
      $machinePayload,
      $null,
      [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    try {
      $userPayload = [Security.Cryptography.ProtectedData]::Protect(
        $plain,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      try {
        $replacement = "QHPG1`nDPAPI_CURRENT_USER`n$([Convert]::ToBase64String($userPayload))`n"
        [IO.File]::WriteAllText($credential.FullName, $replacement, [Text.UTF8Encoding]::new($false))
      } finally {
        [Array]::Clear($userPayload, 0, $userPayload.Length)
      }
    } finally {
      [Array]::Clear($plain, 0, $plain.Length)
      [Array]::Clear($machinePayload, 0, $machinePayload.Length)
    }
  }
}

function Assert-MachineScopeCredentials {
  $credentials = @(Get-ChildItem -LiteralPath (Join-Path $mutableRoot "data\security") -Filter "*.credential" -File)
  if ($credentials.Count -lt 4) { throw "QuickHack PostgreSQL credentials are incomplete." }
  foreach ($credential in $credentials) {
    if ((Get-Content -LiteralPath $credential.FullName -Raw -Encoding utf8) -notmatch '^QHPG1\r?\nDPAPI_LOCAL_MACHINE\r?\n') {
      throw "QuickHack legacy credential was not reprotected for the machine."
    }
  }
}

function New-LegacyUninstallerFixture {
  New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $legacyInstallRoot -Force | Out-Null
  $sourcePath = Join-Path $validationRoot "LegacyUninstallerFixture.cs"
  $outputPath = Join-Path $legacyInstallRoot "unins000.exe"
  @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Win32;
internal static class LegacyUninstallerFixture {
  private static int Main(string[] args) {
    if (args.Length == 4 && args[0] == "--cleanup") {
      int pid = Int32.Parse(args[1]);
      try { Process.GetProcessById(pid).WaitForExit(15000); } catch {}
      Registry.LocalMachine.DeleteSubKeyTree(args[2], false);
      for (int i = 0; i < 60 && Directory.Exists(args[3]); i++) {
        try { Directory.Delete(args[3], true); } catch { Thread.Sleep(250); }
      }
      string currentPath = Process.GetCurrentProcess().MainModule.FileName;
      Process.Start(new ProcessStartInfo("cmd.exe", "/d /c ping 127.0.0.1 -n 2 > nul & del /f /q \"" + currentPath + "\"") { CreateNoWindow = true, UseShellExecute = false });
      return Directory.Exists(args[3]) ? 2 : 0;
    }
    string copy = Path.Combine(Path.GetTempPath(), "QuickHackLegacyUninstaller-" + Guid.NewGuid().ToString("N") + ".exe");
    File.Copy(Process.GetCurrentProcess().MainModule.FileName, copy, true);
    string key = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}_is1";
    Process.Start(new ProcessStartInfo(copy, "--cleanup " + Process.GetCurrentProcess().Id + " \"" + key + "\" \"" + AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\') + "\"") { CreateNoWindow = true, UseShellExecute = false });
    return 0;
  }
}
'@ | Set-Content -LiteralPath $sourcePath -Encoding utf8
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  & $csc /nologo /target:exe "/out:$outputPath" $sourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    throw "QuickHack legacy uninstaller fixture compile failed."
  }
  New-Item -Path $legacyRegistryPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $legacyRegistryPath -Name DisplayName -Value "QuickHack Demo Server"
  Set-ItemProperty -LiteralPath $legacyRegistryPath -Name DisplayVersion -Value "1.0.0"
  Set-ItemProperty -LiteralPath $legacyRegistryPath -Name InstallLocation -Value $legacyInstallRoot
  Set-ItemProperty -LiteralPath $legacyRegistryPath -Name UninstallString -Value ('"' + $outputPath + '"')
  Set-ItemProperty -LiteralPath $legacyRegistryPath -Name QuietUninstallString -Value ('"' + $outputPath + '" /VERYSILENT')
}

function Invoke-ExactPurge {
  param([switch]$DryRun)
  $arguments = @{
    ArtifactKind = "DEMONSTRATION_SERVER"
    ConfirmPackageIdentity = $identityName
    MutableRoot = $mutableRoot
  }
  if ($DryRun) {
    return & (Join-Path $repositoryRoot "packaging\windows\purge-installation.ps1") @arguments -DryRun | ConvertFrom-Json
  }
  & (Join-Path $repositoryRoot "packaging\windows\purge-installation.ps1") @arguments `
    -ConfirmArtifactKind DEMONSTRATION_SERVER `
    -VerifiedBackup $false `
    -AcknowledgeNoRecovery $true | Out-Null
}

function Remove-ExactTestState {
  Stop-QuickHackServices
  $installed = Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue
  if ($installed) { Remove-AppxPackage -Package $installed.PackageFullName -Confirm:$false -ErrorAction SilentlyContinue }
  Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $legacyRegistryPath -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $legacyInstallRoot) { [IO.Directory]::Delete("\\?\$legacyInstallRoot", $true) }
  if ((Test-Path -LiteralPath $mutableRoot) -and $AcknowledgeTestStatePurge) { Invoke-ExactPurge }
  Get-ChildItem -LiteralPath $env:TEMP -Filter "QuickHackLegacyUninstaller-*.exe" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $validationRoot) { [IO.Directory]::Delete("\\?\$validationRoot", $true) }
  if ($certificateThumbprint) {
    & "$env:WINDIR\System32\certutil.exe" -delstore TrustedPeople $certificateThumbprint | Out-Null
  }
}

if (-not (Test-IsAdministrator)) { throw "QuickHack PR-06 native lifecycle requires administrator elevation." }
if (-not $AcknowledgeTestStatePurge) { throw "QuickHack PR-06 native lifecycle requires -AcknowledgeTestStatePurge." }
if (Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue) { throw "QuickHack demo-server package is already installed." }
if (Test-Path -LiteralPath $mutableRoot) { throw "QuickHack demo-server mutable state already exists." }

try {
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath)
  $certificateThumbprint = $certificate.Thumbprint
  & "$env:WINDIR\System32\certutil.exe" -f -addstore TrustedPeople $CertificatePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "QuickHack development certificate trust failed." }
  Add-AppxPackage -Path $PackagePath -ForceApplicationShutdown -ErrorAction Stop
  $installed = Get-AppxPackage -Name $identityName -ErrorAction Stop

  $initial = Invoke-SetupAction -Action PROVISION -InstallLocation $installed.InstallLocation
  if ($initial.status -ne "INITIAL_LEADER_PENDING_ACK") { throw "QuickHack initial provisioning did not request acknowledgement." }
  $ready = Invoke-SetupAction `
    -Action ACKNOWLEDGE `
    -InstallLocation $installed.InstallLocation `
    -TransactionId $initial.transactionId `
    -Generation $initial.generation
  if ($ready.status -ne "READY") { throw "QuickHack initial provisioning did not reach READY." }
  $leaderUserId = $initial.userId
  $initial.temporaryPassword = ""

  Set-Content -LiteralPath $canaryPath -Value "PR06_STATE_CONTINUITY_V1" -Encoding ascii
  $canaryHash = (Get-FileHash -LiteralPath $canaryPath -Algorithm SHA256).Hash
  Stop-QuickHackServices
  Convert-CredentialsToCurrentUserScope
  Remove-Item -LiteralPath $provisioningRoot -Recurse -Force
  New-LegacyUninstallerFixture

  $migrated = Invoke-SetupAction -Action MIGRATE -InstallLocation $installed.InstallLocation
  if ($migrated.status -ne "READY") { throw "QuickHack legacy migration did not reach READY." }
  if ((Test-Path -LiteralPath $legacyRegistryPath) -or (Test-Path -LiteralPath $legacyInstallRoot)) {
    throw "QuickHack legacy binary registration remained after migration."
  }
  if (-not (Test-Path -LiteralPath $migrationJournalPath -PathType Leaf)) { throw "QuickHack migration journal is missing." }
  $migrationJournal = Get-Content -LiteralPath $migrationJournalPath -Raw -Encoding utf8 | ConvertFrom-Json
  $provisioningJournal = Get-Content -LiteralPath $provisioningJournalPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    $migrationJournal.state -ne "READY" -or
    $migrationJournal.mode -ne "INSTALLED_INNO" -or
    $provisioningJournal.state -ne "READY" -or
    $provisioningJournal.initialLeader.userId -ne $leaderUserId -or
    -not $provisioningJournal.initialLeader.acknowledgedAt
  ) {
    throw "QuickHack legacy state or existing LEADER adoption proof is invalid."
  }
  Assert-MachineScopeCredentials
  if ((Get-FileHash -LiteralPath $canaryPath -Algorithm SHA256).Hash -ne $canaryHash) {
    throw "QuickHack migration changed the state continuity canary."
  }

  Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction Stop
  $repaired = Invoke-SetupAction -Action REPAIR -InstallLocation $installed.InstallLocation
  if ($repaired.status -ne "READY" -or -not (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue)) {
    throw "QuickHack product repair did not restore the firewall contract."
  }

  $configHash = (Get-FileHash -LiteralPath (Join-Path $mutableRoot "config\server-runtime.json") -Algorithm SHA256).Hash
  Stop-QuickHackServices
  Remove-AppxPackage -Package $installed.PackageFullName -Confirm:$false -ErrorAction Stop
  if (Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue) { throw "QuickHack package remained after normal uninstall." }
  foreach ($serviceName in $services) {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "QuickHack service remained after normal uninstall: $serviceName" }
  }
  if (
    -not (Test-Path -LiteralPath $mutableRoot -PathType Container) -or
    (Get-FileHash -LiteralPath $canaryPath -Algorithm SHA256).Hash -ne $canaryHash -or
    (Get-FileHash -LiteralPath (Join-Path $mutableRoot "config\server-runtime.json") -Algorithm SHA256).Hash -ne $configHash
  ) {
    throw "QuickHack normal uninstall did not preserve mutable state."
  }

  $dryRun = Invoke-ExactPurge -DryRun
  if ($dryRun.Protocol -ne "QUICKHACK_PURGE_DRY_RUN_V1" -or $dryRun.MutationPerformed -ne $false -or -not (Test-Path -LiteralPath $mutableRoot)) {
    throw "QuickHack purge dry-run mutated state or returned an invalid plan."
  }
  Invoke-ExactPurge
  if (Test-Path -LiteralPath $mutableRoot) { throw "QuickHack explicit purge left mutable state." }
  Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  & "$env:WINDIR\System32\certutil.exe" -delstore TrustedPeople $certificateThumbprint | Out-Null
  $certificateThumbprint = ""

  New-Item -ItemType Directory -Path (Split-Path -Parent $EvidencePath) -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    status = "PASS"
    sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
    osBuild = [Environment]::OSVersion.Version.Build
    packageIdentity = $identityName
    packageVersion = $installed.Version.ToString()
    legacyClassification = "COMPATIBLE"
    legacyMode = "INSTALLED_INNO"
    stateContinuity = $true
    existingLeaderAdopted = $true
    credentialScopeTransition = "DPAPI_CURRENT_USER_TO_LOCAL_MACHINE"
    productRepair = "FIREWALL_DRIFT_REPAIRED"
    normalUninstallPreservedState = $true
    purgeDryRunMutationPerformed = $false
    explicitPurge = $true
    residueCount = 0
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
  Write-Host "QuickHack PR-06 legacy migration, repair, uninstall, and purge lifecycle passed."
} catch {
  $phaseFailure = $_
  $migrationDiagnostic = if (Test-Path -LiteralPath $migrationJournalPath -PathType Leaf) {
    $record = Get-Content -LiteralPath $migrationJournalPath -Raw -Encoding utf8 | ConvertFrom-Json
    [ordered]@{
      state = [string]$record.state
      completedSteps = @($record.completedSteps)
      errorCode = if ($record.error) { [string]$record.error.code } else { "" }
    }
  } else { $null }
  $provisioningDiagnostic = if (Test-Path -LiteralPath $provisioningJournalPath -PathType Leaf) {
    $record = Get-Content -LiteralPath $provisioningJournalPath -Raw -Encoding utf8 | ConvertFrom-Json
    [ordered]@{
      state = [string]$record.state
      completedSteps = @($record.completedSteps)
      errorCode = if ($record.error) { [string]$record.error.code } else { "" }
    }
  } else { $null }
  New-Item -ItemType Directory -Path (Split-Path -Parent $EvidencePath) -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    status = "FAIL_DIAGNOSTIC"
    stableCode = if ($_.Exception.Message -match '\b([A-Z][A-Z0-9_]{2,95})\b') { $Matches[1] } else { "PR06_NATIVE_LIFECYCLE_FAILED" }
    migration = $migrationDiagnostic
    provisioning = $provisioningDiagnostic
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
} finally {
  try { Remove-ExactTestState } catch { $cleanupFailure = $_ }
}
if ($phaseFailure -and $cleanupFailure) {
  throw "QuickHack PR-06 lifecycle failed: $($phaseFailure.Exception.Message) Cleanup also failed: $($cleanupFailure.Exception.Message)"
}
if ($phaseFailure) { throw $phaseFailure }
if ($cleanupFailure) { throw $cleanupFailure }
