$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\..\..")
)
$preflightPath = Join-Path $projectRoot "packaging\windows\invoke-install-preflight.ps1"
. $preflightPath

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]
    $Actual,

    [Parameter(Mandatory = $true)]
    $Expected,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "$Message Expected=$Expected Actual=$Actual"
  }
}

function New-FakeService {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [System.ServiceProcess.ServiceControllerStatus]$Status
  )

  return [pscustomobject]@{
    Name = $Name
    Status = $Status
  }
}

function Invoke-Fixture {
  param(
    [string]$RequestedArtifactKind = "DEMONSTRATION_SERVER",
    [bool]$OppositePackageInstalled = $false,
    [hashtable]$Services = @{},
    [bool]$QueryFails = $false,
    [bool]$StopFails = $false,
    [bool]$WaitTimesOut = $false,
    [ref]$StopCalls,
    [ref]$WaitCalls
  )

  $serviceSnapshot = $Services
  $queryMustFail = $QueryFails
  $stopMustFail = $StopFails
  $waitMustTimeOut = $WaitTimesOut
  $oppositePackageExists = $OppositePackageInstalled

  $testRegistryPath = {
    param([string]$LiteralPath)
    if ($LiteralPath -notmatch "^Registry::HKEY_LOCAL_MACHINE") {
      throw "Unexpected registry path: $LiteralPath"
    }
    return $oppositePackageExists
  }.GetNewClosure()
  $getService = {
    param([string]$Name)
    if ($queryMustFail) {
      throw "Simulated service query failure"
    }
    if ($serviceSnapshot.ContainsKey($Name)) {
      return $serviceSnapshot[$Name]
    }
    return $null
  }.GetNewClosure()
  $stopService = {
    param($Service)
    $StopCalls.Value += 1
    if ($stopMustFail) {
      throw "Simulated stop failure"
    }
  }.GetNewClosure()
  $waitForStopped = {
    param($Service, [int]$WaitSeconds)
    $WaitCalls.Value += 1
    Assert-Equal -Actual $WaitSeconds -Expected 60 -Message "Unexpected stop timeout."
    if ($waitMustTimeOut) {
      throw [System.TimeoutException]::new("Simulated stop timeout")
    }
  }.GetNewClosure()

  return Invoke-QuickHackInstallPreflight `
    -RequestedArtifactKind $RequestedArtifactKind `
    -TimeoutSeconds 60 `
    -TestRegistryPath $testRegistryPath `
    -GetService $getService `
    -StopService $stopService `
    -WaitForStopped $waitForStopped
}

$stopCalls = 0
$waitCalls = 0
$result = Invoke-Fixture -StopCalls ([ref]$stopCalls) -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 0 "A clean machine must pass preflight."
Assert-Equal $stopCalls 0 "A clean machine must not stop a service."
Assert-Equal $waitCalls 0 "A clean machine must not wait for a service."

$stopCalls = 0
$waitCalls = 0
$result = Invoke-Fixture `
  -OppositePackageInstalled $true `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 30 "An opposite package must be rejected."

$stopCalls = 0
$waitCalls = 0
$services = @{
  QuickHackOperationalPostgreSQL = New-FakeService `
    -Name "QuickHackOperationalPostgreSQL" `
    -Status ([System.ServiceProcess.ServiceControllerStatus]::Running)
}
$result = Invoke-Fixture `
  -Services $services `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 31 "An opposite service must be rejected."

$stopCalls = 0
$waitCalls = 0
$services = @{
  QuickHackPostgreSQL = New-FakeService `
    -Name "QuickHackPostgreSQL" `
    -Status ([System.ServiceProcess.ServiceControllerStatus]::Stopped)
}
$result = Invoke-Fixture `
  -Services $services `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 32 "A legacy service must be rejected."

$stopCalls = 0
$waitCalls = 0
$services = @{
  QuickHackDemoPostgreSQL = New-FakeService `
    -Name "QuickHackDemoPostgreSQL" `
    -Status ([System.ServiceProcess.ServiceControllerStatus]::Stopped)
}
$result = Invoke-Fixture `
  -Services $services `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 0 "An already stopped own service must pass."
Assert-Equal $stopCalls 0 "An already stopped service must not be stopped again."

$stopCalls = 0
$waitCalls = 0
$services = @{
  QuickHackDemoPostgreSQL = New-FakeService `
    -Name "QuickHackDemoPostgreSQL" `
    -Status ([System.ServiceProcess.ServiceControllerStatus]::Running)
}
$result = Invoke-Fixture `
  -Services $services `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 0 "A running own service must stop successfully."
Assert-Equal $stopCalls 1 "A running own service must be stopped exactly once."
Assert-Equal $waitCalls 1 "A running own service must be awaited exactly once."

$stopCalls = 0
$waitCalls = 0
$result = Invoke-Fixture `
  -QueryFails $true `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 33 "A service inspection failure must be distinct."

$stopCalls = 0
$waitCalls = 0
$result = Invoke-Fixture `
  -Services $services `
  -StopFails $true `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 34 "A service stop failure must be distinct."
Assert-Equal $waitCalls 0 "A failed stop must not proceed to wait."

$stopCalls = 0
$waitCalls = 0
$result = Invoke-Fixture `
  -Services $services `
  -WaitTimesOut $true `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 35 "A service stop timeout must be distinct."

$stopCalls = 0
$waitCalls = 0
$services = @{
  QuickHackOperationalPostgreSQL = New-FakeService `
    -Name "QuickHackOperationalPostgreSQL" `
    -Status ([System.ServiceProcess.ServiceControllerStatus]::Stopped)
}
$result = Invoke-Fixture `
  -RequestedArtifactKind "OPERATIONAL_SERVER" `
  -Services $services `
  -StopCalls ([ref]$stopCalls) `
  -WaitCalls ([ref]$waitCalls)
Assert-Equal $result.Code 0 "Operational server preflight must use its own service identity."

Write-Host "QuickHack Windows install preflight result and retry behavior verified."
