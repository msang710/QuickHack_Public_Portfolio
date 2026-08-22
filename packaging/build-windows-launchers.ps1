param(
  [string]$OutputDir = "release\windows\launchers"
)

$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $PSScriptRoot "windows-launcher\QuickHackLauncher.cs"
$iconPath = Join-Path $rootDir "assets\app.ico"
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $rootDir $OutputDir))

$cscCandidates = @(
  (Get-Command csc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

$csc = $cscCandidates | Select-Object -First 1

if (-not $csc) {
  throw "Windows C# compiler was not found. Install the .NET Framework build tools."
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "QuickHack launcher source was not found: $sourcePath"
}

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "QuickHack launcher icon was not found: $iconPath"
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

function Build-Launcher {
  param(
    [string]$Define,
    [string]$FileName
  )

  $targetPath = Join-Path $outputPath $FileName
  Remove-Item -LiteralPath $targetPath -Force -ErrorAction SilentlyContinue

  & $csc `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /utf8output `
    "/define:$Define" `
    "/win32icon:$iconPath" `
    /reference:System.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.ServiceProcess.dll `
    "/out:$targetPath" `
    $sourcePath

  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "Failed to build QuickHack launcher: $FileName"
  }
}

Build-Launcher -Define "QUICKHACK_CLIENT;QUICKHACK_DEMONSTRATION" -FileName "QuickHack-Demo-Client.exe"
Build-Launcher -Define "QUICKHACK_SERVER;QUICKHACK_DEMONSTRATION" -FileName "QuickHack-Demo-Server.exe"
Build-Launcher -Define "QUICKHACK_CLIENT;QUICKHACK_OPERATIONAL" -FileName "QuickHack-Operational-Client.exe"
Build-Launcher -Define "QUICKHACK_SERVER;QUICKHACK_OPERATIONAL" -FileName "QuickHack-Operational-Server.exe"

Write-Host "QuickHack Windows launchers created:"
Get-Item -LiteralPath `
  (Join-Path $outputPath "QuickHack-Demo-Client.exe"), `
  (Join-Path $outputPath "QuickHack-Demo-Server.exe"), `
  (Join-Path $outputPath "QuickHack-Operational-Client.exe"), `
  (Join-Path $outputPath "QuickHack-Operational-Server.exe") |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
