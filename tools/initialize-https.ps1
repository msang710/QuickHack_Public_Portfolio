param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir,

  [int]$HttpsPort = 3443,

  [string]$HostNamesCsv = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Utf8WithoutBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Convert-CertificateToPem {
  param([Parameter(Mandatory = $true)]$Certificate)

  $base64 = [Convert]::ToBase64String(
    $Certificate.RawData,
    [Base64FormattingOptions]::InsertLineBreaks
  )
  return "-----BEGIN CERTIFICATE-----`r`n$base64`r`n-----END CERTIFICATE-----`r`n"
}

function Test-IpAddress {
  param([string]$Value)

  $address = $null
  return [System.Net.IPAddress]::TryParse($Value, [ref]$address)
}

function New-RandomPassphrase {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Protect-TlsDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $arguments = @(
    $Path,
    "/inheritance:e",
    "/grant:r",
    "*$($currentUserSid):(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F"
  )
  $process = Start-Process `
    -FilePath "icacls.exe" `
    -ArgumentList $arguments `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "Failed to protect QuickHack TLS directory. icacls exit code: $($process.ExitCode)"
  }
}

if ($HttpsPort -lt 1 -or $HttpsPort -gt 65535) {
  throw "HTTPS port must be between 1 and 65535."
}

$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$tlsDir = Join-Path $resolvedDataDir "security\tls"
$issuerDir = Join-Path $tlsDir "issuer"
$clientConfigDir = Join-Path $tlsDir "client-config"
$metadataPath = Join-Path $tlsDir "metadata.json"
$serverPfxPath = Join-Path $tlsDir "server.pfx"
$serverPasswordPath = Join-Path $tlsDir "server-pfx-passphrase.txt"
$rootCaPemPath = Join-Path $tlsDir "quickhack-ca.pem"
$serverCertificatePemPath = Join-Path $tlsDir "server-certificate.pem"
$rootIssuerPfxPath = Join-Path $issuerDir "root-ca-private.pfx"
$rootIssuerPasswordPath = Join-Path $issuerDir "root-ca-pfx-passphrase.txt"

New-Item -ItemType Directory -Path $tlsDir -Force | Out-Null
New-Item -ItemType Directory -Path $issuerDir -Force | Out-Null
New-Item -ItemType Directory -Path $clientConfigDir -Force | Out-Null
Protect-TlsDirectory -Path $tlsDir

$hostNames = New-Object System.Collections.Generic.List[string]
foreach ($candidate in $HostNamesCsv.Split(',')) {
  $normalized = ([string]$candidate).Trim()
  if ($normalized -and -not $hostNames.Contains($normalized)) {
    $hostNames.Add($normalized)
  }
}

foreach ($candidate in @("localhost", "127.0.0.1", [System.Net.Dns]::GetHostName())) {
  $normalized = ([string]$candidate).Trim()
  if ($normalized -and -not $hostNames.Contains($normalized)) {
    $hostNames.Add($normalized)
  }
}

if ($hostNames.Count -eq 0) {
  throw "At least one HTTPS certificate host name is required."
}

$rootCertificate = $null
$createdNewRoot = $false
if (
  (Test-Path -LiteralPath $rootIssuerPfxPath -PathType Leaf) -and
  (Test-Path -LiteralPath $rootIssuerPasswordPath -PathType Leaf)
) {
  $issuerPassphrase = (Get-Content -LiteralPath $rootIssuerPasswordPath -Raw -Encoding UTF8).Trim()
  if (-not $issuerPassphrase) {
    throw "QuickHack root CA passphrase file is empty."
  }
  $issuerSecurePassphrase = ConvertTo-SecureString -String $issuerPassphrase -AsPlainText -Force
  $importedCertificates = @(
    Import-PfxCertificate `
      -FilePath $rootIssuerPfxPath `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -Password $issuerSecurePassphrase `
      -Exportable
  )
  $rootCertificate = $importedCertificates |
    Where-Object { $_.Subject -eq "CN=QuickHack Local Root CA" -and $_.HasPrivateKey } |
    Select-Object -First 1
  if (-not $rootCertificate) {
    throw "The stored QuickHack root CA private certificate is invalid."
  }
} else {
  $rootCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=QuickHack Local Root CA" `
    -FriendlyName "QuickHack Local Root CA" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(10) `
    -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=1")
  $createdNewRoot = $true

  $issuerPassphrase = New-RandomPassphrase
  $issuerSecurePassphrase = ConvertTo-SecureString -String $issuerPassphrase -AsPlainText -Force
  Export-PfxCertificate `
    -Cert $rootCertificate `
    -FilePath $rootIssuerPfxPath `
    -Password $issuerSecurePassphrase `
    -ChainOption EndEntityCertOnly `
    -Force | Out-Null
  Write-Utf8WithoutBom -Path $rootIssuerPasswordPath -Value "$issuerPassphrase`r`n"
}

