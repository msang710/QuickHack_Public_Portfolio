[CmdletBinding()]
param(
  [string]$ManifestPath = "",
  [string]$AssetsDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..\..")
)
if (-not $ManifestPath) {
  $ManifestPath = Join-Path $repositoryRoot "assets\branding\windows-icon.json"
}
if (-not $AssetsDir) {
  $AssetsDir = Join-Path $repositoryRoot "release\windows\msix\visual-assets"
}

$brandingManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$assetsFullPath = [System.IO.Path]::GetFullPath($AssetsDir)
$generatedManifestPath = Join-Path $assetsFullPath "visual-assets.manifest.json"
$generatedManifest = Get-Content -LiteralPath $generatedManifestPath -Raw -Encoding utf8 | ConvertFrom-Json

$sourcePath = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot ([string]$brandingManifest.source.path))
)
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
if ($sourceHash -ne ([string]$brandingManifest.source.sha256).ToLowerInvariant()) {
  throw "QuickHack canonical icon hash does not match the branding manifest."
}
if ($generatedManifest.brandingRevision -ne $brandingManifest.brandingRevision) {
  throw "QuickHack generated visual assets have the wrong branding revision."
}
if ($generatedManifest.generatorVersion -ne $brandingManifest.generatorVersion) {
  throw "QuickHack generated visual assets have the wrong generator version."
}
if ($generatedManifest.source.sha256 -ne $sourceHash) {
  throw "QuickHack generated visual assets reference the wrong source icon."
}

$expectedByPath = @{}
foreach ($output in @($brandingManifest.outputs)) {
  $expectedByPath[[string]$output.path] = $output
}
$observedPaths = @($generatedManifest.outputs | ForEach-Object { [string]$_.path })
if ($observedPaths.Count -ne $expectedByPath.Count) {
  throw "QuickHack generated visual asset count mismatch."
}

Add-Type -AssemblyName System.Drawing
foreach ($generatedOutput in @($generatedManifest.outputs)) {
  $relativePath = ([string]$generatedOutput.path).Replace("/", "\")
  if (-not $expectedByPath.ContainsKey($relativePath)) {
    throw "Unexpected QuickHack visual asset: $relativePath"
  }
  $assetPath = Join-Path $assetsFullPath $relativePath
  $expected = $expectedByPath[$relativePath]
  $observedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $assetPath).Hash.ToLowerInvariant()
  if ($observedHash -ne ([string]$generatedOutput.sha256).ToLowerInvariant()) {
    throw "QuickHack visual asset hash mismatch: $relativePath"
  }
  $image = [System.Drawing.Image]::FromFile($assetPath)
  try {
    if ($image.Width -ne [int]$expected.width -or $image.Height -ne [int]$expected.height) {
      throw "QuickHack visual asset dimensions mismatch: $relativePath"
    }
  } finally {
    $image.Dispose()
  }
}

Write-Host "QuickHack Windows visual assets verified: $assetsFullPath"
