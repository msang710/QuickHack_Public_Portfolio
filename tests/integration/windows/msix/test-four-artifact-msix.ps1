[CmdletBinding()]
param(
  [string]$NodePath = $env:QUICKHACK_NODE_EXECUTABLE,
  [string]$Version = "1.0.0-pr07.70",
  [string]$DistributionDir = "release\distribution\windows\msix\exact-four",
  [string]$CertificateDir = "release\windows\msix\evidence\pr07-certificates",
  [string]$EvidencePath = "release\windows\msix\evidence\pr07-four-artifact-msix.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\.."))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$distributionPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $DistributionDir))
$certificatePath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $CertificateDir))
$resolvedEvidencePath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidencePath))
$validationRoot = Join-Path $releaseRoot "windows\msix\pr07-four-artifact-test"
$firewallRuleName = "QuickHack HTTPS Server (Local Subnet)"
$version = $Version

foreach ($ownedPath in @($distributionPath, $certificatePath, $resolvedEvidencePath, $validationRoot)) {
  if (-not $ownedPath.StartsWith(
    $releaseRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe QuickHack PR-07 path: $ownedPath"
  }
}
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction Stop | Select-Object -ExpandProperty Source -First 1
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "QuickHack PR-07 host Node executable was not found."
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "QuickHack PR-07 native matrix requires an administrator token."
}

$artifacts = @(
  [pscustomobject]@{
    target = "demo-server"; artifactKind = "DEMONSTRATION_SERVER"; role = "server"
    identityName = "QuickHack.Demonstration.Server"; prefix = "QuickHack-Demo-Server"
    mutableRoot = Join-Path $env:ProgramData "QuickHack\demonstration-server"
    launcher = "QuickHack-Demo-Server.exe"; port = 0
  },
  [pscustomobject]@{
    target = "demo-client"; artifactKind = "DEMONSTRATION_CLIENT"; role = "client"
    identityName = "QuickHack.Demonstration.Client"; prefix = "QuickHack-Demo-Client"
    mutableRoot = Join-Path $env:LOCALAPPDATA "QuickHack\demonstration-client"
    launcher = "QuickHack-Demo-Client.exe"; port = 3001
  },
  [pscustomobject]@{
    target = "operational-server"; artifactKind = "OPERATIONAL_SERVER"; role = "server"
    identityName = "QuickHack.Operational.Server"; prefix = "QuickHack-Operational-Server"
    mutableRoot = Join-Path $env:ProgramData "QuickHack\operational-server"
    launcher = "QuickHack-Operational-Server.exe"; port = 0
  },
  [pscustomobject]@{
    target = "operational-client"; artifactKind = "OPERATIONAL_CLIENT"; role = "client"
    identityName = "QuickHack.Operational.Client"; prefix = "QuickHack-Operational-Client"
    mutableRoot = Join-Path $env:LOCALAPPDATA "QuickHack\operational-client"
    launcher = "QuickHack-Operational-Client.exe"; port = 3002
  }
)
$serviceNames = @(
  "QuickHackDemoPostgreSQL",
  "QuickHackDemoServerConsole",
  "QuickHackOperationalPostgreSQL",
  "QuickHackOperationalServerConsole"
)

function Remove-OwnedDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  $fullPath = [IO.Path]::GetFullPath($Path)
  $approved = @($validationRoot) + @($artifacts | ForEach-Object { [IO.Path]::GetFullPath($_.mutableRoot) })
  if (-not ($approved | Where-Object { $_.Equals($fullPath, [StringComparison]::OrdinalIgnoreCase) })) {
    throw "Refusing to remove a path outside the PR-07 exact ownership set: $fullPath"
  }
  if (Test-Path -LiteralPath $fullPath) {
    $item = Get-Item -LiteralPath $fullPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to remove a reparse point: $fullPath"
    }
    Remove-Item -LiteralPath $fullPath -Recurse -Force
  }
}

function Wait-File {
  param([Parameter(Mandatory = $true)][string]$Path, [int]$Seconds = 120)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for a QuickHack PR-07 file."
}

