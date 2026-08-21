param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir,

  [int]$HttpsPort = 3443,

  [string]$HostNamesCsv = "",

  [Parameter(Mandatory = $true)]
  [string]$PrimaryHost,

  [ValidateSet("INITIALIZE", "ROTATE", "FINALIZE_ROTATION")]
  [string]$Mode = "INITIALIZE"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Write-Utf8WithoutBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
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

function Get-CertificateSha256 {
  param([Parameter(Mandatory = $true)]$Certificate)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($Certificate.RawData)
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha.Dispose()
  }
}

function Get-CanonicalTimestamp {
  param([datetime]$Value = (Get-Date).ToUniversalTime())
  return $Value.ToUniversalTime().ToString(
    "yyyy-MM-ddTHH:mm:ss.fff'Z'",
    [System.Globalization.CultureInfo]::InvariantCulture
  )
}

function Test-IpAddress {
  param([string]$Value)
  $address = $null
  return [System.Net.IPAddress]::TryParse($Value, [ref]$address)
}

function Assert-SafeHostName {
  param([Parameter(Mandatory = $true)][string]$Value)
  $normalized = $Value.Trim().ToLowerInvariant()
  if (
    -not $normalized -or
    $normalized.Length -gt 253 -or
    $normalized -notmatch '^[a-z0-9:.-]+$' -or
    $normalized.Contains('..')
  ) {
    throw "A TLS host name is invalid."
  }
  return $normalized
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

function Test-RegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [long]$MaxBytes = 1048576
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  if (
    ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $item.Length -lt 1 -or
    $item.Length -gt $MaxBytes
  ) {
    throw "TLS state contains an unsafe file: $Path"
  }
  return $true
}

function Import-LegacyIssuerCertificate {
  param(
    [Parameter(Mandatory = $true)][string]$PfxPath,
    [Parameter(Mandatory = $true)][string]$PassphrasePath
  )
  $issuerPassphrase = (Get-Content -LiteralPath $PassphrasePath -Raw -Encoding UTF8).Trim()
  if (-not $issuerPassphrase) { throw "QuickHack root CA passphrase file is empty." }
  $flags =
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [System.IO.File]::ReadAllBytes($PfxPath),
    $issuerPassphrase,
    $flags
  )
  if (
    $certificate.Subject -ne "CN=QuickHack Local Root CA" -or
    -not $certificate.HasPrivateKey
  ) { throw "The stored QuickHack root CA private certificate is invalid." }
  return $certificate
}

function Import-DpapiIssuerMaterial {
  param(
    [Parameter(Mandatory = $true)][string]$PrivatePath,
    [Parameter(Mandatory = $true)][string]$PublicCertificatePath
  )
  $entropy = [System.Text.Encoding]::UTF8.GetBytes("QH-WINDOWS-TLS-ISSUER-V2")
  $protected = [System.IO.File]::ReadAllBytes($PrivatePath)
  $privateBlob = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $key = $null
  $rsa = $null
  $publicCertificate = $null
  try {
    $key = [System.Security.Cryptography.CngKey]::Import(
      $privateBlob,
      [System.Security.Cryptography.CngKeyBlobFormat]::GenericPrivateBlob
    )
    $rsa = [System.Security.Cryptography.RSACng]::new($key)
    $key = $null
    $publicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $PublicCertificatePath
    )
    [Array]::Clear($privateBlob, 0, $privateBlob.Length)
    return [pscustomobject]@{ Certificate = $publicCertificate; Rsa = $rsa }
  } catch {
    if ($publicCertificate) { $publicCertificate.Dispose() }
    if ($rsa) { $rsa.Dispose() }
    if ($key) { $key.Dispose() }
    if ($privateBlob) { [Array]::Clear($privateBlob, 0, $privateBlob.Length) }
    throw
  }
}

