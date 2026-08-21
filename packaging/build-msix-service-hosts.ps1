[CmdletBinding()]
param(
  [ValidateSet("demo-server", "operational-server")]
  [string]$Target = "demo-server",

  [string]$OutputDir = "",

  [switch]$Preview
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Split-Path -Parent $PSScriptRoot)
)
if (-not $OutputDir) {
  $OutputDir = "release\windows\msix\service-hosts\$Target"
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
  throw "QuickHack service host output must be a descendant of repository release/."
}

$cscCandidates = @(
  (Get-Command csc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$csc = $cscCandidates | Select-Object -First 1
if (-not $csc) {
  throw "Windows C# compiler was not found for QuickHack packaged service hosts."
}

$sourceRoot = Join-Path $PSScriptRoot "windows\msix\service-host"
$hostSource = Join-Path $sourceRoot "QuickHackPackagedServiceHost.cs"
$previewChildSource = Join-Path $sourceRoot "QuickHackPreviewPostgresqlChild.cs"
if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
$servicesPath = Join-Path $outputPath "Services"
New-Item -ItemType Directory -Path $servicesPath -Force | Out-Null

$flavorDefine = if ($Target -eq "demo-server") {
  "QUICKHACK_DEMONSTRATION"
} else {
  "QUICKHACK_OPERATIONAL"
}
$previewDefine = if ($Preview) { ";QUICKHACK_PREVIEW" } else { "" }

function Build-ServiceHost {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RoleDefine,

    [Parameter(Mandatory = $true)]
    [string]$FileName
  )

  $targetPath = Join-Path $servicesPath $FileName
  & $csc `
    /nologo `
    /target:exe `
    /platform:x64 `
    /optimize+ `
    /utf8output `
    "/define:$flavorDefine;$RoleDefine$previewDefine" `
    /reference:System.dll `
    /reference:System.ServiceProcess.dll `
    "/out:$targetPath" `
    $hostSource
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "Failed to build QuickHack packaged service host: $FileName"
  }
}

Build-ServiceHost `
  -RoleDefine "QUICKHACK_POSTGRESQL" `
  -FileName "QuickHackPostgresqlServiceHost.exe"
Build-ServiceHost `
  -RoleDefine "QUICKHACK_CONSOLE" `
  -FileName "QuickHackServerServiceHost.exe"

if ($Preview) {
  & $csc `
    /nologo `
    /target:exe `
    /platform:x64 `
    /optimize+ `
    /utf8output `
    "/out:$(Join-Path $outputPath 'QuickHackPreviewPostgresqlChild.exe')" `
    $previewChildSource
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build the QuickHack PostgreSQL service preview child."
  }

  Copy-Item `
    -LiteralPath (Join-Path $sourceRoot "quickhack-preview-console-child.mjs") `
    -Destination (Join-Path $servicesPath "quickhack-preview-console-child.mjs")
  Set-Content `
    -LiteralPath (Join-Path $servicesPath "quickhack-msix-service-preview.txt") `
    -Value "QUICKHACK_MSIX_SERVICE_PREVIEW_V1" `
    -Encoding ascii
}

Write-Host "QuickHack $Target packaged service hosts created: $outputPath"
Get-ChildItem -LiteralPath $outputPath -File -Recurse |
  Select-Object FullName,Length