function Wait-ServiceMissing {
  param([Parameter(Mandatory = $true)][string]$Name, [int]$Seconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "QuickHack service remained registered: $Name"
}

function Quote-NativeArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Invoke-SetupAction {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("PROVISION", "ACKNOWLEDGE")][string]$Action,
    [Parameter(Mandatory = $true)][string]$InstallLocation,
    [string]$TransactionId = "",
    [int]$Generation = 0,
    [string]$ExpectedFailureCode = ""
  )
  $setup = Join-Path $InstallLocation "QuickHack-Operational-Server-Setup.exe"
  $arguments = @("--native-test-stdio", $Action)
  if ($Action -eq "ACKNOWLEDGE") {
    $arguments += @($TransactionId, $Generation.ToString([Globalization.CultureInfo]::InvariantCulture))
  }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $setup
  $startInfo.Arguments = ($arguments | ForEach-Object { Quote-NativeArgument $_ }) -join " "
  $startInfo.WorkingDirectory = $InstallLocation
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["QUICKHACK_SERVER_SETUP_NATIVE_TEST_GATE"] = "PR05_MSIX_GATE"
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "QuickHack operational Server Setup did not start." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if ($process.ExitCode -ne 0) {
    $errorCode = if ($stderr -match 'errorCode=([A-Z][A-Z0-9_]{2,95})') { $Matches[1] } else { "SERVER_SETUP_NATIVE_TEST_FAILED" }
    if ($ExpectedFailureCode -and $errorCode -eq $ExpectedFailureCode) {
      return [pscustomobject]@{ status = "EXPECTED_FAILURE"; errorCode = $errorCode }
    }
    throw "QuickHack operational Server Setup $Action stopped with $errorCode."
  }
  if ($ExpectedFailureCode) {
    throw "QuickHack operational Server Setup unexpectedly succeeded; expected $ExpectedFailureCode."
  }
  $lines = @($stdout -split "`r?`n" | Where-Object { $_ })
  if ($lines.Count -lt 3 -or $lines[0] -ne "QUICKHACK_SERVER_SETUP_HANDOFF_V1") {
    throw "QuickHack operational Server Setup returned an invalid handoff."
  }
  $fields = @{}
  foreach ($line in $lines[1..($lines.Count - 1)]) {
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { throw "QuickHack operational Server Setup returned an invalid field." }
    $fields[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
  }
  return [pscustomobject]@{
    status = [string]$fields.status
    transactionId = [string]$fields.transactionId
    generation = if ($fields.ContainsKey("generation")) { [int]$fields.generation } else { 0 }
    temporaryPassword = if ($fields.ContainsKey("temporaryPassword")) { [string]$fields.temporaryPassword } else { "" }
  }
}

