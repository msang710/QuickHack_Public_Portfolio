[CmdletBinding()]
param(
  [ValidateSet("demo-server", "demo-client", "operational-server", "operational-client")]
  [string]$Target = "demo-server",

  [string]$Version = "",

  [string]$SourceDir = "",

  [string]$OutputDir = "",

  [string]$Publisher = "CN=QuickHack Development",

  [ValidateSet("Unsigned", "TestCertificate", "Pfx")]
  [string]$SigningMode = "Unsigned",

  [string]$PfxPath = "",

  [string]$PfxPasswordEnvironmentVariable = "QUICKHACK_MSIX_PFX_PASSWORD",

  [string]$SdkRoot = "",

  [string]$VisualAssetsDir = "",

  [string]$NodePath = "",

  [switch]$IncludeServices,

  [switch]$AllowPreviewServices,

  [switch]$Preview,

  [string]$TestCertificateCerPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Split-Path -Parent $PSScriptRoot)
)
$nodeExecutable = $NodePath
if (-not $nodeExecutable) {
  $nodeExecutable = Get-Command node.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
}
if (-not $nodeExecutable) {
  $nodeExecutable = Get-Command node -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -First 1
}
if (-not $nodeExecutable -or -not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  throw "Node.js was not found for the MSIX build."
}

if (-not $Version) {
  $Version = (
    Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw -Encoding utf8 |
      ConvertFrom-Json
  ).version
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "Invalid semantic version for MSIX: $Version"
}

$filePrefix = switch ($Target) {
  "demo-server" { "QuickHack-Demo-Server" }
  "demo-client" { "QuickHack-Demo-Client" }
  "operational-server" { "QuickHack-Operational-Server" }
  "operational-client" { "QuickHack-Operational-Client" }
}
if ($Preview) {
  if ($Target -ne "demo-server") {
    throw "The QuickHack packaged-service preview is only valid for demo-server."
  }
  $filePrefix = "QuickHack-Preview-Demo-Server"
}
if (-not $SourceDir) {
  $SourceDir = "release\windows\$Target"
}
if (-not $OutputDir) {
  $OutputDir = "release\distribution\windows\msix\$Target"
}
if (-not $VisualAssetsDir) {
  $VisualAssetsDir = "release\windows\msix\visual-assets"
}

