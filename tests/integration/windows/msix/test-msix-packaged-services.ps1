[CmdletBinding()]
param(
  [string]$SdkRoot = $env:QUICKHACK_WINDOWS_SDK_ROOT,
  [string]$NodePath = $env:QUICKHACK_NODE_EXECUTABLE,
  [switch]$RunNativeInstall,
  [switch]$ElevatedPhase,
  [string]$PackageV1 = "",
  [string]$PackageV2 = "",
  [string]$CertificateV1 = "",
  [string]$CertificateV2 = "",
  [string]$EvidencePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..\..\..")
)
$validationRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot "release\windows\msix\pr03-packaged-service-test")
)
$evidenceRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot "release\windows\msix\evidence")
)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
foreach ($pathToValidate in @($validationRoot, $evidenceRoot)) {
  if (-not $pathToValidate.StartsWith(
    $allowedRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Unsafe QuickHack MSIX service test path: $pathToValidate"
  }
}

$previewIdentity = "QuickHack.Preview.Demonstration.Server"
$postgresqlServiceName = "QuickHackPreviewDemoPostgreSQL"
$consoleServiceName = "QuickHackPreviewDemoServerConsole"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Wait-ServiceState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ServiceName,
    [Parameter(Mandatory = $true)]
    [System.ServiceProcess.ServiceControllerStatus]$Status,
    [int]$Seconds = 60
  )
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne $Status) {
    if ($Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
      Start-Service -InputObject $service
    } elseif ($Status -eq [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
      Stop-Service -InputObject $service -Force
    }
    $service.WaitForStatus($Status, [TimeSpan]::FromSeconds($Seconds))
  }
  return Get-Service -Name $ServiceName -ErrorAction Stop
}

