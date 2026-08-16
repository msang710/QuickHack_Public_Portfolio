param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"

$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$nodeExecutable = Join-Path $resolvedInstallDir "runtime\node\node.exe"
$firewallRuleName = "QuickHack HTTPS Server (Local Subnet)"

if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  throw "QuickHack server runtime was not found: $nodeExecutable"
}

Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction Stop
New-NetFirewallRule `
  -DisplayName $firewallRuleName `
  -Description "Allows encrypted QuickHack client access from the local subnet." `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 3443 `
  -Program $nodeExecutable `
  -RemoteAddress LocalSubnet `
  -Profile Any `
  -Enabled True | Out-Null

Write-Host "QuickHack HTTPS local-subnet firewall rule installed: $firewallRuleName"