function Export-DpapiIssuerMaterial {
  param(
    [Parameter(Mandatory = $true)]$Rsa,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not ($Rsa -is [System.Security.Cryptography.RSACng])) {
    throw "QuickHack Windows issuer key is not backed by CNG."
  }
  $privateBlob = $Rsa.Key.Export(
    [System.Security.Cryptography.CngKeyBlobFormat]::GenericPrivateBlob
  )
  try {
    $entropy = [System.Text.Encoding]::UTF8.GetBytes("QH-WINDOWS-TLS-ISSUER-V2")
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $privateBlob,
      $entropy,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.IO.File]::WriteAllBytes($Path, $protected)
  } finally {
    [Array]::Clear($privateBlob, 0, $privateBlob.Length)
  }
}

function New-RootCertificate {
  $rsa = [System.Security.Cryptography.RSA]::Create(3072)
  try {
    $rootId = [Guid]::NewGuid().ToString("N").Substring(0, 12)
    $name = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new(
      "CN=QuickHack Local Root CA $rootId"
    )
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
      $name,
      $rsa,
      [System.Security.Cryptography.HashAlgorithmName]::SHA256,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
        $true,
        $true,
        1,
        $true
      )
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
          [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign -bor
          [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature),
        $true
      )
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
        $request.PublicKey,
        $false
      )
    )
    $certificate = $request.CreateSelfSigned(
      [DateTimeOffset]::UtcNow.AddMinutes(-5),
      [DateTimeOffset]::UtcNow.AddYears(10)
    )
    return [pscustomobject]@{ Certificate = $certificate; Rsa = $rsa }
  } catch {
    $rsa.Dispose()
    throw
  }
}

function New-ServerCertificate {
  param(
    [Parameter(Mandatory = $true)]$Issuer,
    [Parameter(Mandatory = $true)]$IssuerRsa,
    [Parameter(Mandatory = $true)][string]$SubjectHost,
    [Parameter(Mandatory = $true)]$HostNames
  )
  $rsa = [System.Security.Cryptography.RSA]::Create(3072)
  $publicCertificate = $null
  try {
    $name = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new(
      "CN=$SubjectHost"
    )
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
      $name,
      $rsa,
      [System.Security.Cryptography.HashAlgorithmName]::SHA256,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
        $false,
        $false,
        0,
        $true
      )
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
          [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment),
        $true
      )
    )
    $enhancedUsage = [System.Security.Cryptography.OidCollection]::new()
    [void]$enhancedUsage.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
        $enhancedUsage,
        $false
      )
    )
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    foreach ($hostName in $HostNames) {
      if (Test-IpAddress -Value $hostName) {
        $san.AddIpAddress([System.Net.IPAddress]::Parse($hostName))
      } else {
        $san.AddDnsName($hostName)
      }
    }
    $request.CertificateExtensions.Add($san.Build($false))
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
        $request.PublicKey,
        $false
      )
    )
    $serial = New-Object byte[] 16
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($serial) } finally { $generator.Dispose() }
    $signatureGenerator = [System.Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForRSA(
      $IssuerRsa,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $publicCertificate = $request.Create(
      $Issuer.SubjectName,
      $signatureGenerator,
      [DateTimeOffset]::UtcNow.AddMinutes(-5),
      [DateTimeOffset]::UtcNow.AddDays(365),
      $serial
    )
    $certificate = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey(
      $publicCertificate,
      $rsa
    )
    $publicCertificate.Dispose()
    return [pscustomobject]@{ Certificate = $certificate; Rsa = $rsa }
  } catch {
    if ($publicCertificate) { $publicCertificate.Dispose() }
    $rsa.Dispose()
    throw
  }
}

