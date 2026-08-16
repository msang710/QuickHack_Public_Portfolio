param(
  [int]$Port = 3000,
  [string]$NodeExecutable = ""
)

$ErrorActionPreference = "Stop"
$ruleName = "QuickHack Development Server (Local Subnet)"
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configuredNode = ([string]$NodeExecutable).Trim()
$nodePath = if ($configuredNode) {
  [System.IO.Path]::GetFullPath($configuredNode)
} else {
  Join-Path $workspaceRoot "tools\node-portable\node-v24.17.0-win-x64\node.exe"
}

$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as administrator."
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "QuickHack Node runtime was not found: $nodePath"
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction Stop
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Description "Allows authenticated QuickHack mobile access from the local subnet." `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Program $nodePath `
  -RemoteAddress LocalSubnet `
  -Profile Any `
  -Enabled True | Out-Null

Write-Host "Configured firewall rule: $ruleName"
Write-Host "TCP port: $Port"
Write-Host "Program: $nodePath"
