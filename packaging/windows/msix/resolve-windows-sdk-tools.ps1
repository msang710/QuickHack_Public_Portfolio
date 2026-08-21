Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-QuickHackWindowsSdkTools {
  [CmdletBinding()]
  param(
    [string]$SdkRoot = ""
  )

  $commandMakeAppx = Get-Command MakeAppx.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
  $commandSignTool = Get-Command SignTool.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
  if ($commandMakeAppx -and $commandSignTool) {
    return [pscustomobject]@{
      MakeAppx = $commandMakeAppx
      SignTool = $commandSignTool
      Root = Split-Path -Parent $commandMakeAppx
    }
  }

  $roots = @()
  if ($SdkRoot) {
    $roots += [System.IO.Path]::GetFullPath($SdkRoot)
  }
  $roots += @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "$env:ProgramFiles\Windows Kits\10\bin"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

  foreach ($root in $roots) {
    $makeAppxCandidates = Get-ChildItem `
      -LiteralPath $root `
      -Filter "MakeAppx.exe" `
      -File `
      -Recurse `
      -ErrorAction SilentlyContinue |
      Sort-Object `
        @{ Expression = { if ($_.FullName -match '[\\/]x64[\\/]') { 0 } else { 1 } } },
        @{ Expression = { $_.FullName }; Descending = $true }
    foreach ($makeAppx in $makeAppxCandidates) {
      $siblingSignTool = Join-Path $makeAppx.DirectoryName "SignTool.exe"
      if (Test-Path -LiteralPath $siblingSignTool -PathType Leaf) {
        return [pscustomobject]@{
          MakeAppx = $makeAppx.FullName
          SignTool = $siblingSignTool
          Root = $root
        }
      }
    }
  }

  throw (
    "Windows SDK MakeAppx.exe and SignTool.exe were not found. " +
    "Install Microsoft.Windows.SDK.BuildTools or pass -SdkRoot."
  )
}

if ($MyInvocation.InvocationName -ne ".") {
  Resolve-QuickHackWindowsSdkTools | ConvertTo-Json -Compress
}
