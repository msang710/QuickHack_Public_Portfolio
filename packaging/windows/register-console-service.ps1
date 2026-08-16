param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("QuickHackDemoServerConsole", "QuickHackOperationalServerConsole")]
  [string]$ServiceName,

  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,

  [Parameter(Mandatory = $true)]
  [string]$DisplayName
)

$ErrorActionPreference = "Stop"
$resolvedLauncher = [System.IO.Path]::GetFullPath($LauncherPath)
if (-not (Test-Path -LiteralPath $resolvedLauncher -PathType Leaf)) {
  throw "QuickHack console service launcher was not found: $resolvedLauncher"
}
$binaryPath = '"{0}" --windows-service' -f $resolvedLauncher
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  & sc.exe config $ServiceName "binPath= $binaryPath" "start= auto" "DisplayName= $DisplayName" | Out-Null
} else {
  & sc.exe create $ServiceName "binPath= $binaryPath" "start= auto" "DisplayName= $DisplayName" | Out-Null
}
if ($LASTEXITCODE -ne 0) {
  throw "QuickHack console service registration failed: $ServiceName"
}
$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne 'Running') {
  Start-Service -InputObject $service
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
}