function Get-ServiceProcessProof {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ServiceName,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedHostSuffix,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedChildSuffix
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
    $hostProcess = if ($service.ProcessId -gt 0) {
      Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)" -ErrorAction SilentlyContinue
    } else { $null }
    $childProcess = if ($hostProcess) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$($service.ProcessId)" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    } else { $null }
    if ($hostProcess -and $childProcess) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $hostProcess -or -not $childProcess) {
    throw "QuickHack packaged service process tree was not observed: $ServiceName"
  }
  if (-not $hostProcess.ExecutablePath.EndsWith($ExpectedHostSuffix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "QuickHack packaged service host escaped the package: $($hostProcess.ExecutablePath)"
  }
  if (-not $childProcess.ExecutablePath.EndsWith($ExpectedChildSuffix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "QuickHack packaged service child escaped the package: $($childProcess.ExecutablePath)"
  }
  return [pscustomobject]@{
    serviceName = $ServiceName
    serviceProcessId = [int]$service.ProcessId
    hostPath = [string]$hostProcess.ExecutablePath
    childProcessId = [int]$childProcess.ProcessId
    childPath = [string]$childProcess.ExecutablePath
  }
}

function Wait-ProcessAbsent {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [int]$Seconds = 20
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "QuickHack packaged service left an orphan child process: $ProcessId"
}

function Invoke-ElevatedNativePhase {
  if (-not (Test-IsAdministrator)) {
    throw "The QuickHack packaged-service native phase requires an administrator token."
  }
  foreach ($requiredPath in @($PackageV1, $PackageV2, $CertificateV1, $CertificateV2, $EvidencePath)) {
    if (-not $requiredPath) { throw "The elevated MSIX service phase is missing an input path." }
  }

  $certificates = @()
  $installedPackage = $null
  try {
    foreach ($certificatePath in @($CertificateV1, $CertificateV2)) {
      $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
      & "$env:WINDIR\System32\certutil.exe" -f -addstore TrustedPeople $certificatePath | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Failed to trust QuickHack preview signing certificate." }
      $certificates += $certificate.Thumbprint
    }

    Add-AppxPackage -Path $PackageV1 -ForceApplicationShutdown -ErrorAction Stop
    $installedPackage = Get-AppxPackage -Name $previewIdentity -ErrorAction Stop
    if ($installedPackage.Version.ToString() -ne "1.0.0.31") {
      throw "Unexpected QuickHack preview package version after first install."
    }

    Wait-ServiceState -ServiceName $postgresqlServiceName -Status Running | Out-Null
    Wait-ServiceState -ServiceName $consoleServiceName -Status Running | Out-Null
    $firstPostgresql = Get-ServiceProcessProof `
      -ServiceName $postgresqlServiceName `
      -ExpectedHostSuffix "Services\QuickHackPostgresqlServiceHost.exe" `
      -ExpectedChildSuffix "runtime\postgresql\bin\postgres.exe"
    $firstConsole = Get-ServiceProcessProof `
      -ServiceName $consoleServiceName `
      -ExpectedHostSuffix "Services\QuickHackServerServiceHost.exe" `
      -ExpectedChildSuffix "runtime\node\node.exe"

    Wait-ServiceState -ServiceName $consoleServiceName -Status Stopped | Out-Null
    Wait-ServiceState -ServiceName $postgresqlServiceName -Status Stopped | Out-Null
    Wait-ProcessAbsent -ProcessId $firstPostgresql.childProcessId
    Wait-ProcessAbsent -ProcessId $firstConsole.childProcessId

    Add-AppxPackage -Path $PackageV2 -ForceApplicationShutdown -ErrorAction Stop
    $installedPackage = Get-AppxPackage -Name $previewIdentity -ErrorAction Stop
    if ($installedPackage.Version.ToString() -ne "1.0.0.32") {
      throw "QuickHack preview package update did not select the newer version."
    }
    Wait-ServiceState -ServiceName $postgresqlServiceName -Status Running | Out-Null
    Wait-ServiceState -ServiceName $consoleServiceName -Status Running | Out-Null
    $updatedPostgresql = Get-ServiceProcessProof `
      -ServiceName $postgresqlServiceName `
      -ExpectedHostSuffix "Services\QuickHackPostgresqlServiceHost.exe" `
      -ExpectedChildSuffix "runtime\postgresql\bin\postgres.exe"
    $updatedConsole = Get-ServiceProcessProof `
      -ServiceName $consoleServiceName `
      -ExpectedHostSuffix "Services\QuickHackServerServiceHost.exe" `
      -ExpectedChildSuffix "runtime\node\node.exe"

    New-Item -ItemType Directory -Path (Split-Path -Parent $EvidencePath) -Force | Out-Null
    [ordered]@{
      schemaVersion = 1
      status = "PASS"
      osBuild = [Environment]::OSVersion.Version.Build
      packageIdentity = $previewIdentity
      installedVersion = $installedPackage.Version.ToString()
      services = @($updatedPostgresql, $updatedConsole)
      initialChildProcessIds = @($firstPostgresql.childProcessId, $firstConsole.childProcessId)
      orphanProcessCountAfterStop = 0
      updateVerified = $true
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
  } finally {
    foreach ($serviceName in @($consoleServiceName, $postgresqlServiceName)) {
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    }
    $installed = Get-AppxPackage -Name $previewIdentity -ErrorAction SilentlyContinue
    if ($installed) {
      Remove-AppxPackage -Package $installed.PackageFullName -Confirm:$false -ErrorAction SilentlyContinue
    }
    foreach ($thumbprint in $certificates | Select-Object -Unique) {
      & "$env:WINDIR\System32\certutil.exe" -delstore TrustedPeople $thumbprint | Out-Null
    }
  }
}

if ($ElevatedPhase) {
  Invoke-ElevatedNativePhase
  exit 0
}

if (-not $SdkRoot) {
  throw "Pass -SdkRoot or set QUICKHACK_WINDOWS_SDK_ROOT."
}
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction Stop |
    Select-Object -ExpandProperty Source -First 1
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "QuickHack preview Node executable was not found: $NodePath"
}

if (Test-Path -LiteralPath $validationRoot) {
  Remove-Item -LiteralPath $validationRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null

try {
  $stagingPath = Join-Path $validationRoot "staging"
  $hostBuildPath = Join-Path $validationRoot "host-build"
  $launcherBuildPath = Join-Path $validationRoot "launchers"
  & (Join-Path $repositoryRoot "packaging\build-windows-launchers.ps1") `
    -OutputDir "release\windows\msix\pr03-packaged-service-test\launchers"
  & (Join-Path $repositoryRoot "packaging\build-msix-service-hosts.ps1") `
    -Target demo-server `
    -OutputDir "release\windows\msix\pr03-packaged-service-test\host-build" `
    -Preview

  New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
  Copy-Item `
    -LiteralPath (Join-Path $launcherBuildPath "QuickHack-Demo-Server.exe") `
    -Destination (Join-Path $stagingPath "QuickHack-Demo-Server.exe")
  Copy-Item `
    -LiteralPath (Join-Path $hostBuildPath "Services") `
    -Destination (Join-Path $stagingPath "Services") `
    -Recurse
  $nodeTarget = Join-Path $stagingPath "runtime\node\node.exe"
  New-Item -ItemType Directory -Path (Split-Path -Parent $nodeTarget) -Force | Out-Null
  Copy-Item -LiteralPath $NodePath -Destination $nodeTarget
  Set-Content -LiteralPath (Join-Path (Split-Path -Parent $nodeTarget) "LICENSE") -Value "MSIX service preview fixture" -Encoding ascii
  Set-Content -LiteralPath (Join-Path (Split-Path -Parent $nodeTarget) "quickhack-node-runtime.json") -Value '{"schemaVersion":1,"fixture":true}' -Encoding ascii
  $postgresTarget = Join-Path $stagingPath "runtime\postgresql\bin\postgres.exe"
  New-Item -ItemType Directory -Path (Split-Path -Parent $postgresTarget) -Force | Out-Null
  Copy-Item `
    -LiteralPath (Join-Path $hostBuildPath "QuickHackPreviewPostgresqlChild.exe") `
    -Destination $postgresTarget
  foreach ($directoryName in @("lib", "share")) {
    $directory = Join-Path $stagingPath "runtime\postgresql\$directoryName"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $directory "preview.txt") -Value "fixture" -Encoding ascii
  }

  foreach ($hostName in @("QuickHackPostgresqlServiceHost.exe", "QuickHackServerServiceHost.exe")) {
    $selfTestOutput = & (Join-Path $stagingPath "Services\$hostName") --self-test
    if ($LASTEXITCODE -ne 0 -or $selfTestOutput -notmatch "state=READY") {
      throw "QuickHack packaged service host self-test failed: $hostName"
    }
  }

  $distributions = @()
  foreach ($revision in @(31, 32)) {
    $outputRelative = "release\windows\msix\pr03-packaged-service-test\distribution-$revision"
    $certificateRelative = "$outputRelative\QuickHack-preview-$revision.cer"
    & (Join-Path $repositoryRoot "packaging\build-msix.ps1") `
      -Target demo-server `
      -Version "1.0.0-preview.$revision" `
      -SourceDir "release\windows\msix\pr03-packaged-service-test\staging" `
      -OutputDir $outputRelative `
      -SigningMode TestCertificate `
      -SdkRoot $SdkRoot `
      -NodePath $NodePath `
      -Preview `
      -IncludeServices `
      -TestCertificateCerPath $certificateRelative
    $distributions += [pscustomobject]@{
      Package = Join-Path $repositoryRoot "$outputRelative\QuickHack-Preview-Demo-Server-1.0.0-preview.$revision.msix"
      Certificate = Join-Path $repositoryRoot $certificateRelative
    }
  }

  New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
  $nativeEvidencePath = Join-Path $evidenceRoot "pr03-packaged-services.json"
  if ($RunNativeInstall) {
    if (Test-IsAdministrator) {
      $PackageV1 = $distributions[0].Package
      $PackageV2 = $distributions[1].Package
      $CertificateV1 = $distributions[0].Certificate
      $CertificateV2 = $distributions[1].Certificate
      $EvidencePath = $nativeEvidencePath
      Invoke-ElevatedNativePhase
    } else {
      $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-ElevatedPhase",
        "-PackageV1", $distributions[0].Package,
        "-PackageV2", $distributions[1].Package,
        "-CertificateV1", $distributions[0].Certificate,
        "-CertificateV2", $distributions[1].Certificate,
        "-EvidencePath", $nativeEvidencePath
      )
      $process = Start-Process `
        -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList $arguments `
        -Verb RunAs `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
      if ($process.ExitCode -ne 0) {
        throw "Elevated QuickHack packaged-service test failed with exit code $($process.ExitCode)."
      }
    }
    $evidence = Get-Content -LiteralPath $nativeEvidencePath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($evidence.status -ne "PASS" -or -not $evidence.updateVerified) {
      throw "QuickHack packaged-service native evidence is invalid."
    }
    Write-Host "QuickHack packaged-service native install, process, stop, update, and uninstall gate passed."
  } else {
    [ordered]@{
      schemaVersion = 1
      status = "NOT_RUN"
      reason = "Run with -RunNativeInstall and approve UAC for authoritative service evidence."
    } | ConvertTo-Json | Set-Content -LiteralPath $nativeEvidencePath -Encoding utf8
    Write-Host "QuickHack packaged-service source/build gate passed; native install is NOT_RUN."
  }
} finally {
  if (Test-Path -LiteralPath $validationRoot) {
    Remove-Item -LiteralPath $validationRoot -Recurse -Force
  }
}