$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $SourceDir))
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
$visualAssetsPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $VisualAssetsDir))
$allowedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "release"))
if (
  $outputPath -eq $allowedOutputRoot -or
  -not $outputPath.StartsWith(
    $allowedOutputRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "MSIX output must be a descendant of the repository release directory."
}

function Remove-QuickHackReleaseDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (
    $fullPath -eq $allowedOutputRoot -or
    -not $fullPath.StartsWith(
      $allowedOutputRoot + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to remove a directory outside QuickHack release/: $fullPath"
  }
  $longPath = if ($fullPath.StartsWith("\\?\")) { $fullPath } else { "\\?\$fullPath" }
  if ([System.IO.Directory]::Exists($longPath)) {
    [System.IO.Directory]::Delete($longPath, $true)
  }
}

function Remove-QuickHackCurrentUserCertificate {
  param(
    [Parameter(Mandatory = $true)][string]$StoreName,
    [Parameter(Mandatory = $true)][string]$Thumbprint
  )
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    $StoreName,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    foreach ($certificate in @($store.Certificates.Find(
      [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $Thumbprint,
      $false
    ))) {
      $store.Remove($certificate)
    }
  } finally {
    $store.Close()
  }
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
  throw "QuickHack staging package was not found: $sourcePath"
}

. (Join-Path $PSScriptRoot "windows\msix\resolve-windows-sdk-tools.ps1")
$sdkTools = Resolve-QuickHackWindowsSdkTools -SdkRoot $SdkRoot

& (Join-Path $PSScriptRoot "windows\msix\generate-visual-assets.ps1") `
  -OutputDir $visualAssetsPath
& (Join-Path $PSScriptRoot "windows\msix\verify-visual-assets.ps1") `
  -AssetsDir $visualAssetsPath

if (Test-Path -LiteralPath $outputPath) {
  Remove-QuickHackReleaseDirectory -Path $outputPath
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$workPath = Join-Path $outputPath ".work"
$layoutPath = Join-Path $workPath "layout"
$unpackedPath = Join-Path $workPath "unpacked"

$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') {
  throw "Unable to resolve the source Git commit for the MSIX build."
}
$sourceDirty = [bool](@(& git -C $repositoryRoot status --porcelain).Count)

$layoutArguments = @(
  (Join-Path $PSScriptRoot "windows\msix\create-msix-layout.mjs"),
  "--target=$Target",
  "--version=$Version",
  "--publisher=$Publisher",
  "--source-dir=$sourcePath",
  "--output-dir=$layoutPath",
  "--visual-assets-dir=$visualAssetsPath",
  "--source-commit=$sourceCommit"
)
if ($sourceDirty) { $layoutArguments += "--source-dirty" }
if ($IncludeServices) { $layoutArguments += "--include-services" }
if ($AllowPreviewServices) { $layoutArguments += "--allow-preview-services" }
if ($Preview) { $layoutArguments += "--preview" }
& $nodeExecutable @layoutArguments
if ($LASTEXITCODE -ne 0) {
  throw "QuickHack MSIX layout creation failed."
}

$packagePath = Join-Path $outputPath "$filePrefix-$Version.msix"
$sidecarPath = Join-Path $outputPath "$filePrefix-msix-manifest-$Version.json"
$checksumPath = Join-Path $outputPath "$filePrefix-SHA256SUMS.txt"
$testCertificate = $null
$trustedCertificate = $null
$exportedCertificatePath = Join-Path $workPath "test-signing.cer"

try {
  & $sdkTools.MakeAppx pack /o /h SHA256 /d $layoutPath /p $packagePath | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "MakeAppx failed to create the QuickHack $Target package."
  }

  switch ($SigningMode) {
    "TestCertificate" {
      $testCertificate = New-SelfSignedCertificate `
        -Type Custom `
        -Subject $Publisher `
        -KeyUsage DigitalSignature `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @(
          "2.5.29.37={text}1.3.6.1.5.5.7.3.3",
          "2.5.29.19={text}"
        ) `
        -FriendlyName "QuickHack ephemeral MSIX test signing"
      Export-Certificate `
        -Cert $testCertificate `
        -FilePath $exportedCertificatePath `
        -Type CERT | Out-Null
      if ($TestCertificateCerPath) {
        $requestedCertificatePath = [System.IO.Path]::GetFullPath(
          (Join-Path $repositoryRoot $TestCertificateCerPath)
        )
        if (-not $requestedCertificatePath.StartsWith(
          $allowedOutputRoot + [System.IO.Path]::DirectorySeparatorChar,
          [System.StringComparison]::OrdinalIgnoreCase
        )) {
          throw "The test certificate output must be a descendant of repository release/."
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $requestedCertificatePath) -Force | Out-Null
        Copy-Item -LiteralPath $exportedCertificatePath -Destination $requestedCertificatePath -Force
      }
      & "$env:WINDIR\System32\certutil.exe" `
        -user `
        -f `
        -addstore `
        Root `
        $exportedCertificatePath | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "The QuickHack test certificate could not be trusted temporarily."
      }
      $trustedCertificate = $testCertificate.Thumbprint
      & $sdkTools.SignTool sign /fd SHA256 /sha1 $testCertificate.Thumbprint $packagePath
      if ($LASTEXITCODE -ne 0) {
        throw "SignTool failed to apply the QuickHack test signature."
      }
      & $sdkTools.SignTool verify /pa /v $packagePath
      if ($LASTEXITCODE -ne 0) {
        throw "SignTool could not verify the QuickHack test signature."
      }
    }
    "Pfx" {
      if (-not $PfxPath -or -not (Test-Path -LiteralPath $PfxPath -PathType Leaf)) {
        throw "-PfxPath is required for Pfx signing mode."
      }
      if ($PfxPasswordEnvironmentVariable -notmatch '^[A-Z][A-Z0-9_]{2,127}$') {
        throw "Invalid PFX password environment variable name."
      }
      $password = [System.Environment]::GetEnvironmentVariable($PfxPasswordEnvironmentVariable)
      if (-not $password) {
        throw "The PFX password environment variable is empty."
      }
      & $sdkTools.SignTool sign /fd SHA256 /f $PfxPath /p $password $packagePath
      $password = $null
      if ($LASTEXITCODE -ne 0) {
        throw "SignTool failed to apply the supplied QuickHack signature."
      }
      & $sdkTools.SignTool verify /pa /v $packagePath
      if ($LASTEXITCODE -ne 0) {
        throw "SignTool could not verify the supplied QuickHack signature."
      }
    }
  }

  New-Item -ItemType Directory -Path $unpackedPath -Force | Out-Null
  & $sdkTools.MakeAppx unpack /o /p $packagePath /d $unpackedPath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed to unpack the QuickHack $Target package."
  }
  $verifyArguments = @(
    (Join-Path $repositoryRoot "tools\verify-msix-package.mjs"),
    "--directory=$unpackedPath",
    "--target=$Target",
    "--version=$Version",
    "--publisher=$Publisher",
    "--signature-mode=$($SigningMode.ToUpperInvariant())"
  )
  if ($IncludeServices) { $verifyArguments += "--include-services" }
  if ($Preview) { $verifyArguments += "--preview" }
  & $nodeExecutable @verifyArguments
  if ($LASTEXITCODE -ne 0) {
    throw "QuickHack MSIX unpacked-package verification failed."
  }

  $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash.ToLowerInvariant()
  $sidecar = [ordered]@{
    schemaVersion = 1
    packageTarget = $Target
    semanticVersion = $Version
    publisher = $Publisher
    signingMode = $SigningMode.ToUpperInvariant()
    sourceCommit = $sourceCommit
    sourceDirty = $sourceDirty
    packageFile = [System.IO.Path]::GetFileName($packagePath)
    packageSha256 = $packageHash
  }
  $sidecar | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sidecarPath -Encoding utf8
  $sidecarHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sidecarPath).Hash.ToLowerInvariant()
  @(
    "$packageHash  $([System.IO.Path]::GetFileName($packagePath))",
    "$sidecarHash  $([System.IO.Path]::GetFileName($sidecarPath))"
  ) | Set-Content -LiteralPath $checksumPath -Encoding ascii
} finally {
  if ($trustedCertificate) {
    Remove-QuickHackCurrentUserCertificate -StoreName Root -Thumbprint $trustedCertificate
  }
  if ($testCertificate) {
    Remove-QuickHackCurrentUserCertificate -StoreName My -Thumbprint $testCertificate.Thumbprint
  }
  if (Test-Path -LiteralPath $workPath) {
    Remove-QuickHackReleaseDirectory -Path $workPath
  }
}

Write-Host "QuickHack $Target MSIX distribution created:"
Get-Item -LiteralPath $packagePath, $sidecarPath, $checksumPath |
  Select-Object Name,Length,LastWriteTime |
  Format-Table -AutoSize
