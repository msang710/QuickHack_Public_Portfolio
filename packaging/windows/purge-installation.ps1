param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("DEMONSTRATION_SERVER", "DEMONSTRATION_CLIENT", "OPERATIONAL_SERVER", "OPERATIONAL_CLIENT")]
  [string]$ArtifactKind,

  [string]$ConfirmArtifactKind = "",

  [Parameter(Mandatory = $true)]
  [string]$ConfirmPackageIdentity,

  [bool]$VerifiedBackup = $false,

  [bool]$AcknowledgeNoRecovery = $false,

  [switch]$DryRun,

  [string]$MutableRoot = ""
)

$ErrorActionPreference = "Stop"
$contracts = @{
  DEMONSTRATION_SERVER = @{
    PackageIdentity = "QuickHack.Demonstration.Server"
    Root = Join-Path $env:ProgramData "QuickHack\demonstration-server"
    Services = @("QuickHackDemoServerConsole", "QuickHackDemoPostgreSQL")
  }
  DEMONSTRATION_CLIENT = @{
    PackageIdentity = "QuickHack.Demonstration.Client"
    Root = Join-Path $env:LOCALAPPDATA "QuickHack\demonstration-client"
    Services = @()
  }
  OPERATIONAL_SERVER = @{
    PackageIdentity = "QuickHack.Operational.Server"
    Root = Join-Path $env:ProgramData "QuickHack\operational-server"
    Services = @("QuickHackOperationalServerConsole", "QuickHackOperationalPostgreSQL")
  }
  OPERATIONAL_CLIENT = @{
    PackageIdentity = "QuickHack.Operational.Client"
    Root = Join-Path $env:LOCALAPPDATA "QuickHack\operational-client"
    Services = @()
  }
}

$contract = $contracts[$ArtifactKind]
if ($ConfirmPackageIdentity -cne $contract.PackageIdentity) {
  throw "PURGE_CONFIRMATION_REQUIRED: exact MSIX package identity confirmation does not match."
}
$expectedRoot = [System.IO.Path]::GetFullPath($contract.Root).TrimEnd('\')
$resolvedRoot = [System.IO.Path]::GetFullPath($(if ($MutableRoot) { $MutableRoot } else { $contract.Root })).TrimEnd('\')
if (-not $resolvedRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "PURGE_CONFIRMATION_REQUIRED: mutable root is outside the artifact-owned path."
}

$rootExists = Test-Path -LiteralPath $resolvedRoot
if ($rootExists) {
  $item = Get-Item -LiteralPath $resolvedRoot -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "PURGE_CONFIRMATION_REQUIRED: mutable root is a junction or symbolic link."
  }
}
$serviceInventory = @(
  foreach ($serviceName in $contract.Services) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    [ordered]@{
      Name = $serviceName
      Status = if ($service) { [string]$service.Status } else { "MISSING" }
    }
  }
)
if ($DryRun) {
  [ordered]@{
    Protocol = "QUICKHACK_PURGE_DRY_RUN_V1"
    ArtifactKind = $ArtifactKind
    PackageIdentity = $contract.PackageIdentity
    MutableRoot = $resolvedRoot
    MutableRootExists = $rootExists
    Services = $serviceInventory
    MutationPerformed = $false
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ($ConfirmArtifactKind -cne $ArtifactKind) {
  throw "PURGE_CONFIRMATION_REQUIRED: exact artifact confirmation does not match."
}
if (-not $VerifiedBackup -and -not $AcknowledgeNoRecovery) {
  throw "PURGE_CONFIRMATION_REQUIRED: confirm a verified backup or explicitly acknowledge no recovery."
}

foreach ($serviceName in $contract.Services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') {
    Stop-Service -InputObject $service -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  }
  $remainingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($remainingService -and $remainingService.Status -ne 'Stopped') {
    throw "PURGE_SERVICE_STOP_FAILED: $serviceName did not reach Stopped."
  }
}

$remaining = @()
if (Test-Path -LiteralPath $resolvedRoot) {
  try {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  } catch {
    $remaining += $resolvedRoot
  }
}

if (Test-Path -LiteralPath $resolvedRoot) {
  $remaining += Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName }
}
if ($remaining.Count -gt 0) {
  $remaining | Sort-Object -Unique | ForEach-Object { Write-Error "PURGE_PARTIAL: $_" }
  exit 2
}

Write-Host "QuickHack purge completed for $ArtifactKind at $resolvedRoot."
