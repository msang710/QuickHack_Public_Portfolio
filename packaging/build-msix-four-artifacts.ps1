[CmdletBinding()]
param(
  [string]$Version = "",

  [string]$OutputDir = "release\distribution\windows\msix\exact-four",

  [string]$Publisher = "CN=QuickHack Development",

  [ValidateSet("Unsigned", "TestCertificate", "Pfx")]
  [string]$SigningMode = "Unsigned",

  [string]$PfxPath = "",

  [string]$PfxPasswordEnvironmentVariable = "QUICKHACK_MSIX_PFX_PASSWORD",

  [string]$SdkRoot = "",

  [string]$VisualAssetsDir = "",

  [string]$NodePath = "",

  [string]$TestCertificateCerDir = "",

  [switch]$AllowDirtySource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
function Get-QuickHackRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$ChildPath
  )
  $baseUri = [Uri]::new([IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\')
  $childUri = [Uri]::new([IO.Path]::GetFullPath($ChildPath))
  return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($childUri).ToString()).Replace('/', '\')
}

if (-not $Version) {
  $Version = (
    Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw -Encoding utf8 |
      ConvertFrom-Json
  ).version
}
$outputPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
if (
  $outputPath -eq $releaseRoot -or
  -not $outputPath.StartsWith(
    $releaseRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Exact-four MSIX output must be a descendant of repository release/."
}

$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
$sourceDirty = [bool](@(& git -C $repositoryRoot status --porcelain).Count)
if ($sourceCommit -notmatch '^[a-f0-9]{40}$') {
  throw "Unable to resolve the exact-four source revision."
}
if ($sourceDirty -and -not $AllowDirtySource) {
  throw "Exact-four MSIX output requires a clean source tree."
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
if ($TestCertificateCerDir) {
  $certificatePath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $TestCertificateCerDir))
  if (
    $certificatePath -eq $releaseRoot -or
    -not $certificatePath.StartsWith(
      $releaseRoot + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Exact-four test certificates must be written below repository release/."
  }
  New-Item -ItemType Directory -Path $certificatePath -Force | Out-Null
}

$targets = @("demo-server", "demo-client", "operational-server", "operational-client")
$buildScript = Join-Path $PSScriptRoot "build-msix.ps1"
foreach ($target in $targets) {
  $parameters = @{
    Target = $target
    Version = $Version
    OutputDir = Get-QuickHackRelativePath -BasePath $repositoryRoot -ChildPath (Join-Path $outputPath $target)
    Publisher = $Publisher
    SigningMode = $SigningMode
  }
  if ($PfxPath) { $parameters.PfxPath = $PfxPath }
  if ($PfxPasswordEnvironmentVariable) {
    $parameters.PfxPasswordEnvironmentVariable = $PfxPasswordEnvironmentVariable
  }
  if ($SdkRoot) { $parameters.SdkRoot = $SdkRoot }
  if ($VisualAssetsDir) { $parameters.VisualAssetsDir = $VisualAssetsDir }
  if ($NodePath) { $parameters.NodePath = $NodePath }
  if ($target.EndsWith("-server", [StringComparison]::Ordinal)) {
    $parameters.IncludeServices = $true
    $parameters.IncludeServerSetup = $true
  }
  if ($TestCertificateCerDir) {
    $parameters.TestCertificateCerPath = Get-QuickHackRelativePath `
      -BasePath $repositoryRoot `
      -ChildPath (Join-Path $certificatePath "$target.cer")
  }
  & $buildScript @parameters
  if ($LASTEXITCODE -ne 0) {
    throw "QuickHack exact-four build failed for $target."
  }
}

$verifyArguments = @(
  (Join-Path $PSScriptRoot "windows\msix\four-artifact-distribution.mjs"),
  "--directory=$outputPath",
  "--version=$Version"
)
if ($AllowDirtySource) { $verifyArguments += "--allow-dirty-source" }
$nodeExecutable = if ($NodePath) { $NodePath } else {
  Get-Command node.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
}
if (-not $nodeExecutable) {
  $nodeExecutable = Get-Command node -ErrorAction Stop |
    Select-Object -ExpandProperty Source -First 1
}
& $nodeExecutable @verifyArguments
if ($LASTEXITCODE -ne 0) {
  throw "QuickHack exact-four distribution verification failed."
}

Write-Host "QuickHack exact-four MSIX distribution created from $sourceCommit at $outputPath"
