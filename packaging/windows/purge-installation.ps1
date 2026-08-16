param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("DEMONSTRATION_SERVER", "DEMONSTRATION_CLIENT", "OPERATIONAL_SERVER", "OPERATIONAL_CLIENT")]
  [string]$ArtifactKind,

  [Parameter(Mandatory = $true)]
  [string]$ConfirmArtifactKind,

  [Parameter(Mandatory = $true)]
  [bool]$VerifiedBackup,

  [Parameter(Mandatory = $true)]
  [bool]$AcknowledgeNoRecovery,

  [string]$MutableRoot = ""
)

$ErrorActionPreference = "Stop"
$contracts = @{
  DEMONSTRATION_SERVER = @{
    Root = Join-Path $env:ProgramData "QuickHack\demonstration-server"
    Services = @("QuickHackDemoServerConsole", "QuickHackDemoPostgreSQL")
  }
  DEMONSTRATION_CLIENT = @{
    Root = Join-Path $env:LOCALAPPDATA "QuickHack\demonstration-client"
    Services = @()
  }
  OPERATIONAL_SERVER = @{
    Root = Join-Path $env:ProgramData "QuickHack\operational-server"
    Services = @("QuickHackOperationalServerConsole", "QuickHackOperationalPostgreSQL")
  }
  OPERATIONAL_CLIENT = @{
    Root = Join-Path $env:LOCALAPPDATA "QuickHack\operational-client"
    Services = @()
  }
}

if ($ConfirmArtifactKind -cne $ArtifactKind) {
  throw "PURGE_CONFIRMATION_REQUIRED: exact artifact confirmation does not match."
}
if (-not $VerifiedBackup -and -not $AcknowledgeNoRecovery) {
  throw "PURGE_CONFIRMATION_REQUIRED: confirm a verified backup or explicitly acknowledge no recovery."
}

$contract = $contracts[$ArtifactKind]
$expectedRoot = [System.IO.Path]::GetFullPath($contract.Root).TrimEnd('\')
$resolvedRoot = [System.IO.Path]::GetFullPath($(if ($MutableRoot) { $MutableRoot } else { $contract.Root })).TrimEnd('\')
if (-not $resolvedRoot.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "PURGE_CONFIRMATION_REQUIRED: mutable root is outside the artifact-owned path."
}

foreach ($serviceName in $contract.Services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') {
    Stop-Service -InputObject $service -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  }
}

$remaining = @()
if (Test-Path -LiteralPath $resolvedRoot) {
  $item = Get-Item -LiteralPath $resolvedRoot -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "PURGE_CONFIRMATION_REQUIRED: mutable root is a junction or symbolic link."
  }
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
