[CmdletBinding()]
param(
  [string]$DistributionDir = "release\distribution\windows\msix\exact-four",
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)]
  [ValidateSet("AzureArtifactSigning", "CertificateStore")]
  [string]$SigningProvider,
  [string]$SdkRoot = "",
  [string]$NodePath = "",
  [string]$PostgresqlConfigPath = ""
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
if (-not $PostgresqlConfigPath) {
  $PostgresqlConfigPath = Join-Path $repositoryRoot "packaging\windows\postgresql-runtime.json"
}
$postgresqlConfig = Get-Content -LiteralPath $PostgresqlConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
if (
  $postgresqlConfig.schemaVersion -ne 1 -or
  $postgresqlConfig.version -notmatch '^18\.[0-9]+$' -or
  $postgresqlConfig.archiveSha256 -notmatch '^[a-f0-9]{64}$'
) {
  throw "MSIX_POSTGRESQL_PROVENANCE_INVALID: pinned PostgreSQL metadata is invalid."
}
if (-not $NodePath) {
  $NodePath = Get-Command node.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
}
if (-not $NodePath) {
  $NodePath = Get-Command node -ErrorAction Stop |
    Select-Object -ExpandProperty Source -First 1
}

. (Join-Path $PSScriptRoot "resolve-windows-sdk-tools.ps1")
$sdkTools = Resolve-QuickHackWindowsSdkTools -SdkRoot $SdkRoot
$workRoot = Join-Path $releaseRoot "windows\msix\production-finalize"
if (Test-Path -LiteralPath $workRoot) {
  Remove-Item -LiteralPath $workRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

$targets = @(
  [pscustomobject]@{ target = "demo-server"; prefix = "QuickHack-Demo-Server"; launcher = "QuickHack-Demo-Server.exe"; server = $true },
  [pscustomobject]@{ target = "demo-client"; prefix = "QuickHack-Demo-Client"; launcher = "QuickHack-Demo-Client.exe"; server = $false },
  [pscustomobject]@{ target = "operational-server"; prefix = "QuickHack-Operational-Server"; launcher = "QuickHack-Operational-Server.exe"; server = $true },
  [pscustomobject]@{ target = "operational-client"; prefix = "QuickHack-Operational-Client"; launcher = "QuickHack-Operational-Client.exe"; server = $false }
)
$providerName = if ($SigningProvider -eq "AzureArtifactSigning") {
  "AZURE_ARTIFACT_SIGNING"
} else {
  "CA_CERTIFICATE"
}

try {
  foreach ($artifact in $targets) {
    $targetDirectory = Join-Path $distributionPath $artifact.target
    $packagePath = Join-Path $targetDirectory "$($artifact.prefix)-$Version.msix"
    $sidecarPath = Join-Path $targetDirectory "$($artifact.prefix)-msix-manifest-$Version.json"
    $checksumPath = Join-Path $targetDirectory "$($artifact.prefix)-SHA256SUMS.txt"
    foreach ($requiredPath in @($packagePath, $sidecarPath, $checksumPath)) {
      if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "MSIX_PRODUCTION_INPUT_MISSING: exact-four input is incomplete for $($artifact.target)."
      }
    }
    $unsignedSidecar = Get-Content -LiteralPath $sidecarPath -Raw -Encoding utf8 | ConvertFrom-Json
    if (
      $unsignedSidecar.schemaVersion -ne 1 -or
      $unsignedSidecar.packageTarget -ne $artifact.target -or
      $unsignedSidecar.semanticVersion -ne $Version -or
      $unsignedSidecar.publisher -ne $Publisher -or
      $unsignedSidecar.signingMode -ne "UNSIGNED" -or
      $unsignedSidecar.sourceDirty
    ) {
      throw "MSIX_PRODUCTION_INPUT_INVALID: unsigned sidecar is not a clean production input for $($artifact.target)."
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $packagePath
    if (
      [string]$signature.Status -ne "Valid" -or
      -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -ne $Publisher -or
      -not $signature.TimeStamperCertificate
    ) {
      throw "PACKAGE_SIGNATURE_INVALID: signature, Publisher, or RFC 3161 timestamp is invalid for $($artifact.target)."
    }
    $null = & $sdkTools.SignTool verify /pa /all /v $packagePath 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "PACKAGE_SIGNATURE_INVALID: SignTool verification failed for $($artifact.target)."
    }

    $unpackedPath = Join-Path $workRoot $artifact.target
    New-Item -ItemType Directory -Path $unpackedPath -Force | Out-Null
    $null = & $sdkTools.MakeAppx unpack /o /p $packagePath /d $unpackedPath 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "MSIX_PRODUCTION_UNPACK_FAILED: MakeAppx failed for $($artifact.target)."
    }
    $verifyArguments = @(
      (Join-Path $repositoryRoot "tools\verify-msix-package.mjs"),
      "--directory=$unpackedPath",
      "--target=$($artifact.target)",
      "--version=$Version",
      "--publisher=$Publisher",
      "--signature-mode=PRODUCTION"
    )
    if ($artifact.server) { $verifyArguments += @("--include-services", "--include-server-setup") }
    & $NodePath @verifyArguments
    if ($LASTEXITCODE -ne 0) {
      throw "MSIX_PRODUCTION_CONTENT_INVALID: unpacked verifier failed for $($artifact.target)."
    }

    $buildEvidence = Get-Content -LiteralPath (Join-Path $unpackedPath "quickhack-msix-build.json") -Raw -Encoding utf8 | ConvertFrom-Json
    $packageManifest = Get-Content -LiteralPath (Join-Path $unpackedPath "quickhack-package.json") -Raw -Encoding utf8 | ConvertFrom-Json
    $nodeRuntime = Get-Content -LiteralPath (Join-Path $unpackedPath "runtime\node\quickhack-node-runtime.json") -Raw -Encoding utf8 | ConvertFrom-Json
    $visualManifest = Get-Content -LiteralPath (Join-Path $unpackedPath "Assets\visual-assets.manifest.json") -Raw -Encoding utf8 | ConvertFrom-Json
    if (
      $buildEvidence.sourceCommit -ne $unsignedSidecar.sourceCommit -or
      $buildEvidence.sourceDirty -or
      $nodeRuntime.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or
      $packageManifest.contentInventorySha256 -notmatch '^[a-f0-9]{64}$'
    ) {
      throw "MSIX_PRODUCTION_PROVENANCE_INVALID: embedded provenance is incomplete for $($artifact.target)."
    }

    $iconEvidencePath = Join-Path $workRoot "$($artifact.target)-pe-icon.json"
    & (Join-Path $PSScriptRoot "verify-pe-icon.ps1") `
      -ExecutablePath (Join-Path $unpackedPath $artifact.launcher) `
      -EvidencePath $iconEvidencePath
    $iconEvidence = Get-Content -LiteralPath $iconEvidencePath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($iconEvidence.status -ne "PASS") {
      throw "BRANDING_REVISION_MISMATCH: PE icon verification did not pass for $($artifact.target)."
    }

    $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash.ToLowerInvariant()
    $productionSidecar = [ordered]@{
      schemaVersion = 2
      packageTarget = $artifact.target
      artifactKind = [string]$buildEvidence.artifactKind
      semanticVersion = $Version
      msixVersion = [string]$buildEvidence.msixVersion
      identityName = [string]$buildEvidence.identityName
      publisher = $Publisher
      signingMode = "PRODUCTION"
      signingProvider = $providerName
      sourceCommit = [string]$buildEvidence.sourceCommit
      sourceDirty = $false
      packageFile = [IO.Path]::GetFileName($packagePath)
      packageSha256 = $packageHash
      stagingInventorySha256 = [string]$buildEvidence.stagingInventorySha256
      packageContentInventorySha256 = [string]$packageManifest.contentInventorySha256
      brandingRevision = [string]$buildEvidence.brandingRevision
      visualAssetManifestSha256 = [string]$buildEvidence.visualAssetManifestSha256
      canonicalIconSha256 = [string]$iconEvidence.canonicalIconSha256
      compiledIcon = [ordered]@{
        executableSha256 = [string]$iconEvidence.executableSha256
        width = [int]$iconEvidence.width
        height = [int]$iconEvidence.height
        pixelSha256 = [string]$iconEvidence.pixelSha256
      }
      nodeRuntime = [ordered]@{
        version = [string]$nodeRuntime.version
        archiveSha256 = [string]$nodeRuntime.archiveSha256
      }
      postgresqlRuntime = if ($artifact.server) {
        [ordered]@{
          version = [string]$postgresqlConfig.version
          archiveSha256 = [string]$postgresqlConfig.archiveSha256
        }
      } else { $null }
      signature = [ordered]@{
        status = "VALID"
        subject = [string]$signature.SignerCertificate.Subject
        thumbprint = ([string]$signature.SignerCertificate.Thumbprint).ToLowerInvariant()
        notBefore = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString("o")
        notAfter = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString("o")
        timestampVerified = $true
        timestampSubject = [string]$signature.TimeStamperCertificate.Subject
        timestampThumbprint = ([string]$signature.TimeStamperCertificate.Thumbprint).ToLowerInvariant()
      }
    }
    $productionSidecar | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sidecarPath -Encoding utf8
    $sidecarHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sidecarPath).Hash.ToLowerInvariant()
    @(
      "$packageHash  $([IO.Path]::GetFileName($packagePath))",
      "$sidecarHash  $([IO.Path]::GetFileName($sidecarPath))"
    ) | Set-Content -LiteralPath $checksumPath -Encoding ascii
  }

  & $NodePath `
    (Join-Path $PSScriptRoot "four-artifact-distribution.mjs") `
    "--directory=$distributionPath" `
    "--version=$Version" `
    "--publisher=$Publisher" `
    --require-production
  if ($LASTEXITCODE -ne 0) {
    throw "MSIX_PRODUCTION_SET_INVALID: exact-four production verification failed."
  }
} finally {
  if (Test-Path -LiteralPath $workRoot) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force
  }
}

Write-Host "QuickHack exact-four production MSIX metadata finalized."
