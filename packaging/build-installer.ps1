param(
  [string]$Version = "",

  [ValidateSet("demo-server", "demo-client", "operational-server", "operational-client")]
  [string]$Target = "demo-server",

  [string]$SourceDir = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $PSScriptRoot

function Get-FileSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  $stream = [System.IO.File]::OpenRead($LiteralPath)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }

  return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
}

if (-not $Version) {
  $packageJsonPath = Join-Path $rootDir "package.json"
  $Version = (Get-Content -LiteralPath $packageJsonPath -Raw -Encoding utf8 | ConvertFrom-Json).version
}

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Invalid package version: $Version"
}

$targetConfig = switch ($Target) {
  "demo-server" {
    @{
      IssFile = "quickhack.iss"
      FilePrefix = "QuickHack-Demo-Server"
      AppId = "{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}"
      ArtifactKind = "DEMONSTRATION_SERVER"
      ArtifactName = "QuickHack Demo Server"
      ArtifactExe = "QuickHack-Demo-Server.exe"
      ArtifactGroup = "QuickHack Demo"
      MutableRootName = "demonstration-server"
      PostgresqlServiceName = "QuickHackDemoPostgreSQL"
      ConsoleServiceName = "QuickHackDemoServerConsole"
      OppositePostgresqlServiceName = "QuickHackOperationalPostgreSQL"
      OppositeConsoleServiceName = "QuickHackOperationalServerConsole"
      OppositeAppId = "{4AF4F2BB-CB9D-46F7-A8F6-1B585A2BEB17}"
    }
  }
  "demo-client" {
    @{
      IssFile = "quickhack-demo-client.iss"
      FilePrefix = "QuickHack-Demo-Client"
      AppId = "{7D88F75C-5D65-4B34-9DD6-EFB19332DD33}"
      ArtifactKind = "DEMONSTRATION_CLIENT"
      ArtifactName = "QuickHack Demo Client"
      ArtifactExe = "QuickHack-Demo-Client.exe"
      ArtifactGroup = "QuickHack Demo"
      MutableRootName = "demonstration-client"
    }
  }
  "operational-server" {
    @{
      IssFile = "quickhack.iss"
      FilePrefix = "QuickHack-Operational-Server"
      AppId = "{4AF4F2BB-CB9D-46F7-A8F6-1B585A2BEB17}"
      ArtifactKind = "OPERATIONAL_SERVER"
      ArtifactName = "QuickHack Operational Server"
      ArtifactExe = "QuickHack-Operational-Server.exe"
      ArtifactGroup = "QuickHack Operational"
      MutableRootName = "operational-server"
      PostgresqlServiceName = "QuickHackOperationalPostgreSQL"
      ConsoleServiceName = "QuickHackOperationalServerConsole"
      OppositePostgresqlServiceName = "QuickHackDemoPostgreSQL"
      OppositeConsoleServiceName = "QuickHackDemoServerConsole"
      OppositeAppId = "{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}"
    }
  }
  "operational-client" {
    @{
      IssFile = "quickhack-demo-client.iss"
      FilePrefix = "QuickHack-Operational-Client"
      AppId = "{121152E5-704B-4952-83FB-6ECEF4956895}"
      ArtifactKind = "OPERATIONAL_CLIENT"
      ArtifactName = "QuickHack Operational Client"
      ArtifactExe = "QuickHack-Operational-Client.exe"
      ArtifactGroup = "QuickHack Operational"
      MutableRootName = "operational-client"
    }
  }
}

if (-not $SourceDir) {
  $SourceDir = "release\windows\$Target"
}
if (-not $OutputDir) {
  $OutputDir = "release\distribution\windows\$Target"
}

$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $rootDir $SourceDir))
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $rootDir $OutputDir))
$issPath = Join-Path $PSScriptRoot $targetConfig.IssFile

if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
  throw "Staging package was not found: $sourcePath"
}

$isccCandidates = @(
  (Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

$iscc = $isccCandidates | Select-Object -First 1
if (-not $iscc) {
  throw "Inno Setup 6 compiler (ISCC.exe) was not found."
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$installerPath = Join-Path $outputPath "$($targetConfig.FilePrefix)-Setup-$Version.exe"
$manifestPath = Join-Path $outputPath "$($targetConfig.FilePrefix)-manifest-$Version.json"
$checksumPath = Join-Path $outputPath "$($targetConfig.FilePrefix)-SHA256SUMS.txt"

Remove-Item -LiteralPath $installerPath, $manifestPath, $checksumPath -Force -ErrorAction SilentlyContinue

$isccArguments = @(
  "/DAppVersion=$Version"
  "/DSourceDir=$sourcePath"
  "/DOutputDir=$outputPath"
  "/DArtifactAppId=$($targetConfig.AppId)"
  "/DArtifactKind=$($targetConfig.ArtifactKind)"
  "/DArtifactName=$($targetConfig.ArtifactName)"
  "/DArtifactExe=$($targetConfig.ArtifactExe)"
  "/DArtifactFilePrefix=$($targetConfig.FilePrefix)"
  "/DArtifactGroup=$($targetConfig.ArtifactGroup)"
  "/DMutableRootName=$($targetConfig.MutableRootName)"
)
if ($targetConfig.PostgresqlServiceName) {
  $isccArguments += "/DPostgresqlServiceName=$($targetConfig.PostgresqlServiceName)"
  $isccArguments += "/DConsoleServiceName=$($targetConfig.ConsoleServiceName)"
  $isccArguments += "/DOppositePostgresqlServiceName=$($targetConfig.OppositePostgresqlServiceName)"
  $isccArguments += "/DOppositeConsoleServiceName=$($targetConfig.OppositeConsoleServiceName)"
  $isccArguments += "/DOppositeAppId=$($targetConfig.OppositeAppId)"
}
$isccArguments += $issPath
& $iscc @isccArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Inno Setup failed to create the QuickHack $Target installer."
}

Copy-Item -LiteralPath (Join-Path $sourcePath "quickhack-package.json") -Destination $manifestPath

$artifacts = @($installerPath, $manifestPath)
$checksumLines = foreach ($artifact in $artifacts) {
  $hash = Get-FileSha256 -LiteralPath $artifact
  "$hash  $([System.IO.Path]::GetFileName($artifact))"
}

Set-Content -LiteralPath $checksumPath -Value $checksumLines -Encoding ascii

Write-Host "QuickHack $Target distribution created:"
Get-Item -LiteralPath $installerPath, $manifestPath, $checksumPath |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