function New-CrossSignedCaCertificate {
  param(
    [Parameter(Mandatory = $true)]$CurrentCertificate,
    [Parameter(Mandatory = $true)]$CurrentRsa,
    [Parameter(Mandatory = $true)]$PreviousIssuer,
    [Parameter(Mandatory = $true)]$PreviousIssuerRsa
  )
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    $CurrentCertificate.SubjectName,
    $CurrentRsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
      $true,
      $true,
      1,
      $true
    )
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature),
      $true
    )
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
      $request.PublicKey,
      $false
    )
  )
  $serial = New-Object byte[] 16
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($serial) } finally { $generator.Dispose() }
  $signatureGenerator = [System.Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForRSA(
    $PreviousIssuerRsa,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  return $request.Create(
    $PreviousIssuer.SubjectName,
    $signatureGenerator,
    [DateTimeOffset]::UtcNow.AddMinutes(-5),
    [DateTimeOffset]::UtcNow.AddYears(10),
    $serial
  )
}

function Export-PrivatePfx {
  param(
    [Parameter(Mandatory = $true)]$Certificate,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Passphrase,
    [object[]]$ChainCertificates = @()
  )
  $collection = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
  $publicChainCertificates = New-Object `
    System.Collections.Generic.List[System.Security.Cryptography.X509Certificates.X509Certificate2]
  [void]$collection.Add($Certificate)
  try {
    foreach ($chainCertificate in $ChainCertificates) {
      if (-not $chainCertificate) { continue }
      $publicChainCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $chainCertificate.RawData
      )
      $publicChainCertificates.Add($publicChainCertificate)
      [void]$collection.Add($publicChainCertificate)
    }
    $bytes = $collection.Export(
      [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
      $Passphrase
    )
    [System.IO.File]::WriteAllBytes($Path, $bytes)
  } finally {
    foreach ($publicChainCertificate in $publicChainCertificates) {
      $publicChainCertificate.Dispose()
    }
  }
}

if ($HttpsPort -lt 1 -or $HttpsPort -gt 65535) {
  throw "HTTPS port must be between 1 and 65535."
}

$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$securityDir = Join-Path $resolvedDataDir "security"
$tlsDir = Join-Path $securityDir "tls"
$operationId = [Guid]::NewGuid().ToString("N")
$temporaryDir = Join-Path $securityDir ".tls.$PID.$operationId.prepared"
$rollbackDir = Join-Path $securityDir ".tls.$PID.$operationId.rollback"
$existingIssuerPrivate = Join-Path $tlsDir "issuer\root-ca-private.bin"
$existingLegacyIssuerPfx = Join-Path $tlsDir "issuer\root-ca-private.pfx"
$existingLegacyIssuerPassword = Join-Path $tlsDir "issuer\root-ca-pfx-passphrase.txt"
$existingRootCa = Join-Path $tlsDir "quickhack-ca.pem"
$existingPreviousCa = Join-Path $tlsDir "quickhack-previous-ca.pem"
$existingCrossSignedCa = Join-Path $tlsDir "quickhack-current-cross-signed.pem"
$existingManifestPath = Join-Path $tlsDir "client-config\trust-bundle.json"

$issuerPrivateExists = Test-RegularFile -Path $existingIssuerPrivate
$legacyIssuerPfxExists = Test-RegularFile -Path $existingLegacyIssuerPfx
$legacyIssuerPasswordExists = Test-RegularFile -Path $existingLegacyIssuerPassword
if ($legacyIssuerPfxExists -ne $legacyIssuerPasswordExists) {
  throw "Existing QuickHack CA issuer state is incomplete."
}
if ($issuerPrivateExists -and $legacyIssuerPfxExists) {
  throw "Multiple QuickHack CA issuer formats are present."
}
$hasLegacyIssuer = $legacyIssuerPfxExists -and $legacyIssuerPasswordExists
$hasExistingIssuer = $issuerPrivateExists -or $hasLegacyIssuer
if ($hasExistingIssuer -and -not (Test-RegularFile -Path $existingRootCa)) {
  throw "Existing QuickHack CA public certificate is missing."
}

$oldManifest = $null
if (Test-RegularFile -Path $existingManifestPath) {
  try {
    $oldManifest = Get-Content -LiteralPath $existingManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Existing QuickHack trust bundle manifest is invalid."
  }
  if ($oldManifest.version -ne 1) { throw "Existing QuickHack trust bundle version is unsupported." }
}
$rotationActive = $null -ne $oldManifest -and
  $oldManifest.PSObject.Properties.Name -contains "previousCaSha256"
if ($rotationActive -and -not (Test-RegularFile -Path $existingPreviousCa)) {
  throw "Existing QuickHack rotation state is incomplete."
}
if ($rotationActive -and -not (Test-RegularFile -Path $existingCrossSignedCa)) {
  throw "Existing QuickHack cross-signed rotation certificate is missing."
}
if (-not $rotationActive -and (Test-RegularFile -Path $existingPreviousCa)) {
  throw "A stale previous CA exists outside a rotation window."
}
if ($Mode -eq "ROTATE" -and -not $hasExistingIssuer) {
  throw "CA rotation requires an existing current CA."
}
if ($Mode -eq "ROTATE" -and $rotationActive) {
  throw "Finalize the current CA rotation before starting another."
}
if ($Mode -eq "FINALIZE_ROTATION" -and -not $rotationActive) {
  throw "There is no active CA rotation to finalize."
}

$hostNames = New-Object System.Collections.Generic.List[string]
foreach ($candidate in $HostNamesCsv.Split(',')) {
  if (-not ([string]$candidate).Trim()) { continue }
  $normalized = Assert-SafeHostName -Value ([string]$candidate)
  if (-not $hostNames.Contains($normalized)) { $hostNames.Add($normalized) }
}
$primaryHost = Assert-SafeHostName -Value $PrimaryHost
if (-not $hostNames.Contains($primaryHost)) { $hostNames.Insert(0, $primaryHost) }
foreach ($candidate in @("localhost", "127.0.0.1")) {
  if (-not $hostNames.Contains($candidate)) { $hostNames.Add($candidate) }
}
if ($hostNames.Count -eq 0) { throw "At least one HTTPS certificate host name is required." }

$issuerDir = Join-Path $temporaryDir "issuer"
$clientConfigDir = Join-Path $temporaryDir "client-config"
$metadataPath = Join-Path $temporaryDir "metadata.json"
$serverPfxPath = Join-Path $temporaryDir "server.pfx"
$serverPasswordPath = Join-Path $temporaryDir "server-pfx-passphrase.txt"
$rootCaPemPath = Join-Path $temporaryDir "quickhack-ca.pem"
$previousCaPemPath = Join-Path $temporaryDir "quickhack-previous-ca.pem"
$crossSignedCaPemPath = Join-Path $temporaryDir "quickhack-current-cross-signed.pem"
$serverCertificatePemPath = Join-Path $temporaryDir "server-certificate.pem"
$rootIssuerPrivatePath = Join-Path $issuerDir "root-ca-private.bin"
$manifestPath = Join-Path $clientConfigDir "trust-bundle.json"
$currentClientCaPath = Join-Path $clientConfigDir "quickhack-ca.pem"
$previousClientCaPath = Join-Path $clientConfigDir "quickhack-previous-ca.pem"
$combinedClientCaPath = Join-Path $clientConfigDir "quickhack-ca-bundle.pem"
$serverUrlPath = Join-Path $clientConfigDir "server-url.txt"
$readmePath = Join-Path $clientConfigDir "README.txt"

$rootCertificate = $null
$previousRootCertificate = $null
$serverCertificate = $null
$crossSignedCertificate = $null
$previousIssuerMaterial = $null
$existingMaterial = $null
$rootMaterial = $null
$serverMaterial = $null
$movedExisting = $false
$published = $false
try {
  New-Item -ItemType Directory -Path $securityDir -Force | Out-Null
  New-Item -ItemType Directory -Path $temporaryDir -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path $issuerDir -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path $clientConfigDir -ErrorAction Stop | Out-Null
  Protect-TlsDirectory -Path $temporaryDir

  $createdNewRoot = $false
  if ($hasExistingIssuer) {
    $existingMaterial = if ($issuerPrivateExists) {
      Import-DpapiIssuerMaterial `
        -PrivatePath $existingIssuerPrivate `
        -PublicCertificatePath $existingRootCa
    } else {
      $legacyCertificate = Import-LegacyIssuerCertificate `
        -PfxPath $existingLegacyIssuerPfx `
        -PassphrasePath $existingLegacyIssuerPassword
      [pscustomobject]@{
        Certificate = $legacyCertificate
        Rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey(
          $legacyCertificate
        )
      }
    }
    $storedPublicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $existingRootCa
    )
    try {
      if ((Get-CertificateSha256 $existingMaterial.Certificate) -ne (Get-CertificateSha256 $storedPublicCertificate)) {
        throw "Existing QuickHack public CA does not match its private issuer."
      }
    } finally {
      $storedPublicCertificate.Dispose()
    }
  } else {
    $existingMaterial = $null
  }

  if ($Mode -eq "ROTATE") {
    $previousRootCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $existingRootCa
    )
    $previousIssuerMaterial = $existingMaterial
    $existingMaterial = $null
  }

  if ($Mode -ne "ROTATE" -and $hasExistingIssuer) {
    $rootMaterial = $existingMaterial
    $existingMaterial = $null
    $rootCertificate = $rootMaterial.Certificate
  } else {
    $rootMaterial = New-RootCertificate
    $rootCertificate = $rootMaterial.Certificate
    $createdNewRoot = $true
  }
  if ($Mode -ne "ROTATE" -and $issuerPrivateExists) {
    Copy-Item -LiteralPath $existingIssuerPrivate -Destination $rootIssuerPrivatePath
  } else {
    Export-DpapiIssuerMaterial -Rsa $rootMaterial.Rsa -Path $rootIssuerPrivatePath
  }

  $rootPem = Convert-CertificateToPem -Certificate $rootCertificate
  Write-Utf8WithoutBom -Path $rootCaPemPath -Value $rootPem
  $generatedAt = Get-CanonicalTimestamp
  $rotationNotBefore = ""
  $previousPem = ""
  if ($Mode -eq "ROTATE") {
    $previousPem = Convert-CertificateToPem -Certificate $previousRootCertificate
    $rotationNotBefore = $generatedAt
  } elseif ($Mode -eq "INITIALIZE" -and $rotationActive) {
    $previousPem = Get-Content -LiteralPath $existingPreviousCa -Raw -Encoding UTF8
    $rotationNotBefore = [string]$oldManifest.rotationNotBefore
    if (-not $rotationNotBefore) { throw "Existing QuickHack rotation timestamp is missing." }
  }
  if ($previousPem) { Write-Utf8WithoutBom -Path $previousCaPemPath -Value $previousPem }

  if ($Mode -eq "ROTATE") {
    $crossSignedCertificate = New-CrossSignedCaCertificate `
      -CurrentCertificate $rootCertificate `
      -CurrentRsa $rootMaterial.Rsa `
      -PreviousIssuer $previousRootCertificate `
      -PreviousIssuerRsa $previousIssuerMaterial.Rsa
    Write-Utf8WithoutBom `
      -Path $crossSignedCaPemPath `
      -Value (Convert-CertificateToPem -Certificate $crossSignedCertificate)
  } elseif ($Mode -eq "INITIALIZE" -and $rotationActive) {
    Copy-Item -LiteralPath $existingCrossSignedCa -Destination $crossSignedCaPemPath
    $crossSignedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $existingCrossSignedCa
    )
  }

  $serverMaterial = New-ServerCertificate `
    -Issuer $rootCertificate `
    -IssuerRsa $rootMaterial.Rsa `
    -SubjectHost $primaryHost `
    -HostNames $hostNames
  $serverCertificate = $serverMaterial.Certificate

  $pfxPassphrase = New-RandomPassphrase
  Export-PrivatePfx `
    -Certificate $serverCertificate `
    -Path $serverPfxPath `
    -Passphrase $pfxPassphrase `
    -ChainCertificates $(
      if ($crossSignedCertificate) {
        @($crossSignedCertificate, $previousRootCertificate)
      } else {
        @($rootCertificate)
      }
    )
  Write-Utf8WithoutBom -Path $serverPasswordPath -Value "$pfxPassphrase`r`n"
  Write-Utf8WithoutBom `
    -Path $serverCertificatePemPath `
    -Value (Convert-CertificateToPem -Certificate $serverCertificate)

  $authorityHost = if ($primaryHost.Contains(':')) { "[$primaryHost]" } else { $primaryHost }
  $serverUrl = "https://$authorityHost`:$HttpsPort"
  $currentFingerprint = Get-CertificateSha256 $rootCertificate
  $previousFingerprint = if ($previousPem) {
    $previousPublic = if ($previousRootCertificate) {
      $previousRootCertificate
    } else {
      [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($existingPreviousCa)
    }
    Get-CertificateSha256 $previousPublic
  } else { "" }

  Copy-Item -LiteralPath $rootCaPemPath -Destination $currentClientCaPath
  if ($previousPem) { Write-Utf8WithoutBom -Path $previousClientCaPath -Value $previousPem }
  Write-Utf8WithoutBom -Path $combinedClientCaPath -Value ($rootPem + $previousPem)
  Write-Utf8WithoutBom -Path $serverUrlPath -Value "$serverUrl`r`n"
  Write-Utf8WithoutBom -Path $readmePath -Value @"
QuickHack HTTPS client configuration

Copy this complete directory as one unit. Do not copy server private keys or PFX files.
QuickHack rejects incomplete, mixed-origin, or fingerprint-mismatched bundles.
"@
  $manifest = [ordered]@{
    version = 1
    origin = $serverUrl
    currentCaSha256 = $currentFingerprint
  }
  if ($previousFingerprint) {
    $manifest["previousCaSha256"] = $previousFingerprint
    $manifest["rotationNotBefore"] = $rotationNotBefore
  }
  $manifest["generatedAt"] = $generatedAt
  Write-Utf8WithoutBom -Path $manifestPath -Value (($manifest | ConvertTo-Json -Depth 4) + "`r`n")

  $metadata = [ordered]@{
    schemaVersion = 2
    serverUrl = $serverUrl
    hostNames = @($hostNames)
    primaryHost = $primaryHost
    httpsPort = $HttpsPort
    generatedAt = $generatedAt
    provider = "native-secret"
    createdNewRoot = $createdNewRoot
    currentCaSha256 = $currentFingerprint
  }
  if ($previousFingerprint) {
    $metadata["previousCaSha256"] = $previousFingerprint
    $metadata["rotationNotBefore"] = $rotationNotBefore
  }
  $metadata["rootNotAfter"] = Get-CanonicalTimestamp $rootCertificate.NotAfter
  $metadata["serverNotAfter"] = Get-CanonicalTimestamp $serverCertificate.NotAfter
  Write-Utf8WithoutBom -Path $metadataPath -Value (($metadata | ConvertTo-Json -Depth 4) + "`r`n")

  Protect-TlsDirectory -Path $temporaryDir
  if (Test-Path -LiteralPath $tlsDir) {
    $target = Get-Item -LiteralPath $tlsDir -Force
    if (-not $target.PSIsContainer -or ($target.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "The TLS target is not a safe directory."
    }
    [System.IO.Directory]::Move($tlsDir, $rollbackDir)
    $movedExisting = $true
  }
  [System.IO.Directory]::Move($temporaryDir, $tlsDir)
  $published = $true
  Protect-TlsDirectory -Path $tlsDir
  if ($movedExisting) {
    Remove-Item -LiteralPath $rollbackDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $metadata | ConvertTo-Json -Compress -Depth 4
} catch {
  if ($movedExisting -and -not $published -and -not (Test-Path -LiteralPath $tlsDir)) {
    [System.IO.Directory]::Move($rollbackDir, $tlsDir)
  }
  throw
} finally {
  if ($serverCertificate) { $serverCertificate.Dispose() }
  if ($crossSignedCertificate) { $crossSignedCertificate.Dispose() }
  if ($previousRootCertificate) { $previousRootCertificate.Dispose() }
  if ($previousIssuerMaterial) {
    if ($previousIssuerMaterial.Certificate) { $previousIssuerMaterial.Certificate.Dispose() }
    if ($previousIssuerMaterial.Rsa) { $previousIssuerMaterial.Rsa.Dispose() }
  }
  if ($existingMaterial) {
    if ($existingMaterial.Certificate) { $existingMaterial.Certificate.Dispose() }
    if ($existingMaterial.Rsa) { $existingMaterial.Rsa.Dispose() }
  }
  if ($serverMaterial -and $serverMaterial.Rsa) { $serverMaterial.Rsa.Dispose() }
  if ($rootMaterial) {
    if ($rootMaterial.Certificate) { $rootMaterial.Certificate.Dispose() }
    if ($rootMaterial.Rsa) { $rootMaterial.Rsa.Dispose() }
  } elseif ($rootCertificate) {
    $rootCertificate.Dispose()
  }
  if (Test-Path -LiteralPath $temporaryDir) {
    Remove-Item -LiteralPath $temporaryDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
