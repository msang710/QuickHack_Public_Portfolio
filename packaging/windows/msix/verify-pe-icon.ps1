[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [string]$CanonicalIconPath = "",
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$resolvedExecutable = [IO.Path]::GetFullPath($ExecutablePath)
$resolvedEvidence = [IO.Path]::GetFullPath($EvidencePath)
if (-not $CanonicalIconPath) {
  $CanonicalIconPath = Join-Path $repositoryRoot "assets\app.ico"
}
$resolvedCanonical = [IO.Path]::GetFullPath($CanonicalIconPath)

if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) {
  throw "PE_ICON_EXECUTABLE_MISSING: packaged launcher was not found."
}
if (-not (Test-Path -LiteralPath $resolvedCanonical -PathType Leaf)) {
  throw "PE_ICON_CANONICAL_MISSING: canonical icon was not found."
}
if (
  $resolvedEvidence -eq $releaseRoot -or
  -not $resolvedEvidence.StartsWith(
    $releaseRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "PE_ICON_EVIDENCE_UNSAFE: evidence must be written below repository release/."
}

Add-Type -AssemblyName System.Drawing

function Get-QuickHackIconPixelHash {
  param([Parameter(Mandatory = $true)][System.Drawing.Icon]$Icon)
  $bitmap = [System.Drawing.Bitmap]::new(
    $Icon.Width,
    $Icon.Height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.DrawIcon($Icon, [System.Drawing.Rectangle]::new(0, 0, $bitmap.Width, $bitmap.Height))
    } finally {
      $graphics.Dispose()
    }
    $rectangle = [System.Drawing.Rectangle]::new(0, 0, $bitmap.Width, $bitmap.Height)
    $data = $bitmap.LockBits(
      $rectangle,
      [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    try {
      $length = [Math]::Abs($data.Stride) * $bitmap.Height
      $bytes = [byte[]]::new($length)
      [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $length)
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
      } finally {
        $sha.Dispose()
      }
    } finally {
      $bitmap.UnlockBits($data)
    }
  } finally {
    $bitmap.Dispose()
  }
}

$observedIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($resolvedExecutable)
if (-not $observedIcon) {
  throw "PE_ICON_RESOURCE_MISSING: packaged launcher has no extractable icon."
}
$observedWidth = $observedIcon.Width
$observedHeight = $observedIcon.Height
try {
  $canonicalIcon = [System.Drawing.Icon]::new(
    $resolvedCanonical,
    $observedWidth,
    $observedHeight
  )
  try {
    $observedPixelHash = Get-QuickHackIconPixelHash -Icon $observedIcon
    $canonicalPixelHash = Get-QuickHackIconPixelHash -Icon $canonicalIcon
  } finally {
    $canonicalIcon.Dispose()
  }
} finally {
  $observedIcon.Dispose()
}

if ($observedPixelHash -ne $canonicalPixelHash) {
  throw "PE_ICON_RESOURCE_MISMATCH: packaged launcher icon does not match the canonical icon."
}

New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedEvidence) -Force | Out-Null
[ordered]@{
  schemaVersion = 1
  status = "PASS"
  executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedExecutable).Hash.ToLowerInvariant()
  canonicalIconSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedCanonical).Hash.ToLowerInvariant()
  width = $observedWidth
  height = $observedHeight
  pixelSha256 = $observedPixelHash
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8

Write-Host "QuickHack packaged launcher PE icon verified."