function Start-CentralFixture {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("DEMONSTRATION", "OPERATIONAL")][string]$Flavor
  )
  $slug = $Flavor.ToLowerInvariant()
  $fixtureRoot = Join-Path $validationRoot "${slug}-fixture"
  $configRoot = Join-Path $validationRoot "${slug}-config"
  $readyFile = Join-Path $fixtureRoot "ready.json"
  $stopFile = Join-Path $fixtureRoot "stop"
  $process = Start-Process `
    -FilePath $NodePath `
    -ArgumentList @(
      (Join-Path $PSScriptRoot "demo-client-central-server-fixture.mjs"),
      "--config-dir", $configRoot,
      "--work-dir", (Join-Path $fixtureRoot "work"),
      "--ready-file", $readyFile,
      "--stop-file", $stopFile,
      "--deployment-flavor", $Flavor,
      "--artifact-kind", "$($Flavor)_SERVER"
    ) `
    -WorkingDirectory $repositoryRoot `
    -WindowStyle Hidden `
    -PassThru
  Wait-File -Path $readyFile
  if ($process.HasExited) { throw "QuickHack $Flavor central fixture exited early." }
  return [pscustomobject]@{ process = $process; configRoot = $configRoot; stopFile = $stopFile }
}

function Invoke-ClientLauncher {
  param(
    [Parameter(Mandatory = $true)]$Artifact,
    [Parameter(Mandatory = $true)][ValidateSet("start", "stop")][string]$Command,
    [switch]$ExpectFailure
  )
  $launcherPath = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\$($Artifact.launcher)"
  Wait-File -Path $launcherPath -Seconds 30
  $process = Start-Process `
    -FilePath $launcherPath `
    -ArgumentList @($Command, "--no-open", "--quiet") `
    -WindowStyle Hidden `
    -PassThru
  $process.WaitForExit()
  if ($ExpectFailure) {
    if ($process.ExitCode -eq 0) { throw "QuickHack cross-flavor client unexpectedly started." }
    return
  }
  if ($process.ExitCode -ne 0) {
    throw "QuickHack $($Artifact.target) launcher $Command failed with exit code $($process.ExitCode)."
  }
}

function Wait-ClientRuntime {
  param([Parameter(Mandatory = $true)]$Artifact, [bool]$Expected = $true, [int]$Seconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($Artifact.port)/api/runtime" -TimeoutSec 2
      if ($Expected -and $response.artifactKind -eq $Artifact.artifactKind) { return $response }
    } catch {
      if (-not $Expected) { return $null }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "QuickHack $($Artifact.target) runtime expected=$Expected was not observed."
}

function Get-ClientProcessProof {
  param([Parameter(Mandatory = $true)]$Artifact, [Parameter(Mandatory = $true)][string]$InstallLocation)
  $statePath = Join-Path $Artifact.mutableRoot "client-$($Artifact.port).json"
  Wait-File -Path $statePath -Seconds 30
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction Stop
  $expectedNode = [IO.Path]::GetFullPath((Join-Path $InstallLocation "runtime\node\node.exe"))
  if (-not [string]::Equals([IO.Path]::GetFullPath($owner.ExecutablePath), $expectedNode, [StringComparison]::OrdinalIgnoreCase)) {
    throw "QuickHack client escaped package-owned Node."
  }
  return [pscustomobject]@{ artifactKind = [string]$state.artifactKind; nodePath = [string]$owner.ExecutablePath }
}

function Invoke-OwnedPurge {
  param([Parameter(Mandatory = $true)]$Artifact)
  & (Join-Path $repositoryRoot "packaging\windows\purge-installation.ps1") `
    -ArtifactKind $Artifact.artifactKind `
    -ConfirmArtifactKind $Artifact.artifactKind `
    -ConfirmPackageIdentity $Artifact.identityName `
    -AcknowledgeNoRecovery $true
  if ($LASTEXITCODE -ne 0) { throw "QuickHack purge failed for $($Artifact.artifactKind)." }
}

$guardian = $null
$fixtures = @()
$installed = @{}
$certificateThumbprints = @()
$matrixPassed = $false
try {
  if (Test-Path -LiteralPath $validationRoot) { Remove-OwnedDirectory -Path $validationRoot }
  New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedEvidencePath) -Force | Out-Null

  foreach ($artifact in $artifacts) {
    if (Get-AppxPackage -Name $artifact.identityName -ErrorAction SilentlyContinue) {
      throw "QuickHack package residue exists before PR-07: $($artifact.identityName)"
    }
    if (Test-Path -LiteralPath $artifact.mutableRoot) {
      throw "QuickHack mutable residue exists before PR-07: $($artifact.artifactKind)"
    }
    $artifact | Add-Member -NotePropertyName packagePath -NotePropertyValue (
      Join-Path $distributionPath "$($artifact.target)\$($artifact.prefix)-$version.msix"
    )
    $artifact | Add-Member -NotePropertyName certificate -NotePropertyValue (
      Join-Path $certificatePath "$($artifact.target).cer"
    )
    if (-not (Test-Path -LiteralPath $artifact.packagePath -PathType Leaf)) {
      throw "QuickHack exact-four package is missing: $($artifact.target)"
    }
    if (-not (Test-Path -LiteralPath $artifact.certificate -PathType Leaf)) {
      throw "QuickHack exact-four test certificate is missing: $($artifact.target)"
    }
    $certificateThumbprints += (
      New-Object Security.Cryptography.X509Certificates.X509Certificate2($artifact.certificate)
    ).Thumbprint
  }
  foreach ($serviceName in $serviceNames) {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
      throw "QuickHack service residue exists before PR-07: $serviceName"
    }
  }
  foreach ($port in @(3001, 3002)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
      throw "QuickHack client port is occupied before PR-07: $port"
    }
  }

  & $NodePath (Join-Path $repositoryRoot "packaging\windows\msix\four-artifact-distribution.mjs") `
    "--directory=$distributionPath" "--version=$version"
  if ($LASTEXITCODE -ne 0) { throw "QuickHack exact-four verifier failed before install." }

  $guardianReady = Join-Path $validationRoot "guardian-ready.json"
  $guardianStop = Join-Path $validationRoot "guardian.stop"
  $guardian = Start-Process `
    -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $PSScriptRoot "quickhack-test-certificate-guardian.ps1"),
      "-CertificateV1", $artifacts[0].certificate,
      "-CertificateV2", $artifacts[1].certificate,
      "-CertificateV3", $artifacts[2].certificate,
      "-CertificateV4", $artifacts[3].certificate,
      "-ReadyFile", $guardianReady,
      "-StopFile", $guardianStop
    ) `
    -WindowStyle Hidden `
    -PassThru
  Wait-File -Path $guardianReady
  if ($guardian.HasExited) { throw "QuickHack certificate guardian exited early." }

  $fixtures += Start-CentralFixture -Flavor DEMONSTRATION
  $fixtures += Start-CentralFixture -Flavor OPERATIONAL

  foreach ($artifact in @($artifacts[1], $artifacts[3], $artifacts[0], $artifacts[2])) {
    Add-AppxPackage -Path $artifact.packagePath -ForceApplicationShutdown -ErrorAction Stop
    $installed[$artifact.target] = Get-AppxPackage -Name $artifact.identityName -ErrorAction Stop
  }

  $operationalServer = $artifacts[2]
  $operationalInstall = [string]$installed[$operationalServer.target].InstallLocation
  $conflict = Invoke-SetupAction `
    -Action PROVISION `
    -InstallLocation $operationalInstall `
    -ExpectedFailureCode "OPPOSITE_SERVER_FLAVOR_PRESENT"
  $operationalConfig = Join-Path $operationalServer.mutableRoot "config\server-runtime.json"
  if (Test-Path -LiteralPath $operationalConfig -PathType Leaf) {
    throw "Opposite server conflict mutated operational runtime config."
  }
  if (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue) {
    throw "Opposite server conflict mutated the QuickHack firewall rule."
  }

  Remove-AppxPackage -Package $installed["demo-server"].PackageFullName -Confirm:$false -ErrorAction Stop
  $installed.Remove("demo-server")
  Wait-ServiceMissing -Name "QuickHackDemoPostgreSQL"
  Wait-ServiceMissing -Name "QuickHackDemoServerConsole"

  $provision = Invoke-SetupAction -Action PROVISION -InstallLocation $operationalInstall
  if ($provision.status -ne "INITIAL_LEADER_PENDING_ACK" -or -not $provision.temporaryPassword) {
    throw "QuickHack operational initial LEADER handoff is invalid."
  }
  $transactionId = $provision.transactionId
  $generation = $provision.generation
  $provision.temporaryPassword = ""
  $ready = Invoke-SetupAction `
    -Action ACKNOWLEDGE `
    -InstallLocation $operationalInstall `
    -TransactionId $transactionId `
    -Generation $generation
  if ($ready.status -ne "READY") { throw "QuickHack operational Server Setup did not reach READY." }
  $runtimeConfig = Get-Content -LiteralPath $operationalConfig -Raw -Encoding utf8 | ConvertFrom-Json
  if ($runtimeConfig.packageFlavor -ne "OPERATIONAL") { throw "Operational runtime flavor is invalid." }
  if (@($runtimeConfig.database.PSObject.Properties.Name | Where-Object { $_ -match 'Mock' }).Count -ne 0) {
    throw "Operational runtime config contains demonstration database identities."
  }
  foreach ($name in @("QuickHackOperationalPostgreSQL", "QuickHackOperationalServerConsole")) {
    if ((Get-Service -Name $name -ErrorAction Stop).Status -ne "Running") {
      throw "QuickHack operational service did not reach Running: $name"
    }
  }
  $credentials = @(Get-ChildItem -LiteralPath (Join-Path $operationalServer.mutableRoot "data\security") -Filter "*.credential" -File)
  if ($credentials.Count -ne 4) { throw "Operational PostgreSQL credential count is not exact." }
  foreach ($credential in $credentials) {
    if ((Get-Content -LiteralPath $credential.FullName -Raw -Encoding utf8) -notmatch '^QHPG1\r?\nDPAPI_LOCAL_MACHINE\r?\n') {
      throw "Operational credential is not machine-scoped."
    }
  }

  $demoClient = $artifacts[1]
  $operationalClient = $artifacts[3]
  Copy-Item -LiteralPath $fixtures[0].configRoot -Destination $operationalClient.mutableRoot -Recurse
  Invoke-ClientLauncher -Artifact $operationalClient -Command start -ExpectFailure
  Wait-ClientRuntime -Artifact $operationalClient -Expected $false | Out-Null
  $crossFlavorLog = Join-Path $operationalClient.mutableRoot "logs\client-runtime.log"
  if (
    -not (Test-Path -LiteralPath $crossFlavorLog -PathType Leaf) -or
    (Get-Content -LiteralPath $crossFlavorLog -Raw -Encoding utf8) -notmatch 'PACKAGE_FLAVOR_MISMATCH'
  ) {
    throw "Operational client did not preserve the cross-flavor rejection code."
  }
  Remove-OwnedDirectory -Path $operationalClient.mutableRoot

  Copy-Item -LiteralPath $fixtures[0].configRoot -Destination $demoClient.mutableRoot -Recurse
  Copy-Item -LiteralPath $fixtures[1].configRoot -Destination $operationalClient.mutableRoot -Recurse
  Invoke-ClientLauncher -Artifact $demoClient -Command start
  Invoke-ClientLauncher -Artifact $operationalClient -Command start
  $demoRuntime = Wait-ClientRuntime -Artifact $demoClient
  $operationalRuntime = Wait-ClientRuntime -Artifact $operationalClient
  $demoProof = Get-ClientProcessProof -Artifact $demoClient -InstallLocation $installed[$demoClient.target].InstallLocation
  $operationalProof = Get-ClientProcessProof -Artifact $operationalClient -InstallLocation $installed[$operationalClient.target].InstallLocation
  if ($demoRuntime.deploymentFlavor -ne "DEMONSTRATION" -or $operationalRuntime.deploymentFlavor -ne "OPERATIONAL") {
    throw "QuickHack dual-client runtime flavors are invalid."
  }
  Invoke-ClientLauncher -Artifact $demoClient -Command stop
  Invoke-ClientLauncher -Artifact $operationalClient -Command stop
  Wait-ClientRuntime -Artifact $demoClient -Expected $false | Out-Null
  Wait-ClientRuntime -Artifact $operationalClient -Expected $false | Out-Null

  foreach ($artifact in @($demoClient, $operationalClient, $operationalServer)) {
    Remove-AppxPackage -Package $installed[$artifact.target].PackageFullName -Confirm:$false -ErrorAction Stop
    $installed.Remove($artifact.target)
    if (-not (Test-Path -LiteralPath $artifact.mutableRoot -PathType Container)) {
      throw "Normal uninstall did not preserve QuickHack mutable state: $($artifact.artifactKind)"
    }
    Invoke-OwnedPurge -Artifact $artifact
  }
  Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction Stop

  $sidecars = @($artifacts | ForEach-Object {
    Get-Content `
      -LiteralPath (Join-Path $distributionPath "$($_.target)\$($_.prefix)-msix-manifest-$version.json") `
      -Raw `
      -Encoding utf8 | ConvertFrom-Json
  })
  [ordered]@{
    schemaVersion = 1
    status = "PASS"
    osBuild = [Environment]::OSVersion.Version.Build
    sourceCommit = [string]$sidecars[0].sourceCommit
    packageCount = 4
    packageHashes = [ordered]@{
      demoServer = [string]$sidecars[0].packageSha256
      demoClient = [string]$sidecars[1].packageSha256
      operationalServer = [string]$sidecars[2].packageSha256
      operationalClient = [string]$sidecars[3].packageSha256
    }
    serverConflict = [string]$conflict.errorCode
    operationalServerReady = $true
    operationalCredentialCount = $credentials.Count
    dualClientPorts = @([int]$demoClient.port, [int]$operationalClient.port)
    clientArtifacts = @([string]$demoProof.artifactKind, [string]$operationalProof.artifactKind)
    crossFlavorRejected = $true
    normalUninstallPreservedState = $true
    explicitPurge = $true
  } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $resolvedEvidencePath -Encoding utf8
  $matrixPassed = $true
} finally {
  foreach ($artifact in $artifacts | Where-Object { $_.role -eq "client" }) {
    if (Get-AppxPackage -Name $artifact.identityName -ErrorAction SilentlyContinue) {
      try { Invoke-ClientLauncher -Artifact $artifact -Command stop } catch {}
    }
  }
  foreach ($fixture in $fixtures) {
    try { New-Item -ItemType File -Path $fixture.stopFile -Force | Out-Null } catch {}
  }
  foreach ($fixture in $fixtures) {
    try {
      if (-not $fixture.process.HasExited) {
        $fixture.process.WaitForExit(15000)
        if (-not $fixture.process.HasExited) { $fixture.process.Kill() }
      }
    } catch {}
  }
  foreach ($package in @($installed.Values)) {
    try { Remove-AppxPackage -Package $package.PackageFullName -Confirm:$false -ErrorAction Stop } catch {}
  }
  foreach ($artifact in $artifacts) {
    try { if (Test-Path -LiteralPath $artifact.mutableRoot) { Invoke-OwnedPurge -Artifact $artifact } } catch {}
  }
  try {
    Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction Stop
  } catch {}
  if ($guardian) {
    try { New-Item -ItemType File -Path (Join-Path $validationRoot "guardian.stop") -Force | Out-Null } catch {}
    try {
      if (-not $guardian.HasExited) {
        $guardian.WaitForExit(30000)
        if (-not $guardian.HasExited) { $guardian.Kill() }
      }
    } catch {}
  }
  try { if (Test-Path -LiteralPath $validationRoot) { Remove-OwnedDirectory -Path $validationRoot } } catch {}
}

$packageResidue = @($artifacts | Where-Object {
  Get-AppxPackage -Name $_.identityName -ErrorAction SilentlyContinue
}).Count
$serviceResidue = @($serviceNames | Where-Object {
  Get-Service -Name $_ -ErrorAction SilentlyContinue
}).Count
$stateResidue = @($artifacts | Where-Object { Test-Path -LiteralPath $_.mutableRoot }).Count
$firewallResidue = @(Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue).Count
$certificateResidue = 0
foreach ($storePath in @(
  "Cert:\LocalMachine\TrustedPeople",
  "Cert:\LocalMachine\Root",
  "Cert:\CurrentUser\TrustedPeople",
  "Cert:\CurrentUser\Root",
  "Cert:\CurrentUser\My"
)) {
  foreach ($thumbprint in $certificateThumbprints | Select-Object -Unique) {
    $certificateResidue += @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue |
      Where-Object Thumbprint -eq $thumbprint).Count
  }
}
$residueCount = $packageResidue + $serviceResidue + $stateResidue + $firewallResidue + $certificateResidue
if (-not $matrixPassed -or $residueCount -ne 0) {
  throw "QuickHack PR-07 native matrix failed or left residue count=$residueCount."
}

$evidence = Get-Content -LiteralPath $resolvedEvidencePath -Raw -Encoding utf8 | ConvertFrom-Json
$evidence | Add-Member -NotePropertyName residueCount -NotePropertyValue $residueCount
$evidence | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $resolvedEvidencePath -Encoding utf8
Write-Host "QuickHack PR-07 exact-four operational/conflict/dual-client native matrix passed."
