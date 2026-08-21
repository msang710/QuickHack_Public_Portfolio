[CmdletBinding()]
param(
  [ValidateSet("DEMONSTRATION_SERVER", "OPERATIONAL_SERVER")]
  [string]$ArtifactKind = "DEMONSTRATION_SERVER",

  [ValidateRange(1, 300)]
  [int]$StopTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:QuickHackInstallPreflightExitCodes = [ordered]@{
  Ready = 0
  OppositePackage = 30
  OppositeService = 31
  LegacyLayout = 32
  InspectionFailed = 33
  StopFailed = 34
  StopTimeout = 35
  InvalidConfiguration = 36
}

function New-QuickHackInstallPreflightResult {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Code,

    [Parameter(Mandatory = $true)]
    [string]$Reason
  )

  return [pscustomobject]@{
    Code = $Code
    Reason = $Reason
  }
}

function Get-QuickHackInstallPreflightConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RequestedArtifactKind
  )

  switch ($RequestedArtifactKind) {
    "DEMONSTRATION_SERVER" {
      return [pscustomobject]@{
        OwnPostgresqlServiceName = "QuickHackDemoPostgreSQL"
        OppositePostgresqlServiceName = "QuickHackOperationalPostgreSQL"
        OppositeConsoleServiceName = "QuickHackOperationalServerConsole"
        OppositeAppId = "{4AF4F2BB-CB9D-46F7-A8F6-1B585A2BEB17}"
      }
    }
    "OPERATIONAL_SERVER" {
      return [pscustomobject]@{
        OwnPostgresqlServiceName = "QuickHackOperationalPostgreSQL"
        OppositePostgresqlServiceName = "QuickHackDemoPostgreSQL"
        OppositeConsoleServiceName = "QuickHackDemoServerConsole"
        OppositeAppId = "{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}"
      }
    }
    default {
      throw "Unsupported QuickHack server artifact kind: $RequestedArtifactKind"
    }
  }
}

function Get-QuickHackOptionalService {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  try {
    return Get-Service -Name $Name -ErrorAction Stop
  } catch {
    if ($_.FullyQualifiedErrorId -like "NoServiceFoundForGivenName*") {
      return $null
    }
    throw
  }
}

function Invoke-QuickHackInstallPreflight {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RequestedArtifactKind,

    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 60,

    [scriptblock]$TestRegistryPath = {
      param([string]$LiteralPath)
      Test-Path -LiteralPath $LiteralPath -PathType Container -ErrorAction Stop
    },

    [scriptblock]$GetService = {
      param([string]$Name)
      Get-QuickHackOptionalService -Name $Name
    },

    [scriptblock]$StopService = {
      param($Service)
      Stop-Service -InputObject $Service -Force -ErrorAction Stop
    },

    [scriptblock]$WaitForStopped = {
      param($Service, [int]$WaitSeconds)
      $Service.WaitForStatus(
        [System.ServiceProcess.ServiceControllerStatus]::Stopped,
        [TimeSpan]::FromSeconds($WaitSeconds)
      )
      $Service.Refresh()
      if ($Service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        throw [System.TimeoutException]::new("Service did not reach the Stopped state.")
      }
    }
  )

  try {
    $config = Get-QuickHackInstallPreflightConfig -RequestedArtifactKind $RequestedArtifactKind
  } catch {
    return New-QuickHackInstallPreflightResult `
      -Code $script:QuickHackInstallPreflightExitCodes.InvalidConfiguration `
      -Reason "INVALID_CONFIGURATION"
  }

  $oppositeRegistryPath =
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($config.OppositeAppId)_is1"
  try {
    if (& $TestRegistryPath $oppositeRegistryPath) {
      return New-QuickHackInstallPreflightResult `
        -Code $script:QuickHackInstallPreflightExitCodes.OppositePackage `
        -Reason "SERVER_FLAVOR_PACKAGE_CONFLICT"
    }

    foreach ($serviceName in @(
      $config.OppositePostgresqlServiceName,
      $config.OppositeConsoleServiceName
    )) {
      if ($null -ne (& $GetService $serviceName)) {
        return New-QuickHackInstallPreflightResult `
          -Code $script:QuickHackInstallPreflightExitCodes.OppositeService `
          -Reason "SERVER_FLAVOR_SERVICE_CONFLICT"
      }
    }

    if ($null -ne (& $GetService "QuickHackPostgreSQL")) {
      return New-QuickHackInstallPreflightResult `
        -Code $script:QuickHackInstallPreflightExitCodes.LegacyLayout `
        -Reason "LEGACY_LAYOUT_DETECTED"
    }

    $ownPostgresqlService = & $GetService $config.OwnPostgresqlServiceName
  } catch {
    return New-QuickHackInstallPreflightResult `
      -Code $script:QuickHackInstallPreflightExitCodes.InspectionFailed `
      -Reason "PREFLIGHT_INSPECTION_FAILED"
  }

  if (
    $null -eq $ownPostgresqlService -or
    $ownPostgresqlService.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Stopped
  ) {
    return New-QuickHackInstallPreflightResult `
      -Code $script:QuickHackInstallPreflightExitCodes.Ready `
      -Reason "READY"
  }

  try {
    & $StopService $ownPostgresqlService | Out-Null
  } catch {
    return New-QuickHackInstallPreflightResult `
      -Code $script:QuickHackInstallPreflightExitCodes.StopFailed `
      -Reason "POSTGRESQL_STOP_FAILED"
  }

  try {
    & $WaitForStopped $ownPostgresqlService $TimeoutSeconds | Out-Null
  } catch [System.TimeoutException] {
    return New-QuickHackInstallPreflightResult `
      -Code $script:QuickHackInstallPreflightExitCodes.StopTimeout `
      -Reason "POSTGRESQL_STOP_TIMEOUT"
  } catch {
    return New-QuickHackInstallPreflightResult `
      -Code $script:QuickHackInstallPreflightExitCodes.StopFailed `
      -Reason "POSTGRESQL_STOP_FAILED"
  }

  return New-QuickHackInstallPreflightResult `
    -Code $script:QuickHackInstallPreflightExitCodes.Ready `
    -Reason "READY"
}

if ($MyInvocation.InvocationName -ne ".") {
  $preflightResult = Invoke-QuickHackInstallPreflight `
    -RequestedArtifactKind $ArtifactKind `
    -TimeoutSeconds $StopTimeoutSeconds
  Write-Output (
    "QUICKHACK_INSTALL_PREFLIGHT_V1 code={0} reason={1}" -f `
      $preflightResult.Code,
      $preflightResult.Reason
  )
  exit $preflightResult.Code
}
