[CmdletBinding()]
param(
  [string]$SdkRoot = $env:QUICKHACK_WINDOWS_SDK_ROOT,
  [string]$NodePath = $env:QUICKHACK_NODE_EXECUTABLE,
  [string]$TestNodePath = "",
  [string]$StagingDir = "release\windows\demo-server",
  [switch]$RunNativeInstall,
  [switch]$ElevatedPhase,
  [ValidateSet("Prepare", "Resume", "Cleanup")]
  [string]$LifecyclePhase = "Prepare",
  [string]$PackageV1 = "",
  [string]$PackageV2 = "",
  [string]$CertificateV1 = "",
  [string]$CertificateV2 = "",
  [string]$EvidencePath = "",
  [string]$CheckpointPath = "",
  [switch]$AcknowledgeTestStatePurge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..\..\..")
)
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$validationRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $releaseRoot "windows\msix\pr05-demo-server-test")
)
$evidenceRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $releaseRoot "windows\msix\evidence")
)
$defaultEvidencePath = Join-Path $evidenceRoot "pr05-demo-server-msix.json"
$defaultCheckpointPath = Join-Path $evidenceRoot "pr05-demo-server-reboot-checkpoint.json"
$stagingPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $StagingDir))
$identityName = "QuickHack.Demonstration.Server"
$postgresqlServiceName = "QuickHackDemoPostgreSQL"
$consoleServiceName = "QuickHackDemoServerConsole"
$firewallRuleName = "QuickHack HTTPS Server (Local Subnet)"
$mutableRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $env:ProgramData "QuickHack\demonstration-server")
)
$runtimeConfigPath = Join-Path $mutableRoot "config\server-runtime.json"
$journalPath = Join-Path $mutableRoot "provisioning\server-provisioning-v1.json"
$readyMarkerPath = Join-Path $mutableRoot "provisioning\READY"
$leaderProofPath = Join-Path $PSScriptRoot "demo-server-leader-proof.mjs"

foreach ($boundedPath in @($validationRoot, $evidenceRoot)) {
  if (-not $boundedPath.StartsWith(
    $releaseRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe QuickHack PR-05 validation path: $boundedPath"
  }
}
if ($mutableRoot -ne [System.IO.Path]::GetFullPath(
  (Join-Path $env:ProgramData "QuickHack\demonstration-server")
)) {
  throw "Unexpected QuickHack demo-server mutable root."
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

function Quote-NativeArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.Contains('"')) { throw "QuickHack native argument contains a quote." }
  return '"' + $Value + '"'
}

function Get-CertificateThumbprint {
  param([Parameter(Mandatory = $true)][string]$CertificatePath)
  if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
    throw "QuickHack test certificate was not found: $CertificatePath"
  }
  return (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    $CertificatePath
  )).Thumbprint
}

function Add-TestCertificateTrust {
  param([Parameter(Mandatory = $true)][string[]]$CertificatePaths)
  $thumbprints = @()
  foreach ($certificatePath in $CertificatePaths) {
    $thumbprint = Get-CertificateThumbprint -CertificatePath $certificatePath
    & "$env:WINDIR\System32\certutil.exe" -f -addstore TrustedPeople $certificatePath | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "QuickHack test certificate trust failed."
    }
    $thumbprints += $thumbprint
  }
  return @($thumbprints | Select-Object -Unique)
}

function Remove-TestCertificateTrust {
  param([string[]]$Thumbprints = @())
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    "TrustedPeople",
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    foreach ($thumbprint in @($Thumbprints | Select-Object -Unique)) {
      foreach ($certificate in @($store.Certificates.Find(
        [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
        $thumbprint,
        $false
      ))) {
        $store.Remove($certificate)
      }
    }
  } finally {
    $store.Close()
  }
}

function Get-TestCertificateResidueCount {
  param([string[]]$Thumbprints = @())
  $count = 0
  foreach ($storePath in @(
    "Cert:\LocalMachine\TrustedPeople",
    "Cert:\LocalMachine\Root",
    "Cert:\CurrentUser\TrustedPeople",
    "Cert:\CurrentUser\Root",
    "Cert:\CurrentUser\My"
  )) {
    foreach ($thumbprint in @($Thumbprints | Select-Object -Unique)) {
      $count += @(
        Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue |
          Where-Object Thumbprint -eq $thumbprint
      ).Count
    }
  }
  return $count
}

