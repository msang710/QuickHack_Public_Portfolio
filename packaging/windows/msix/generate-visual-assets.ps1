[CmdletBinding()]
param(
  [string]$ManifestPath = "",
  [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..\..")
)
if (-not $ManifestPath) {
  $ManifestPath = Join-Path $repositoryRoot "assets\branding\windows-icon.json"
}
if (-not $OutputDir) {
  $OutputDir = Join-Path $repositoryRoot "release\windows\msix\visual-assets"
}

$manifestFullPath = [System.IO.Path]::GetFullPath($ManifestPath)
$outputFullPath = [System.IO.Path]::GetFullPath($OutputDir)
$allowedOutputRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot "release")
)
if (
  $outputFullPath -eq $allowedOutputRoot -or
  -not $outputFullPath.StartsWith(
    $allowedOutputRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "QuickHack visual asset output must be a descendant of repository release/."
}
$manifest = Get-Content -LiteralPath $manifestFullPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {
  throw "Unsupported QuickHack Windows branding manifest schema."
}

$sourcePath = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot ([string]$manifest.source.path))
)
$observedSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
$expectedSourceHash = ([string]$manifest.source.sha256).ToLowerInvariant()
if ($observedSourceHash -ne $expectedSourceHash) {
  throw "QuickHack canonical icon hash mismatch. Expected=$expectedSourceHash Actual=$observedSourceHash"
}

Add-Type -AssemblyName System.Drawing

if (Test-Path -LiteralPath $outputFullPath) {
  Remove-Item -LiteralPath $outputFullPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputFullPath -Force | Out-Null

$icon = New-Object System.Drawing.Icon($sourcePath, 256, 256)
try {
  $sourceBitmap = $icon.ToBitmap()
  try {
    $generated = foreach ($output in @($manifest.outputs)) {
      $relativePath = [string]$output.path
      if (
        [System.IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains("..") -or
        [System.IO.Path]::GetExtension($relativePath) -ne ".png"
      ) {
        throw "Unsafe Windows visual asset path: $relativePath"
      }
      $width = [int]$output.width
      $height = [int]$output.height
      if ($width -lt 1 -or $height -lt 1 -or $width -gt 1024 -or $height -gt 1024) {
        throw "Invalid Windows visual asset dimensions: $relativePath"
      }

      $targetPath = Join-Path $outputFullPath $relativePath
      $targetDirectory = Split-Path -Parent $targetPath
      New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
      $bitmap = New-Object System.Drawing.Bitmap(
        $width,
        $height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
      )
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.Clear([System.Drawing.Color]::Transparent)
          $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
          $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.DrawImage($sourceBitmap, 0, 0, $width, $height)
        } finally {
          $graphics.Dispose()
        }
        $bitmap.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $bitmap.Dispose()
      }

      [ordered]@{
        path = $relativePath.Replace("\", "/")
        width = $width
        height = $height
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetPath).Hash.ToLowerInvariant()
      }
    }
  } finally {
    $sourceBitmap.Dispose()
  }
} finally {
  $icon.Dispose()
}

$generatedManifest = [ordered]@{
  schemaVersion = 1
  brandingRevision = [string]$manifest.brandingRevision
  generatorVersion = [string]$manifest.generatorVersion
  source = [ordered]@{
    path = [string]$manifest.source.path
    sha256 = $observedSourceHash
  }
  outputs = @($generated)
}
$generatedManifestPath = Join-Path $outputFullPath "visual-assets.manifest.json"
$generatedManifest |
  ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath $generatedManifestPath -Encoding utf8

Write-Host "QuickHack Windows visual assets generated: $outputFullPath"
Get-Item -LiteralPath $generatedManifestPath | Select-Object FullName,Length
