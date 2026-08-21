[CmdletBinding()]
param(
  [string]$SdkRoot = $env:QUICKHACK_WINDOWS_SDK_ROOT,
  [string]$NodePath = $env:QUICKHACK_NODE_EXECUTABLE,
  [string]$StagingDir = "release\windows\demo-client"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$validationRoot = Join-Path $releaseRoot "windows\msix\pr04-demo-client-test"
$evidenceRoot = Join-Path $releaseRoot "windows\msix\evidence"
$evidencePath = Join-Path $evidenceRoot "pr04-demo-client-msix.json"
$stagingPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $StagingDir))
$identityName = "QuickHack.Demonstration.Client"
$applicationName = "QuickHack Demo Client"
$launcherName = "QuickHack-Demo-Client.exe"
$mutableRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "QuickHack\demonstration-client")
)
$expectedMutableRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "QuickHack\demonstration-client")
)
if ($mutableRoot -ne $expectedMutableRoot) {
  throw "Unexpected QuickHack demo-client mutable root."
}
foreach ($pathToValidate in @($validationRoot, $evidenceRoot)) {
  $fullPath = [System.IO.Path]::GetFullPath($pathToValidate)
  if (-not $fullPath.StartsWith(
    $releaseRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe QuickHack PR-04 validation path: $fullPath"
  }
}
if (-not $SdkRoot) { throw "Pass -SdkRoot or set QUICKHACK_WINDOWS_SDK_ROOT." }
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction Stop | Select-Object -ExpandProperty Source -First 1
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "QuickHack PR-04 fixture Node executable was not found: $NodePath"
}
if (-not (Test-Path -LiteralPath $stagingPath -PathType Container)) {
  throw "QuickHack demo-client staging package was not found: $stagingPath"
}
foreach ($requiredRelativePath in @(
  $launcherName,
  "quickhack-package.json",
  "runtime\node\node.exe",
  "runtime\node\LICENSE",
  "runtime\node\quickhack-node-runtime.json",
  "client\server.js"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $stagingPath $requiredRelativePath) -PathType Leaf)) {
    throw "QuickHack demo-client staging is incomplete: $requiredRelativePath"
  }
}
if (Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue) {
  throw "QuickHack demo-client MSIX is already installed; refusing to mutate an existing installation."
}
if (Test-Path -LiteralPath $mutableRoot) {
  throw "QuickHack demo-client user state already exists; refusing to overwrite it."
}
if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) {
  throw "QuickHack demo-client port 3001 is already in use."
}

function Remove-ValidationDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $fullPath.StartsWith(
    $releaseRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Refusing to remove a validation directory outside QuickHack release/: $fullPath"
  }
  $longPath = if ($fullPath.StartsWith("\\?\")) { $fullPath } else { "\\?\$fullPath" }
  if ([System.IO.Directory]::Exists($longPath)) {
    [System.IO.Directory]::Delete($longPath, $true)
  }
}

function Wait-File {
  param([string]$Path, [int]$Seconds = 120)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for QuickHack fixture file: $Path"
}

function Wait-ClientRuntime {
  param([bool]$Expected, [int]$Seconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-RestMethod `
        -Uri "http://127.0.0.1:3001/api/runtime" `
        -Method Get `
        -TimeoutSec 2 `
        -ErrorAction Stop
      if ($Expected) {
        if (
          $response.role -eq "client" -and
          $response.deploymentFlavor -eq "DEMONSTRATION" -and
          $response.artifactKind -eq "DEMONSTRATION_CLIENT"
        ) { return $response }
      }
    } catch {
      if (-not $Expected) { return $null }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "QuickHack demo-client runtime expected=$Expected was not observed."
}

function Invoke-ClientLauncher {
  param(
    [ValidateSet("start", "stop", "status")]
    [string]$Command
  )
  $launcherPath = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\$launcherName"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "QuickHack demo-client app execution alias was not registered: $launcherPath"
    }
    Start-Sleep -Milliseconds 250
  }
  $process = Start-Process `
    -FilePath $launcherPath `
    -ArgumentList @($Command, "--no-open", "--quiet") `
    -WindowStyle Hidden `
    -PassThru
  # The cmdlet's tree-wait option follows a successful launcher into its
  # long-lived runtime process tree. Wait only for the direct process instead.
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    $errorPath = Join-Path $mutableRoot "launcher-error.log"
    $detail = if (Test-Path -LiteralPath $errorPath -PathType Leaf) {
      (Get-Content -LiteralPath $errorPath -Raw -Encoding utf8).Trim()
    } else {
      "No quiet launcher error record was produced."
    }
    throw "QuickHack demo-client launcher $Command failed with exit code $($process.ExitCode). $detail"
  }
}