function Wait-ServiceRunning {
  param([Parameter(Mandatory = $true)][string]$ServiceName, [int]$Seconds = 90)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq "Running") { return $service }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "QuickHack service did not reach Running: $ServiceName"
}

function Stop-PackagedServices {
  foreach ($serviceName in @($consoleServiceName, $postgresqlServiceName)) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne "Stopped") {
      Stop-Service -InputObject $service -Force
      $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(60))
    }
  }
}

function Wait-ProcessAbsent {
  param([Parameter(Mandatory = $true)][int]$ProcessId, [int]$Seconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "QuickHack packaged service left an orphan process: $ProcessId"
}

function Get-ServiceProcessProof {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceName,
    [Parameter(Mandatory = $true)][string]$InstallLocation,
    [Parameter(Mandatory = $true)][string]$HostRelativePath,
    [Parameter(Mandatory = $true)][string]$ChildRelativePath
  )
  Wait-ServiceRunning -ServiceName $ServiceName | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
    $hostProcess = if ([int]$service.ProcessId -gt 0) {
      Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$service.ProcessId)" -ErrorAction SilentlyContinue
    } else { $null }
    $childProcess = if ($hostProcess) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$service.ProcessId)" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    } else { $null }
    if ($hostProcess -and $childProcess) { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $hostProcess -or -not $childProcess) {
    throw "QuickHack packaged service process tree was not observed: $ServiceName"
  }
  $expectedHost = [System.IO.Path]::GetFullPath((Join-Path $InstallLocation $HostRelativePath))
  $expectedChild = [System.IO.Path]::GetFullPath((Join-Path $InstallLocation $ChildRelativePath))
  if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($hostProcess.ExecutablePath),
    $expectedHost,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "QuickHack service host escaped the package: $ServiceName"
  }
  if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($childProcess.ExecutablePath),
    $expectedChild,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "QuickHack service child escaped the package: $ServiceName"
  }
  return [pscustomobject]@{
    serviceName = $ServiceName
    serviceProcessId = [int]$service.ProcessId
    hostPath = [string]$hostProcess.ExecutablePath
    childProcessId = [int]$childProcess.ProcessId
    childPath = [string]$childProcess.ExecutablePath
  }
}

function Get-PackagedServiceProofs {
  param([Parameter(Mandatory = $true)][string]$InstallLocation)
  $postgresql = Get-ServiceProcessProof `
    -ServiceName $postgresqlServiceName `
    -InstallLocation $InstallLocation `
    -HostRelativePath "Services\QuickHackPostgresqlServiceHost.exe" `
    -ChildRelativePath "runtime\postgresql\bin\postgres.exe"
  $console = Get-ServiceProcessProof `
    -ServiceName $consoleServiceName `
    -InstallLocation $InstallLocation `
    -HostRelativePath "Services\QuickHackServerServiceHost.exe" `
    -ChildRelativePath "runtime\node\node.exe"
  Start-Sleep -Seconds 3
  if (
    (Get-Service -Name $postgresqlServiceName -ErrorAction Stop).Status -ne "Running" -or
    (Get-Service -Name $consoleServiceName -ErrorAction Stop).Status -ne "Running"
  ) {
    throw "QuickHack packaged services were not stable after startup."
  }
  return @($postgresql, $console)
}

function Invoke-ServerSetupSelfTest {
  param([Parameter(Mandatory = $true)][string]$InstallLocation)
  $setupPath = Join-Path $InstallLocation "QuickHack-Demo-Server-Setup.exe"
  $process = Start-Process -FilePath $setupPath -ArgumentList "--self-test" -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installed QuickHack demo-server Setup self-test failed."
  }
}

