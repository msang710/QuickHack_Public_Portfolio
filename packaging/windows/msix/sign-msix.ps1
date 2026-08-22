[CmdletBinding()]
param(
  [string]$DistributionDir = "release\distribution\windows\msix\exact-four",
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)]
  [ValidateSet("AzureArtifactSigning", "CertificateStore")]
  [string]$Provider,
  [string]$CertificateThumbprint = "",
  [string]$TimestampUrl = "http://timestamp.acs.microsoft.com",
  [string]$SdkRoot = "",
  [string]$NodePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
$distributionPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $DistributionDir))
if (
  $distributionPath -eq $releaseRoot -or
  -not $distributionPath.StartsWith(
    $releaseRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "MSIX_PRODUCTION_OUTPUT_UNSAFE: distribution must be below repository release/."
}
if ($Publisher -eq "CN=QuickHack Development" -or $Publisher -notmatch '^CN=[^,=][^,]*(?:,\s*[A-Z][A-Z0-9.]*=[^,=][^,]*)*$') {
  throw "MSIX_PRODUCTION_PUBLISHER_REQUIRED: a non-development X.500 Publisher is required."
}
$packages = @(Get-ChildItem -LiteralPath $distributionPath -Filter "*.msix" -File -Recurse)
if ($packages.Count -ne 4) {
  throw "MSIX_PRODUCTION_INPUT_INVALID: signing requires exactly four MSIX files."
}

if ($Provider -eq "CertificateStore") {
  $normalizedThumbprint = $CertificateThumbprint.Replace(" ", "").ToUpperInvariant()
  if ($normalizedThumbprint -notmatch '^[A-F0-9]{40}$') {
    throw "MSIX_PRODUCTION_CERTIFICATE_INVALID: exact certificate thumbprint is required."
  }
  $matches = @()
  foreach ($storePath in @("Cert:\CurrentUser\My", "Cert:\LocalMachine\My")) {
    foreach ($certificate in @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue)) {
      if ($certificate.Thumbprint -eq $normalizedThumbprint) {
        $matches += [pscustomobject]@{ certificate = $certificate; storePath = $storePath }
      }
    }
  }
  if ($matches.Count -ne 1) {
    throw "MSIX_PRODUCTION_CERTIFICATE_INVALID: certificate thumbprint must resolve exactly once."
  }
  $selected = $matches[0]
  $certificate = $selected.certificate
  $codeSigningEku = @($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq "1.3.6.1.5.5.7.3.3" }).Count
  if (
    $certificate.Subject -ne $Publisher -or
    -not $certificate.HasPrivateKey -or
    $certificate.Subject -eq $certificate.Issuer -or
    $codeSigningEku -ne 1 -or
    $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow
  ) {
    throw "MSIX_PRODUCTION_CERTIFICATE_INVALID: approved CA code-signing certificate contract failed."
  }
  if ($TimestampUrl -notmatch '^https?://[^\s]+$') {
    throw "MSIX_PRODUCTION_TIMESTAMP_INVALID: RFC 3161 timestamp URL is invalid."
  }
  . (Join-Path $PSScriptRoot "resolve-windows-sdk-tools.ps1")
  $sdkTools = Resolve-QuickHackWindowsSdkTools -SdkRoot $SdkRoot
  foreach ($package in $packages) {
    $arguments = @("sign", "/fd", "SHA256", "/sha1", $normalizedThumbprint)
    if ($selected.storePath -eq "Cert:\LocalMachine\My") { $arguments += "/sm" }
    $arguments += @("/tr", $TimestampUrl, "/td", "SHA256", $package.FullName)
    $null = & $sdkTools.SignTool @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "PACKAGE_SIGNATURE_INVALID: approved CA signing failed."
    }
  }
} elseif ($CertificateThumbprint) {
  throw "MSIX_PRODUCTION_CERTIFICATE_INVALID: Azure signing must not receive a local certificate selector."
}

& (Join-Path $PSScriptRoot "finalize-production-msix.ps1") `
  -DistributionDir $DistributionDir `
  -Version $Version `
  -Publisher $Publisher `
  -SigningProvider $Provider `
  -SdkRoot $SdkRoot `
  -NodePath $NodePath

Write-Host "QuickHack production MSIX signing adapter completed with provider $Provider."