$rootPem = Convert-CertificateToPem -Certificate $rootCertificate
Write-Utf8WithoutBom -Path $rootCaPemPath -Value $rootPem

$sanParts = foreach ($hostName in $hostNames) {
  if (Test-IpAddress -Value $hostName) {
    "IPAddress=$hostName"
  } else {
    "DNS=$hostName"
  }
}
$sanExtension = "2.5.29.17={text}$($sanParts -join '&')"
$primaryHost = $hostNames |
  Where-Object { (Test-IpAddress -Value $_) -and $_ -ne "127.0.0.1" } |
  Select-Object -First 1
if (-not $primaryHost) {
  $primaryHost = $hostNames | Where-Object { $_ -ne "localhost" } | Select-Object -First 1
}
if (-not $primaryHost) {
  $primaryHost = "localhost"
}

$serverCertificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=$primaryHost" `
  -FriendlyName "QuickHack HTTPS Server" `
  -Signer $rootCertificate `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddDays(365) `
  -TextExtension @(
    "2.5.29.19={critical}{text}ca=0",
    "2.5.29.37={text}1.3.6.1.5.5.7.3.1",
    $sanExtension
  )

$pfxPassphrase = New-RandomPassphrase
$securePassphrase = ConvertTo-SecureString -String $pfxPassphrase -AsPlainText -Force

Export-PfxCertificate `
  -Cert $serverCertificate `
  -FilePath $serverPfxPath `
  -Password $securePassphrase `
  -ChainOption EndEntityCertOnly `
  -Force | Out-Null
Write-Utf8WithoutBom -Path $serverPasswordPath -Value "$pfxPassphrase`r`n"
Write-Utf8WithoutBom `
  -Path $serverCertificatePemPath `
  -Value (Convert-CertificateToPem -Certificate $serverCertificate)

Copy-Item -LiteralPath $rootCaPemPath -Destination (Join-Path $clientConfigDir "quickhack-ca.pem") -Force
$serverUrl = "https://$primaryHost`:$HttpsPort"
Write-Utf8WithoutBom `
  -Path (Join-Path $clientConfigDir "server-url.txt") `
  -Value "$serverUrl`r`n"
Write-Utf8WithoutBom `
  -Path (Join-Path $clientConfigDir "README.txt") `
  -Value @"
QuickHack HTTPS client configuration

Copy server-url.txt and quickhack-ca.pem into the client installation's config folder.
The CA file is public. Never copy server.pfx or server-pfx-passphrase.txt to a client PC.
"@

$metadata = [ordered]@{
  version = 1
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  createdNewRoot = $createdNewRoot
  rootThumbprint = $rootCertificate.Thumbprint
  rootNotAfter = $rootCertificate.NotAfter.ToUniversalTime().ToString("o")
  serverThumbprint = $serverCertificate.Thumbprint
  serverNotAfter = $serverCertificate.NotAfter.ToUniversalTime().ToString("o")
  hostNames = @($hostNames)
  primaryHost = $primaryHost
  httpsPort = $HttpsPort
  serverUrl = $serverUrl
}
Write-Utf8WithoutBom `
  -Path $metadataPath `
  -Value (($metadata | ConvertTo-Json -Depth 4) + "`r`n")

Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($serverCertificate.Thumbprint)" -Force
Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($rootCertificate.Thumbprint)" -Force
Protect-TlsDirectory -Path $tlsDir

$metadata | ConvertTo-Json -Compress -Depth 4