function Get-ClientProcessProof {
  param([string]$InstallLocation)
  $statePath = Join-Path $mutableRoot "client-3001.json"
  Wait-File -Path $statePath -Seconds 30
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
  if ($state.state -ne "CLAIMED" -or [int]$state.pid -le 0) {
    throw "QuickHack demo-client durable owner state is invalid."
  }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction Stop
  $expectedNode = Join-Path $InstallLocation "runtime\node\node.exe"
  if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($owner.ExecutablePath),
    [System.IO.Path]::GetFullPath($expectedNode),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "QuickHack demo-client escaped the package Node runtime: $($owner.ExecutablePath)"
  }
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$state.pid)" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "node.exe" } |
    Select-Object -First 1
  if (-not $child -or -not [string]::Equals(
    [System.IO.Path]::GetFullPath($child.ExecutablePath),
    [System.IO.Path]::GetFullPath($expectedNode),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "QuickHack demo-client standalone child is not package-owned Node."
  }
  return [pscustomobject]@{
    ownerPid = [int]$state.pid
    ownerPath = [string]$owner.ExecutablePath
    childPid = [int]$child.ProcessId
    childPath = [string]$child.ExecutablePath
    packageManifest = [string]$state.artifactKind
  }
}

function Assert-BrandingRegistration {
  param([string]$InstallLocation, [string]$PackageFamilyName)
  $installedManifest = Get-Content `
    -LiteralPath (Join-Path $InstallLocation "Assets\visual-assets.manifest.json") `
    -Raw `
    -Encoding utf8 | ConvertFrom-Json
  $brandingContract = Get-Content `
    -LiteralPath (Join-Path $repositoryRoot "assets\branding\windows-icon.json") `
    -Raw `
    -Encoding utf8 | ConvertFrom-Json
  if ($installedManifest.brandingRevision -ne $brandingContract.brandingRevision) {
    throw "Installed QuickHack demo-client branding revision is stale."
  }
  foreach ($output in $installedManifest.outputs) {
    $assetPath = Join-Path (Join-Path $InstallLocation "Assets") $output.path
    $hash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $output.sha256) {
      throw "Installed QuickHack visual asset hash mismatch: $($output.path)"
    }
  }
  $startApplicationId = "$PackageFamilyName!QuickHackDemoClient"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $startEntry = Get-StartApps -ErrorAction SilentlyContinue |
      Where-Object { $_.AppID -eq $startApplicationId } |
      Select-Object -First 1
    if ($startEntry) { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $startEntry -or $startEntry.Name -ne $applicationName) {
    throw "QuickHack demo-client Start Menu registration was not observed."
  }
  return [pscustomobject]@{
    brandingRevision = [string]$installedManifest.brandingRevision
    canonicalIconSha256 = [string]$brandingContract.source.sha256
    installedAssetCount = @($installedManifest.outputs).Count
    appInstallerAsset = "Assets\StoreLogo.png"
    startMenuAsset = "Assets\Square44x44Logo.png"
    taskbarAssets = @("Assets\Square44x44Logo.targetsize-24.png", "Assets\Square44x44Logo.targetsize-32.png")
    installedAppsAsset = "Assets\Square44x44Logo.png"
    startApplicationId = $startApplicationId
  }
}

