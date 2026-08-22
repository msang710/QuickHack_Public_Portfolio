[CmdletBinding()]
param(
  [string]$SdkRoot = $env:QUICKHACK_WINDOWS_SDK_ROOT,
  [string]$NodePath = $env:QUICKHACK_NODE_EXECUTABLE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $SdkRoot) {
  throw "Pass -SdkRoot or set QUICKHACK_WINDOWS_SDK_ROOT to Microsoft.Windows.SDK.BuildTools."
}

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..\..")
)
$validationRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot "release\windows\msix\pr02-foundation-test")
)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
if (-not $validationRoot.StartsWith(
  $allowedRoot + [System.IO.Path]::DirectorySeparatorChar,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "Unsafe MSIX foundation validation root: $validationRoot"
}

if (Test-Path -LiteralPath $validationRoot) {
  Remove-Item -LiteralPath $validationRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null

$nodeExecutable = $NodePath
if (-not $nodeExecutable) {
  $nodeExecutable = Get-Command node.exe -ErrorAction Stop |
    Select-Object -ExpandProperty Source -First 1
}
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  throw "QuickHack MSIX foundation Node executable was not found: $nodeExecutable"
}

$launcherOutput = Join-Path $validationRoot "launchers"
& (Join-Path $repositoryRoot "packaging\build-windows-launchers.ps1") `
  -OutputDir "release\windows\msix\pr02-foundation-test\launchers"

$targets = @(
  [pscustomobject]@{ Name = "demo-server"; Launcher = "QuickHack-Demo-Server.exe"; Server = $true },
  [pscustomobject]@{ Name = "demo-client"; Launcher = "QuickHack-Demo-Client.exe"; Server = $false },
  [pscustomobject]@{ Name = "operational-server"; Launcher = "QuickHack-Operational-Server.exe"; Server = $true },
  [pscustomobject]@{ Name = "operational-client"; Launcher = "QuickHack-Operational-Client.exe"; Server = $false }
)

try {
  foreach ($target in $targets) {
    $stagingPath = Join-Path $validationRoot "staging\$($target.Name)"
    New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
    Copy-Item `
      -LiteralPath (Join-Path $launcherOutput $target.Launcher) `
      -Destination (Join-Path $stagingPath $target.Launcher)
    $nodePath = Join-Path $stagingPath "runtime\node\node.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $nodePath) -Force | Out-Null
    Copy-Item -LiteralPath "$env:WINDIR\System32\where.exe" -Destination $nodePath
    Set-Content -LiteralPath (Join-Path (Split-Path -Parent $nodePath) "LICENSE") -Value "MSIX foundation fixture" -Encoding ascii
    Set-Content -LiteralPath (Join-Path (Split-Path -Parent $nodePath) "quickhack-node-runtime.json") -Value '{"schemaVersion":1,"fixture":true}' -Encoding ascii
    if ($target.Server) {
      $postgresPath = Join-Path $stagingPath "runtime\postgresql\bin\postgres.exe"
      New-Item -ItemType Directory -Path (Split-Path -Parent $postgresPath) -Force | Out-Null
      Copy-Item -LiteralPath "$env:WINDIR\System32\where.exe" -Destination $postgresPath
      New-Item -ItemType Directory -Path (Join-Path $stagingPath "runtime\postgresql\lib") -Force | Out-Null
      New-Item -ItemType Directory -Path (Join-Path $stagingPath "runtime\postgresql\share") -Force | Out-Null
      Set-Content -LiteralPath (Join-Path $stagingPath "runtime\postgresql\lib\runtime.txt") -Value "fixture" -Encoding ascii
      Set-Content -LiteralPath (Join-Path $stagingPath "runtime\postgresql\share\runtime.txt") -Value "fixture" -Encoding ascii
    }

    $signingMode = if ($target.Name -eq "demo-client") { "TestCertificate" } else { "Unsigned" }
    & (Join-Path $repositoryRoot "packaging\build-msix.ps1") `
      -Target $target.Name `
      -Version "1.0.0" `
      -SourceDir "release\windows\msix\pr02-foundation-test\staging\$($target.Name)" `
      -OutputDir "release\windows\msix\pr02-foundation-test\distribution\$($target.Name)" `
      -SigningMode $signingMode `
      -NodePath $nodeExecutable `
      -SdkRoot $SdkRoot

    $distributionPath = Join-Path $validationRoot "distribution\$($target.Name)"
    $files = @(Get-ChildItem -LiteralPath $distributionPath -File)
    if ($files.Count -ne 3) {
      throw "Unexpected MSIX distribution file count for $($target.Name): $($files.Count)"
    }
    if (-not ($files.Name -contains "$($target.Launcher.Replace('.exe', ''))-1.0.0.msix")) {
      throw "Expected MSIX file was not created for $($target.Name)."
    }
  }

  Write-Host "QuickHack exact-four MSIX pack, unpack, runtime, branding, and test-signing foundation verified."
} finally {
  if (Test-Path -LiteralPath $validationRoot) {
    Remove-Item -LiteralPath $validationRoot -Recurse -Force
  }
}
