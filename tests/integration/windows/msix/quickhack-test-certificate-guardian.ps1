[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CertificateV1,
  [Parameter(Mandatory = $true)][string]$CertificateV2,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$StopFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "QuickHack test certificate guardian requires an administrator token."
}

$thumbprints = @()
try {
  foreach ($certificatePath in @($CertificateV1, $CertificateV2)) {
    if (-not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
      throw "QuickHack test certificate was not found: $certificatePath"
    }
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
    & "$env:WINDIR\System32\certutil.exe" -f -addstore TrustedPeople $certificatePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to trust a QuickHack LocalMachine test certificate." }
    $thumbprints += $certificate.Thumbprint
  }
  $missing = @($thumbprints | Where-Object {
    -not (Get-ChildItem Cert:\LocalMachine\TrustedPeople -ErrorAction SilentlyContinue |
      Where-Object Thumbprint -eq $_)
  })
  if ($missing.Count -gt 0) {
    throw "QuickHack LocalMachine test certificate trust was not observed."
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $ReadyFile) -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    status = "READY"
    thumbprints = $thumbprints
  } | ConvertTo-Json | Set-Content -LiteralPath $ReadyFile -Encoding utf8
  while (-not (Test-Path -LiteralPath $StopFile -PathType Leaf)) {
    Start-Sleep -Milliseconds 200
  }
} finally {
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    "TrustedPeople",
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    foreach ($thumbprint in $thumbprints | Select-Object -Unique) {
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
