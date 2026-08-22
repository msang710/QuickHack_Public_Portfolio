[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PostgresqlRuntimeDir,
  [string]$PlatformToolsDir = "",
  [string]$NodePath = "",
  [switch]$RequirePlatformTools
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
}
if (-not $NodePath) { throw "Node.js was not found for exact-four staging." }
$postgresqlRoot = [IO.Path]::GetFullPath($PostgresqlRuntimeDir)
if (-not (Test-Path -LiteralPath (Join-Path $postgresqlRoot "bin\postgres.exe") -PathType Leaf)) {
  throw "Pinned PostgreSQL runtime was not found for exact-four staging."
}
if ($PlatformToolsDir) {
  $env:QUICKHACK_PLATFORM_TOOLS_DIR = [IO.Path]::GetFullPath($PlatformToolsDir)
}
if ($RequirePlatformTools) {
  $configuredPlatformTools = [string]$env:QUICKHACK_PLATFORM_TOOLS_DIR
  if (-not $configuredPlatformTools -or -not (Test-Path -LiteralPath (Join-Path $configuredPlatformTools "adb.exe") -PathType Leaf)) {
    throw "Android platform-tools is required for exact-four staging."
  }
}

& (Join-Path $PSScriptRoot "windows\prepare-node-runtime.ps1")
& (Join-Path $PSScriptRoot "build-windows-launchers.ps1")
foreach ($target in @("demo-server", "operational-server")) {
  & (Join-Path $PSScriptRoot "build-msix-service-hosts.ps1") -Target $target
  & (Join-Path $PSScriptRoot "build-msix-server-setup.ps1") -Target $target
}

foreach ($target in @("demo-server", "demo-client", "operational-server", "operational-client")) {
  $arguments = @(
    (Join-Path $PSScriptRoot "windows\create-staging-package.mjs"),
    "--target=$target"
  )
  if ($target.EndsWith("-server", [StringComparison]::Ordinal)) {
    $arguments += "--postgresql-runtime-dir=$postgresqlRoot"
  } elseif ($RequirePlatformTools) {
    $arguments += "--require-platform-tools"
  }
  & $NodePath @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "QuickHack exact-four staging failed for $target."
  }
}

Write-Host "QuickHack exact-four Windows staging completed with shared build inputs."