function Remove-TestCertificate {
  param([string]$CertificatePath)
  if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) { return }
  $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath)
  # LocalMachine\TrustedPeople is owned and removed by the elevated guardian.
  # CurrentUser\TrustedPeople can expose the machine-store certificates through
  # an aggregate view, and removing those entries without elevation fails.
  foreach ($storeName in @("Root", "My")) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
      $storeName,
      [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    try {
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
      foreach ($storedCertificate in @($store.Certificates.Find(
        [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
        $certificate.Thumbprint,
        $false
      ))) {
        $store.Remove($storedCertificate)
      }
    } finally {
      $store.Close()
    }
  }
}

if (Test-Path -LiteralPath $validationRoot) {
  Remove-ValidationDirectory -Path $validationRoot
}
New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null

$fixtureProcess = $null
$guardianProcess = $null
$installedPackage = $null
$certificates = @()
$stopFile = Join-Path $validationRoot "fixture.stop"
$guardianReady = Join-Path $validationRoot "certificate-guardian-ready.json"
$guardianStop = Join-Path $validationRoot "certificate-guardian.stop"
try {
  $fixtureReady = Join-Path $validationRoot "fixture-ready.json"
  $fixtureWork = Join-Path $validationRoot "fixture"
  $fixtureScript = Join-Path $PSScriptRoot "demo-client-central-server-fixture.mjs"
  $fixtureProcess = Start-Process `
    -FilePath $NodePath `
    -ArgumentList @(
      $fixtureScript,
      "--config-dir", $mutableRoot,
      "--work-dir", $fixtureWork,
      "--ready-file", $fixtureReady,
      "--stop-file", $stopFile
    ) `
    -WorkingDirectory $repositoryRoot `
    -WindowStyle Hidden `
    -PassThru
  Wait-File -Path $fixtureReady
  $fixture = Get-Content -LiteralPath $fixtureReady -Raw -Encoding utf8 | ConvertFrom-Json
  if ($fixture.status -ne "READY" -or -not (Test-Path -LiteralPath (Join-Path $mutableRoot "trust-bundle.json"))) {
    throw "QuickHack demo-client central-server fixture is invalid."
  }

  $distributions = @()
  foreach ($revision in @(41, 42)) {
    $outputRelative = "release\windows\msix\pr04-demo-client-test\distribution-$revision"
    $certificateRelative = "$outputRelative\QuickHack-demo-client-$revision.cer"
    & (Join-Path $repositoryRoot "packaging\build-msix.ps1") `
      -Target demo-client `
      -Version "1.0.0-pr04.$revision" `
      -SourceDir $StagingDir `
      -OutputDir $outputRelative `
      -SigningMode TestCertificate `
      -SdkRoot $SdkRoot `
      -NodePath $NodePath `
      -TestCertificateCerPath $certificateRelative
    $distribution = [pscustomobject]@{
      package = Join-Path $repositoryRoot "$outputRelative\QuickHack-Demo-Client-1.0.0-pr04.$revision.msix"
      certificate = Join-Path $repositoryRoot $certificateRelative
    }
    $certificates += $distribution.certificate
    $distributions += $distribution
  }

  $guardianScript = Join-Path $PSScriptRoot "quickhack-test-certificate-guardian.ps1"
  $guardianArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", $guardianScript,
    "-CertificateV1", $distributions[0].certificate,
    "-CertificateV2", $distributions[1].certificate,
    "-ReadyFile", $guardianReady,
    "-StopFile", $guardianStop
  )
  $guardianProcess = Start-Process `
    -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList $guardianArguments `
    -Verb RunAs `
    -WindowStyle Hidden `
    -PassThru
  Wait-File -Path $guardianReady -Seconds 120
  if ($guardianProcess.HasExited) {
    throw "QuickHack test certificate guardian exited before the lifecycle test."
  }

  Add-AppxPackage -Path $distributions[0].package -ForceApplicationShutdown -ErrorAction Stop
  $installedPackage = Get-AppxPackage -Name $identityName -ErrorAction Stop
  if ($installedPackage.Version.ToString() -ne "1.0.0.41") {
    throw "Unexpected QuickHack demo-client initial MSIX version."
  }
  $branding = Assert-BrandingRegistration `
    -InstallLocation $installedPackage.InstallLocation `
    -PackageFamilyName $installedPackage.PackageFamilyName
  Invoke-ClientLauncher -Command start
  $runtimeV1 = Wait-ClientRuntime -Expected $true
  $processV1 = Get-ClientProcessProof -InstallLocation $installedPackage.InstallLocation
  Invoke-ClientLauncher -Command stop
  Wait-ClientRuntime -Expected $false | Out-Null
  if (Get-Process -Id $processV1.ownerPid -ErrorAction SilentlyContinue) {
    throw "QuickHack demo-client left an owner process after stop."
  }

  Add-AppxPackage -Path $distributions[1].package -ForceApplicationShutdown -ErrorAction Stop
  $installedPackage = Get-AppxPackage -Name $identityName -ErrorAction Stop
  if ($installedPackage.Version.ToString() -ne "1.0.0.42") {
    throw "QuickHack demo-client MSIX update did not select the newer version."
  }
  Invoke-ClientLauncher -Command start
  $runtimeV2 = Wait-ClientRuntime -Expected $true
  $processV2 = Get-ClientProcessProof -InstallLocation $installedPackage.InstallLocation
  Invoke-ClientLauncher -Command stop
  Wait-ClientRuntime -Expected $false | Out-Null
  if (Get-Process -Id $processV2.ownerPid -ErrorAction SilentlyContinue) {
    throw "QuickHack updated demo-client left an owner process after stop."
  }

  $trustBundleHashBeforeUninstall = (
    Get-FileHash -LiteralPath (Join-Path $mutableRoot "trust-bundle.json") -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  Remove-AppxPackage -Package $installedPackage.PackageFullName -Confirm:$false -ErrorAction Stop
  $installedPackage = $null
  if (Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue) {
    throw "QuickHack demo-client MSIX remained installed after uninstall."
  }
  if (-not (Test-Path -LiteralPath $mutableRoot -PathType Container)) {
    throw "Normal QuickHack demo-client uninstall removed preserved user configuration."
  }
  $trustBundleHashAfterUninstall = (
    Get-FileHash -LiteralPath (Join-Path $mutableRoot "trust-bundle.json") -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($trustBundleHashAfterUninstall -ne $trustBundleHashBeforeUninstall) {
    throw "Normal QuickHack demo-client uninstall changed preserved user configuration."
  }

  [ordered]@{
    schemaVersion = 1
    status = "PASS"
    osBuild = [Environment]::OSVersion.Version.Build
    packageIdentity = $identityName
    initialVersion = "1.0.0.41"
    updatedVersion = "1.0.0.42"
    packageNodeVersion = (& (Join-Path $stagingPath "runtime\node\node.exe") --version).Trim()
    externalNodeRequired = $false
    initialRuntime = $runtimeV1
    updatedRuntime = $runtimeV2
    initialProcesses = $processV1
    updatedProcesses = $processV2
    stopOrphanCount = 0
    updateVerified = $true
    normalUninstallPreservedConfig = $true
    trustBundleSha256 = $trustBundleHashAfterUninstall
    branding = $branding
    appExecutionAlias = $launcherName
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Host "QuickHack demo-client MSIX install, package-Node launch, update, stop, branding, and uninstall gate passed."
} finally {
  $currentPackage = Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue
  if ($currentPackage) {
    try {
      Invoke-ClientLauncher -Command stop
    } catch { }
    Remove-AppxPackage -Package $currentPackage.PackageFullName -Confirm:$false -ErrorAction SilentlyContinue
  }
  if ($fixtureProcess -and -not $fixtureProcess.HasExited) {
    Set-Content -LiteralPath $stopFile -Value "stop" -Encoding ascii
    if (-not $fixtureProcess.WaitForExit(15000)) {
      Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if ($guardianProcess -and -not $guardianProcess.HasExited) {
    Set-Content -LiteralPath $guardianStop -Value "stop" -Encoding ascii
    if (-not $guardianProcess.WaitForExit(15000)) {
      Stop-Process -Id $guardianProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($certificatePath in $certificates) {
    Remove-TestCertificate -CertificatePath $certificatePath
  }
  if (Test-Path -LiteralPath $mutableRoot) {
    Remove-Item -LiteralPath $mutableRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $validationRoot) {
    Remove-ValidationDirectory -Path $validationRoot
  }
}
