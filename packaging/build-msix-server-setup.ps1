[CmdletBinding()]
param(
  [ValidateSet("demo-server", "operational-server")]
  [string]$Target = "demo-server",

  [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $OutputDir) {
  $OutputDir = "release\windows\msix\server-setup\$Target"
}
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
if (
  $outputPath -eq $allowedRoot -or
  -not $outputPath.StartsWith(
    $allowedRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "QuickHack Server Setup output must be a descendant of repository release/."
}

$cscCandidates = @(
  (Get-Command csc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$csc = $cscCandidates | Select-Object -First 1
if (-not $csc) {
  throw "Windows C# compiler was not found for QuickHack Server Setup."
}

$sourceRoot = Join-Path $PSScriptRoot "windows\msix\server-setup"
$sourcePath = Join-Path $sourceRoot "QuickHackServerSetup.cs"
$processSourcePath = Join-Path $sourceRoot "QuickHackDesktopAppProcess.cs"
$manifestPath = Join-Path $sourceRoot "QuickHackServerSetup.exe.manifest"
$iconPath = Join-Path $repositoryRoot "assets\app.ico"
$define = if ($Target -eq "demo-server") { "QUICKHACK_DEMONSTRATION" } else { "QUICKHACK_OPERATIONAL" }
$fileName = if ($Target -eq "demo-server") {
  "QuickHack-Demo-Server-Setup.exe"
} else {
  "QuickHack-Operational-Server-Setup.exe"
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$targetPath = Join-Path $outputPath $fileName

& $csc `
  /nologo `
  /target:winexe `
  /platform:x64 `
  /optimize+ `
  /utf8output `
  "/define:$define" `
  "/win32icon:$iconPath" `
  "/win32manifest:$manifestPath" `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  "/out:$targetPath" `
  $sourcePath `
  $processSourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
  throw "Failed to build QuickHack Server Setup: $fileName"
}

Write-Host "QuickHack $Target Server Setup created: $targetPath"