function Invoke-Provisioner {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("PROVISION", "ACKNOWLEDGE")][string]$Action,
    [Parameter(Mandatory = $true)][string]$InstallLocation,
    [string]$TransactionId = "",
    [int]$Generation = 0
  )
  $setup = Join-Path $InstallLocation "QuickHack-Demo-Server-Setup.exe"
  $arguments = @("--native-test-stdio")
  if ($Action -eq "PROVISION") {
    $arguments += "PROVISION"
  } else {
    if ($TransactionId -notmatch '^[0-9a-fA-F-]{36}$' -or $Generation -lt 1) {
      throw "QuickHack acknowledgement identity is invalid."
    }
    $arguments += @("ACKNOWLEDGE", $TransactionId, $Generation.ToString(
      [Globalization.CultureInfo]::InvariantCulture
    ))
  }
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $setup
  $startInfo.Arguments = ($arguments | ForEach-Object { Quote-NativeArgument -Value $_ }) -join " "
  $startInfo.WorkingDirectory = $InstallLocation
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["QUICKHACK_SERVER_SETUP_NATIVE_TEST_GATE"] = "PR05_MSIX_GATE"
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "QuickHack provisioner did not start." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if ($process.ExitCode -ne 0) {
    $errorCode = if ($stderr -match 'errorCode=([A-Z][A-Z0-9_]{2,95})') {
      $Matches[1]
    } else { "PROVISIONING_STEP_FAILED" }
    throw "QuickHack provisioner stopped with $errorCode."
  }
  $lines = @($stdout -split "`r?`n" | Where-Object { $_ })
  if ($lines.Count -lt 3 -or $lines[0] -ne "QUICKHACK_SERVER_SETUP_HANDOFF_V1") {
    throw "QuickHack provisioner returned an invalid handoff protocol."
  }
  $fields = @{}
  foreach ($line in $lines[1..($lines.Count - 1)]) {
    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { throw "QuickHack provisioner returned an invalid handoff field." }
    $name = $line.Substring(0, $separator)
    if ($fields.ContainsKey($name)) { throw "QuickHack provisioner duplicated a handoff field." }
    $fields[$name] = $line.Substring($separator + 1)
  }
  if (
    $fields.status -notin @("INITIAL_LEADER_PENDING_ACK", "READY") -or
    $fields.transactionId -notmatch '^[0-9a-fA-F-]{36}$'
  ) {
    throw "QuickHack provisioner returned an invalid handoff state."
  }
  return [pscustomobject]@{
    status = [string]$fields.status
    transactionId = [string]$fields.transactionId
    userId = if ($fields.ContainsKey("userId")) { [int]$fields["userId"] } else { 0 }
    generation = if ($fields.ContainsKey("generation")) { [int]$fields["generation"] } else { 0 }
    username = if ($fields.ContainsKey("username")) { [string]$fields["username"] } else { "" }
    temporaryPassword = if ($fields.ContainsKey("temporaryPassword")) {
      [string]$fields["temporaryPassword"]
    } else { "" }
  }
}

function Invoke-LeaderProof {
  param(
    [Parameter(Mandatory = $true)][string]$InstallLocation,
    [Parameter(Mandatory = $true)][string]$OldPassword,
    [Parameter(Mandatory = $true)][string]$NewPassword,
    [Parameter(Mandatory = $true)][int]$ExpectedUserId,
    [Parameter(Mandatory = $true)][int]$ExpectedGeneration
  )
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  if (-not $TestNodePath -or -not (Test-Path -LiteralPath $TestNodePath -PathType Leaf)) {
    throw "QuickHack leader proof external test Node executable was not found."
  }
  $startInfo.FileName = $TestNodePath
  $startInfo.Arguments = @(
    (Quote-NativeArgument -Value $leaderProofPath),
    "--runtime-config",
    (Quote-NativeArgument -Value $runtimeConfigPath)
  ) -join " "
  $startInfo.WorkingDirectory = $repositoryRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["QUICKHACK_WINDOWS_SECRET_SCOPE"] = "LOCAL_MACHINE"
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "QuickHack leader proof did not start." }
  $payload = [ordered]@{
    oldPassword = $OldPassword
    newPassword = $NewPassword
    expectedUserId = $ExpectedUserId
    expectedGeneration = $ExpectedGeneration
  } | ConvertTo-Json -Compress
  $process.StandardInput.Write($payload)
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if ($process.ExitCode -ne 0 -or $stderr) {
    throw "QuickHack leader credential proof failed."
  }
  return $stdout | ConvertFrom-Json
}

function Assert-MachineScopeSecrets {
  $credentialRoot = Join-Path $mutableRoot "data\security"
  $credentials = @(Get-ChildItem -LiteralPath $credentialRoot -Filter "*.credential" -File)
  if ($credentials.Count -lt 4) {
    throw "QuickHack packaged PostgreSQL credentials are incomplete."
  }
  foreach ($credential in $credentials) {
    $source = Get-Content -LiteralPath $credential.FullName -Raw -Encoding utf8
    if ($source -notmatch '^QH[A-Z0-9]+\r?\nDPAPI_LOCAL_MACHINE\r?\n') {
      throw "QuickHack packaged credential did not use machine-scope DPAPI."
    }
  }
}

