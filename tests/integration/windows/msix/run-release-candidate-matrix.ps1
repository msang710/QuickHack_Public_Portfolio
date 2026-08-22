[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("WINDOWS_10", "WINDOWS_11")][string]$OsFamily,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [string]$DistributionDir = "release\distribution\windows\msix\exact-four",
  [Parameter(Mandatory = $true)][string[]]$ComponentEvidencePath,
  [Parameter(Mandatory = $true)][string]$EvidencePath,
  [string]$NodePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$distributionPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $DistributionDir))
$resolvedEvidencePath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidencePath))
foreach ($boundedPath in @($distributionPath, $resolvedEvidencePath)) {
  if (
    $boundedPath -eq $releaseRoot -or
    -not $boundedPath.StartsWith(
      $releaseRoot + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "MSIX_RELEASE_EVIDENCE_UNSAFE: release candidate paths must be below repository release/."
  }
}
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
}
if (-not $NodePath) { throw "MSIX_RELEASE_NODE_MISSING: Node.js was not found." }

& $NodePath `
  (Join-Path $repositoryRoot "packaging\windows\msix\four-artifact-distribution.mjs") `
  "--directory=$distributionPath" `
  "--version=$Version" `
  "--publisher=$Publisher" `
  --require-production
if ($LASTEXITCODE -ne 0) {
  throw "MSIX_RELEASE_PACKAGE_INVALID: production exact-four verification failed."
}

$operatingSystem = Get-CimInstance Win32_OperatingSystem
$osBuild = [int]$operatingSystem.BuildNumber
if (
  [int]$operatingSystem.ProductType -ne 1 -or
  $osBuild -lt 19041 -or
  ($OsFamily -eq "WINDOWS_10" -and $osBuild -ge 22000) -or
  ($OsFamily -eq "WINDOWS_11" -and $osBuild -lt 22000)
) {
  throw "UNSUPPORTED_WINDOWS_VERSION: release evidence requires the declared Windows workstation lane."
}

$targetPrefixes = [ordered]@{
  "demo-server" = "QuickHack-Demo-Server"
  "demo-client" = "QuickHack-Demo-Client"
  "operational-server" = "QuickHack-Operational-Server"
  "operational-client" = "QuickHack-Operational-Client"
}
$packageHashes = [ordered]@{}
foreach ($entry in $targetPrefixes.GetEnumerator()) {
  $sidecarPath = Join-Path $distributionPath "$($entry.Key)\$($entry.Value)-msix-manifest-$Version.json"
  $sidecar = Get-Content -LiteralPath $sidecarPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    $sidecar.schemaVersion -ne 2 -or
    $sidecar.sourceCommit -ne $SourceCommit -or
    $sidecar.publisher -ne $Publisher -or
    $sidecar.signingMode -ne "PRODUCTION"
  ) {
    throw "MSIX_RELEASE_PACKAGE_INVALID: sidecar identity mismatch for $($entry.Key)."
  }
  $packageHashes[$entry.Key] = [string]$sidecar.packageSha256
}

$requiredChecks = @(
  "cleanInstall",
  "provisioning",
  "interruptionRecovery",
  "update",
  "reboot",
  "migration",
  "repair",
  "serverConflict",
  "dualClients",
  "uninstallPreserved",
  "purge",
  "shellIcon"
)
$observedChecks = @{}
foreach ($componentPath in $ComponentEvidencePath) {
  $resolvedComponentPath = if ([IO.Path]::IsPathRooted($componentPath)) {
    [IO.Path]::GetFullPath($componentPath)
  } else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $componentPath))
  }
  if (
    $resolvedComponentPath -eq $releaseRoot -or
    -not $resolvedComponentPath.StartsWith(
      $releaseRoot + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "MSIX_RELEASE_EVIDENCE_UNSAFE: component evidence must be below repository release/."
  }
  $component = Get-Content -LiteralPath $resolvedComponentPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    $component.schemaVersion -ne 1 -or
    $component.status -ne "PASS" -or
    $component.sourceCommit -ne $SourceCommit -or
    $component.semanticVersion -ne $Version -or
    $component.publisher -ne $Publisher -or
    $component.osBuild -ne $osBuild
  ) {
    throw "MSIX_RELEASE_EVIDENCE_STALE: component evidence identity is stale."
  }
  foreach ($entry in $targetPrefixes.GetEnumerator()) {
    if ($component.packageHashes.($entry.Key) -ne $packageHashes[$entry.Key]) {
      throw "MSIX_RELEASE_EVIDENCE_STALE: component package hash mismatch."
    }
  }
  foreach ($property in @($component.checks.PSObject.Properties)) {
    if ($requiredChecks -notcontains $property.Name -or $property.Value -ne $true) {
      throw "MSIX_RELEASE_EVIDENCE_INVALID: component check is unknown or did not pass."
    }
    $observedChecks[$property.Name] = $true
  }
  foreach ($countName in @("criticalFailure", "stateLoss", "duplicateLeader", "iconMismatch", "residue")) {
    if ($component.counts.$countName -ne 0) {
      throw "MSIX_RELEASE_EVIDENCE_FAILED: component evidence contains a failure count."
    }
  }
}
foreach ($requiredCheck in $requiredChecks) {
  if (-not $observedChecks.ContainsKey($requiredCheck)) {
    throw "MSIX_RELEASE_EVIDENCE_INCOMPLETE: missing check $requiredCheck."
  }
}

$identityBytes = [Text.Encoding]::UTF8.GetBytes(
  "$SourceCommit`n$Version`n$Publisher`n$OsFamily`n$osBuild`n" +
  (($packageHashes.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n")
)
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $identityHash = ([BitConverter]::ToString($sha.ComputeHash($identityBytes))).Replace("-", "").ToLowerInvariant()
} finally {
  $sha.Dispose()
}
$checks = [ordered]@{}
foreach ($requiredCheck in $requiredChecks) { $checks[$requiredCheck] = $true }

New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedEvidencePath) -Force | Out-Null
[ordered]@{
  schemaVersion = 1
  status = "PASS"
  evidenceId = "quickhack-$($OsFamily.ToLowerInvariant().Replace('_', '-'))-$($identityHash.Substring(0, 24))"
  osFamily = $OsFamily
  productType = "WORKSTATION"
  osBuild = $osBuild
  sourceCommit = $SourceCommit
  semanticVersion = $Version
  publisher = $Publisher
  packageHashes = $packageHashes
  checks = $checks
  counts = [ordered]@{
    criticalFailure = 0
    stateLoss = 0
    duplicateLeader = 0
    iconMismatch = 0
    residue = 0
  }
  externalOperations = [ordered]@{
    status = "NOT_APPLICABLE"
    reason = "EXTERNAL_OPERATION_ENVIRONMENT_UNAVAILABLE"
  }
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedEvidencePath -Encoding utf8

Write-Host "QuickHack $OsFamily release-candidate evidence compiled from exact component proofs."
