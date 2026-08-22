[CmdletBinding()]
param(
  [string]$OutputDir = "release\windows\runtimes\node-v24.17.0-win-x64"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..")
)
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
if (
  $outputPath -eq $releaseRoot -or
  -not $outputPath.StartsWith(
    $releaseRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "QuickHack Node runtime output must be a descendant of repository release/."
}

$configPath = Join-Path $PSScriptRoot "node-runtime.json"
$config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
if (
  $config.schemaVersion -ne 1 -or
  $config.version -notmatch '^24\.[0-9]+\.[0-9]+$' -or
  $config.architecture -ne "win-x64" -or
  $config.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or
  $config.downloadUrl -notmatch '^https://nodejs\.org/dist/'
) {
  throw "QuickHack pinned Node runtime configuration is invalid."
}

$downloadRoot = Join-Path $releaseRoot "windows\.downloads\node-$($config.version)"
$archivePath = Join-Path $downloadRoot $config.archiveFile
$extractPath = Join-Path $downloadRoot "extract"
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

$archiveReady = $false
if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
  $archiveReady = (
    (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -eq
    $config.archiveSha256
  )
}
if (-not $archiveReady) {
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri $config.downloadUrl -OutFile $archivePath
}
$observedHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($observedHash -ne $config.archiveSha256) {
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  throw "QuickHack pinned Node archive checksum mismatch."
}

if (Test-Path -LiteralPath $extractPath) {
  Remove-Item -LiteralPath $extractPath -Recurse -Force
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
$expandedRoot = Join-Path $extractPath $config.directoryName
$nodeSource = Join-Path $expandedRoot "node.exe"
$licenseSource = Join-Path $expandedRoot "LICENSE"
foreach ($requiredPath in @($nodeSource, $licenseSource)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "QuickHack pinned Node archive is missing a required file: $requiredPath"
  }
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $outputPath "node.exe")
Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $outputPath "LICENSE")
[ordered]@{
  schemaVersion = 1
  product = "Node.js"
  version = [string]$config.version
  architecture = [string]$config.architecture
  archiveFile = [string]$config.archiveFile
  archiveSha256 = [string]$config.archiveSha256
  downloadUrl = [string]$config.downloadUrl
  checksumUrl = [string]$config.checksumUrl
} | ConvertTo-Json -Depth 4 | Set-Content `
  -LiteralPath (Join-Path $outputPath "quickhack-node-runtime.json") `
  -Encoding utf8

$observedVersion = (& (Join-Path $outputPath "node.exe") --version).Trim()
if ($LASTEXITCODE -ne 0 -or $observedVersion -ne "v$($config.version)") {
  throw "QuickHack pinned Node executable version mismatch: $observedVersion"
}

Remove-Item -LiteralPath $extractPath -Recurse -Force
Write-Host "QuickHack pinned Node runtime ready: $outputPath ($observedVersion)"
Get-ChildItem -LiteralPath $outputPath -File | Select-Object Name,Length