function Assert-MutableRootAcl {
  $acl = Get-Acl -LiteralPath $mutableRoot
  if (-not $acl.AreAccessRulesProtected) {
    throw "QuickHack demo-server mutable root still inherits ACL entries."
  }
  $expected = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    "S-1-5-18",
    "S-1-5-20",
    "S-1-5-32-544"
  ) | Select-Object -Unique
  $observed = @($acl.Access | ForEach-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  } | Select-Object -Unique)
  if (@(Compare-Object -ReferenceObject $expected -DifferenceObject $observed).Count -ne 0) {
    throw "QuickHack demo-server mutable root ACL principals are not exact."
  }
}

function Assert-NoSecretPersistence {
  param(
    [Parameter(Mandatory = $true)][string]$FirstPassword,
    [Parameter(Mandatory = $true)][string]$SecondPassword
  )
  $journal = Get-Content -LiteralPath $journalPath -Raw -Encoding utf8
  if ($journal -match '(?i)temporaryPassword|passwordHash|secret') {
    throw "QuickHack provisioning journal contains a secret-bearing field."
  }
  foreach ($root in @("config", "logs", "provisioning", "data\security")) {
    $directory = Join-Path $mutableRoot $root
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse) {
      if ($file.Length -gt 1048576) { continue }
      $source = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 -ErrorAction SilentlyContinue
      if ($source -and ($source.Contains($FirstPassword) -or $source.Contains($SecondPassword))) {
        throw "QuickHack persisted an initial LEADER password outside the protected handoff."
      }
    }
  }
}

function Assert-FirewallRule {
  param([Parameter(Mandatory = $true)][string]$InstallLocation)
  $rules = @(Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue)
  if ($rules.Count -ne 1) { throw "QuickHack firewall rule count is invalid." }
  $application = $rules[0] | Get-NetFirewallApplicationFilter
  $port = $rules[0] | Get-NetFirewallPortFilter
  $address = $rules[0] | Get-NetFirewallAddressFilter
  $expectedNode = Join-Path $InstallLocation "runtime\node\node.exe"
  if (
    $rules[0].Direction -ne "Inbound" -or
    $rules[0].Action -ne "Allow" -or
    $application.Program -ne $expectedNode -or
    $port.Protocol -ne "TCP" -or
    $port.LocalPort -ne "3443" -or
    @($address.RemoteAddress) -notcontains "LocalSubnet"
  ) {
    throw "QuickHack firewall rule is not bounded to package Node/local subnet HTTPS."
  }
}

function Invoke-ServerLauncherStatus {
  $launcher = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\QuickHack-Demo-Server.exe"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "QuickHack demo-server app execution alias was not registered."
    }
    Start-Sleep -Milliseconds 250
  }
  $process = Start-Process -FilePath $launcher -ArgumentList @("status", "--quiet") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "QuickHack packaged server launcher status failed." }
}

function Invoke-TestOwnedPurge {
  if (-not (Test-Path -LiteralPath $mutableRoot -PathType Container)) { return }
  & (Join-Path $repositoryRoot "packaging\windows\purge-installation.ps1") `
    -ArtifactKind DEMONSTRATION_SERVER `
    -ConfirmArtifactKind DEMONSTRATION_SERVER `
    -ConfirmPackageIdentity "QuickHack.Demonstration.Server" `
    -VerifiedBackup $false `
    -AcknowledgeNoRecovery $true `
    -MutableRoot $mutableRoot | Out-Null
  if (Test-Path -LiteralPath $mutableRoot) {
    throw "QuickHack test-owned demo-server state purge failed."
  }
}

function Remove-ExactTestState {
  param([string[]]$Thumbprints = @())
  Stop-PackagedServices
  $installed = Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue
  if ($installed) {
    Remove-AppxPackage -Package $installed.PackageFullName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Invoke-TestOwnedPurge
  Remove-TestCertificateTrust -Thumbprints $Thumbprints
}

function Assert-CleanInitialState {
  if (Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue) {
    throw "QuickHack demo-server MSIX is already installed."
  }
  foreach ($serviceName in @($postgresqlServiceName, $consoleServiceName)) {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
      throw "QuickHack demo-server service already exists: $serviceName"
    }
  }
  if (Test-Path -LiteralPath $mutableRoot) {
    throw "QuickHack demo-server mutable state already exists; refusing to overwrite it."
  }
  if (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue) {
    throw "QuickHack demo-server firewall rule already exists."
  }
}

function Invoke-PreparePhase {
  if (-not (Test-IsAdministrator)) {
    throw "QuickHack demo-server native Prepare phase requires an administrator token."
  }
  Assert-CleanInitialState
  $thumbprints = @()
  $preserveForReboot = $false
  $phaseFailure = $null
  $cleanupFailure = $null
  try {
    $thumbprints = Add-TestCertificateTrust -CertificatePaths @($CertificateV1, $CertificateV2)
    Add-AppxPackage -Path $PackageV1 -ForceApplicationShutdown -ErrorAction Stop
    $installedV1 = Get-AppxPackage -Name $identityName -ErrorAction Stop
    if ($installedV1.Version.ToString() -ne "1.0.0.51") {
      throw "Unexpected QuickHack demo-server initial MSIX version."
    }
    Invoke-ServerSetupSelfTest -InstallLocation $installedV1.InstallLocation

    $first = Invoke-Provisioner -Action PROVISION -InstallLocation $installedV1.InstallLocation
    if (
      $first.status -ne "INITIAL_LEADER_PENDING_ACK" -or
      $first.username -ne "admin" -or
      $first.generation -ne 1 -or
      $first.temporaryPassword -notmatch '^[A-Za-z0-9_-]{32,128}$' -or
      (Test-Path -LiteralPath $readyMarkerPath)
    ) {
      throw "QuickHack first initial-LEADER handoff is invalid."
    }
    $second = Invoke-Provisioner -Action PROVISION -InstallLocation $installedV1.InstallLocation
    if (
      $second.status -ne "INITIAL_LEADER_PENDING_ACK" -or
      $second.transactionId -ne $first.transactionId -or
      $second.userId -ne $first.userId -or
      $second.generation -ne 2 -or
      $second.temporaryPassword -eq $first.temporaryPassword
    ) {
      throw "QuickHack unacknowledged initial-LEADER reissue is invalid."
    }
    $leaderProof = Invoke-LeaderProof `
      -InstallLocation $installedV1.InstallLocation `
      -OldPassword $first.temporaryPassword `
      -NewPassword $second.temporaryPassword `
      -ExpectedUserId $second.userId `
      -ExpectedGeneration $second.generation
    if (
      $leaderProof.userCount -ne 1 -or
      $leaderProof.userId -ne $second.userId -or
      $leaderProof.username -ne "admin" -or
      $leaderProof.role -ne "LEADER" -or
      $leaderProof.mustChangePassword -ne 1 -or
      $leaderProof.isActive -ne 1 -or
      $leaderProof.credentialRevision -ne 1 -or
      $leaderProof.oldValid -ne $false -or
      $leaderProof.newValid -ne $true
    ) {
      throw "QuickHack initial-LEADER old/new password proof failed."
    }
    Assert-NoSecretPersistence `
      -FirstPassword $first.temporaryPassword `
      -SecondPassword $second.temporaryPassword
    $acknowledged = Invoke-Provisioner `
      -Action ACKNOWLEDGE `
      -InstallLocation $installedV1.InstallLocation `
      -TransactionId $second.transactionId `
      -Generation $second.generation
    if (
      $acknowledged.status -ne "READY" -or
      $acknowledged.temporaryPassword -or
      -not (Test-Path -LiteralPath $readyMarkerPath -PathType Leaf)
    ) {
      throw "QuickHack initial-LEADER acknowledgement did not reach READY."
    }
    $idempotent = Invoke-Provisioner -Action PROVISION -InstallLocation $installedV1.InstallLocation
    if ($idempotent.status -ne "READY" -or $idempotent.temporaryPassword) {
      throw "QuickHack READY provisioning retry was not idempotent."
    }
    Assert-MachineScopeSecrets
    Assert-MutableRootAcl
    Assert-FirewallRule -InstallLocation $installedV1.InstallLocation
    $processesV1 = Get-PackagedServiceProofs -InstallLocation $installedV1.InstallLocation
    Invoke-ServerLauncherStatus

    Add-AppxPackage -Path $PackageV2 -ForceApplicationShutdown -ErrorAction Stop
    $installedV2 = Get-AppxPackage -Name $identityName -ErrorAction Stop
    if ($installedV2.Version.ToString() -ne "1.0.0.52") {
      throw "QuickHack demo-server update did not select the newer MSIX."
    }
    $updatedReady = Invoke-Provisioner -Action PROVISION -InstallLocation $installedV2.InstallLocation
    if ($updatedReady.status -ne "READY" -or $updatedReady.temporaryPassword) {
      throw "QuickHack demo-server update did not preserve READY state."
    }
    $processesV2 = Get-PackagedServiceProofs -InstallLocation $installedV2.InstallLocation
    Assert-FirewallRule -InstallLocation $installedV2.InstallLocation
    foreach ($processProof in $processesV1) {
      Wait-ProcessAbsent -ProcessId $processProof.serviceProcessId
      Wait-ProcessAbsent -ProcessId $processProof.childProcessId
    }

    $configHash = (Get-FileHash -LiteralPath $runtimeConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $journalHash = (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
    $checkpoint = [ordered]@{
      schemaVersion = 1
      status = "REBOOT_REQUIRED"
      sourceCommit = $sourceCommit
      packageIdentity = $identityName
      expectedVersion = "1.0.0.52"
      packageV2 = $PackageV2
      certificateV1 = $CertificateV1
      certificateV2 = $CertificateV2
      certificateThumbprints = $thumbprints
      configSha256 = $configHash
      journalSha256 = $journalHash
      preRebootProcesses = $processesV2
      leader = [ordered]@{
        sameUserReissued = $true
        oldPasswordInvalidated = $true
        newPasswordValidated = $true
        acknowledgedGeneration = $second.generation
      }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $CheckpointPath) -Force | Out-Null
    $checkpoint | ConvertTo-Json -Depth 10 |
      Set-Content -LiteralPath $CheckpointPath -Encoding utf8
    $checkpoint | ConvertTo-Json -Depth 10 |
      Set-Content -LiteralPath $EvidencePath -Encoding utf8
    $preserveForReboot = $true
    Write-Host "QuickHack demo-server Prepare gate passed; reboot and run Resume."
  } catch {
    $phaseFailure = $_
  } finally {
    if (-not $preserveForReboot) {
      try {
        Remove-ExactTestState -Thumbprints $thumbprints
      } catch {
        $cleanupFailure = $_
      }
    }
  }
  if ($phaseFailure -and $cleanupFailure) {
    throw "QuickHack demo-server Prepare failed: $($phaseFailure.Exception.Message) Cleanup also failed: $($cleanupFailure.Exception.Message)"
  }
  if ($phaseFailure) { throw $phaseFailure }
  if ($cleanupFailure) { throw $cleanupFailure }
}

function Invoke-ResumePhase {
  if (-not (Test-IsAdministrator)) {
    throw "QuickHack demo-server native Resume phase requires an administrator token."
  }
  if (-not (Test-Path -LiteralPath $CheckpointPath -PathType Leaf)) {
    throw "QuickHack demo-server reboot checkpoint is missing."
  }
  $checkpoint = Get-Content -LiteralPath $CheckpointPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    $checkpoint.schemaVersion -ne 1 -or
    $checkpoint.status -ne "REBOOT_REQUIRED" -or
    $checkpoint.packageIdentity -ne $identityName -or
    $checkpoint.expectedVersion -ne "1.0.0.52"
  ) {
    throw "QuickHack demo-server reboot checkpoint is invalid."
  }
  $thumbprints = @($checkpoint.certificateThumbprints)
  try {
    $installed = Get-AppxPackage -Name $identityName -ErrorAction Stop
    if ($installed.Version.ToString() -ne $checkpoint.expectedVersion) {
      throw "QuickHack demo-server package version changed across reboot."
    }
    if (
      (Get-FileHash -LiteralPath $runtimeConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $checkpoint.configSha256 -or
      (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $checkpoint.journalSha256
    ) {
      throw "QuickHack demo-server immutable state changed across reboot."
    }
    $postRebootProcesses = Get-PackagedServiceProofs -InstallLocation $installed.InstallLocation
    Assert-FirewallRule -InstallLocation $installed.InstallLocation
    Invoke-ServerLauncherStatus
    $preservedConfigHash = $checkpoint.configSha256
    $preservedJournalHash = $checkpoint.journalSha256
    Stop-PackagedServices
    foreach ($processProof in $postRebootProcesses) {
      Wait-ProcessAbsent -ProcessId $processProof.serviceProcessId
      Wait-ProcessAbsent -ProcessId $processProof.childProcessId
    }
    Remove-AppxPackage -Package $installed.PackageFullName -Confirm:$false -ErrorAction Stop
    if (Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue) {
      throw "QuickHack demo-server package remained after normal uninstall."
    }
    foreach ($serviceName in @($postgresqlServiceName, $consoleServiceName)) {
      if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        throw "QuickHack demo-server service remained after normal uninstall: $serviceName"
      }
    }
    if (
      -not (Test-Path -LiteralPath $mutableRoot -PathType Container) -or
      (Get-FileHash -LiteralPath $runtimeConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $preservedConfigHash -or
      (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $preservedJournalHash
    ) {
      throw "QuickHack normal uninstall did not preserve demo-server state."
    }
    Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction Stop
    Invoke-TestOwnedPurge
    Remove-TestCertificateTrust -Thumbprints $thumbprints
    Remove-Item -LiteralPath $CheckpointPath -Force
    $certificateResidueCount = Get-TestCertificateResidueCount -Thumbprints $thumbprints
    if (
      $certificateResidueCount -ne 0 -or
      (Test-Path -LiteralPath $mutableRoot) -or
      (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue)
    ) {
      throw "QuickHack demo-server lifecycle cleanup left test residue."
    }
    [ordered]@{
      schemaVersion = 1
      status = "PASS"
      sourceCommit = [string]$checkpoint.sourceCommit
      osBuild = [Environment]::OSVersion.Version.Build
      packageIdentity = $identityName
      initialVersion = "1.0.0.51"
      updatedVersion = "1.0.0.52"
      initialLeader = $checkpoint.leader
      packageOwnedSecrets = "DPAPI_LOCAL_MACHINE"
      updateVerified = $true
      rebootVerified = $true
      postRebootProcesses = $postRebootProcesses
      normalUninstallPreservedState = $true
      packageRemoved = $true
      serviceResidueCount = 0
      processResidueCount = 0
      firewallResidueCount = 0
      certificateResidueCount = $certificateResidueCount
      explicitTestStatePurge = $true
      setupElevation = [ordered]@{
        executableManifest = "requireAdministrator"
        elevatedSelfTest = "PASS"
        interactiveUacPrompt = "NOT_RUN_HEADLESS_AUTOMATION"
      }
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
    Write-Host "QuickHack demo-server clean/reissue/update/reboot/uninstall gate passed."
  } catch {
    Remove-ExactTestState -Thumbprints $thumbprints
    throw
  }
}

function Invoke-CleanupPhase {
  if (-not (Test-IsAdministrator)) {
    throw "QuickHack demo-server Cleanup phase requires an administrator token."
  }
  if (-not $AcknowledgeTestStatePurge) {
    throw "QuickHack demo-server Cleanup requires -AcknowledgeTestStatePurge."
  }
  $thumbprints = @()
  foreach ($certificatePath in @($CertificateV1, $CertificateV2)) {
    if ($certificatePath -and (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
      $thumbprints += Get-CertificateThumbprint -CertificatePath $certificatePath
    }
  }
  if (Test-Path -LiteralPath $CheckpointPath -PathType Leaf) {
    $checkpoint = Get-Content -LiteralPath $CheckpointPath -Raw -Encoding utf8 | ConvertFrom-Json
    $thumbprints += @($checkpoint.certificateThumbprints)
  }
  Remove-ExactTestState -Thumbprints @($thumbprints | Select-Object -Unique)
  Remove-Item -LiteralPath $CheckpointPath -Force -ErrorAction SilentlyContinue
  Write-Host "QuickHack demo-server exact test cleanup completed."
}

if (-not $EvidencePath) { $EvidencePath = $defaultEvidencePath }
if (-not $CheckpointPath) { $CheckpointPath = $defaultCheckpointPath }
foreach ($outputPath in @($EvidencePath, $CheckpointPath)) {
  $resolvedOutput = [System.IO.Path]::GetFullPath($outputPath)
  if (-not $resolvedOutput.StartsWith(
    $evidenceRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "QuickHack PR-05 evidence path escaped its owned root: $resolvedOutput"
  }
}

if ($ElevatedPhase) {
  foreach ($requiredPath in @($EvidencePath, $CheckpointPath)) {
    if (-not $requiredPath) { throw "QuickHack elevated phase is missing an output path." }
  }
  if ($LifecyclePhase -eq "Prepare") {
    foreach ($requiredPath in @(
      $PackageV1, $PackageV2, $CertificateV1, $CertificateV2, $TestNodePath
    )) {
      if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "QuickHack elevated Prepare input was not found: $requiredPath"
      }
    }
    Invoke-PreparePhase
  } elseif ($LifecyclePhase -eq "Resume") {
    Invoke-ResumePhase
  } else {
    Invoke-CleanupPhase
  }
  exit 0
}

if (-not $SdkRoot) { throw "Pass -SdkRoot or set QUICKHACK_WINDOWS_SDK_ROOT." }
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction Stop |
    Select-Object -ExpandProperty Source -First 1
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "QuickHack PR-05 build Node executable was not found: $NodePath"
}
if (-not (Test-Path -LiteralPath $stagingPath -PathType Container)) {
  throw "QuickHack demo-server staging package was not found: $stagingPath"
}
foreach ($requiredRelativePath in @(
  "QuickHack-Demo-Server.exe",
  "QuickHack-Demo-Server-Setup.exe",
  "quickhack-package.json",
  "runtime\node\node.exe",
  "runtime\postgresql\bin\postgres.exe",
  "Services\QuickHackPostgresqlServiceHost.exe",
  "Services\QuickHackServerServiceHost.exe",
  "tools\server-provisioning-cli.mjs"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $stagingPath $requiredRelativePath) -PathType Leaf)) {
    throw "QuickHack demo-server staging is incomplete: $requiredRelativePath"
  }
}

if (Test-Path -LiteralPath $validationRoot) {
  Remove-ValidationDirectory -Path $validationRoot
}
New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null
$distributions = @()
foreach ($revision in @(51, 52)) {
  $outputRelative = "release\windows\msix\pr05-demo-server-test\distribution-$revision"
  $certificateRelative = "$outputRelative\QuickHack-demo-server-$revision.cer"
  & (Join-Path $repositoryRoot "packaging\build-msix.ps1") `
    -Target demo-server `
    -Version "1.0.0-pr05.$revision" `
    -SourceDir $StagingDir `
    -OutputDir $outputRelative `
    -SigningMode TestCertificate `
    -SdkRoot $SdkRoot `
    -NodePath $NodePath `
    -IncludeServices `
    -IncludeServerSetup `
    -TestCertificateCerPath $certificateRelative
  $distributions += [pscustomobject]@{
    package = Join-Path $repositoryRoot "$outputRelative\QuickHack-Demo-Server-1.0.0-pr05.$revision.msix"
    certificate = Join-Path $repositoryRoot $certificateRelative
  }
}

New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
if ($RunNativeInstall) {
  $PackageV1 = $distributions[0].package
  $PackageV2 = $distributions[1].package
  $CertificateV1 = $distributions[0].certificate
  $CertificateV2 = $distributions[1].certificate
  if (Test-IsAdministrator) {
    Invoke-PreparePhase
  } else {
    $arguments = @(
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", $PSCommandPath, "-ElevatedPhase", "-LifecyclePhase", "Prepare",
      "-PackageV1", $PackageV1, "-PackageV2", $PackageV2,
      "-CertificateV1", $CertificateV1, "-CertificateV2", $CertificateV2,
      "-EvidencePath", $EvidencePath, "-CheckpointPath", $CheckpointPath,
      "-TestNodePath", $NodePath
    )
    $process = Start-Process `
      -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
      -ArgumentList $arguments `
      -Verb RunAs `
      -Wait `
      -PassThru
    if ($process.ExitCode -ne 0) {
      throw "Elevated QuickHack demo-server Prepare phase failed with exit code $($process.ExitCode)."
    }
  }
} else {
  [ordered]@{
    schemaVersion = 1
    status = "NOT_RUN"
    reason = "Run the exact elevated Prepare phase, reboot, then elevated Resume phase."
    packageV1 = $distributions[0].package
    packageV2 = $distributions[1].package
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
  Write-Host "QuickHack demo-server source/build gate passed; native lifecycle is NOT_RUN."
}
