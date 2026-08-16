param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,

  [string]$DataDir = "",

  [ValidateSet("DEMONSTRATION_SERVER", "OPERATIONAL_SERVER")]
  [string]$ArtifactKind = "DEMONSTRATION_SERVER",

  [ValidateSet("QuickHackDemoPostgreSQL", "QuickHackOperationalPostgreSQL")]
  [string]$PostgresqlServiceName = "QuickHackDemoPostgreSQL",

  [Parameter(Mandatory = $true)]
  [string]$ProvisionResultPath,

  [ValidateSet("0", "1")]
  [string]$AllowInitialLeaderCreation = "0"
)

$ErrorActionPreference = "Stop"

$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$packageManifestPath = Join-Path $resolvedInstallDir "quickhack-package.json"
if (-not (Test-Path -LiteralPath $packageManifestPath -PathType Leaf)) {
  throw "PACKAGE_ARTIFACT_INVALID: QuickHack package manifest was not found."
}
$packageManifest = Get-Content -LiteralPath $packageManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($packageManifest.schemaVersion -ne 1 -or $packageManifest.artifactKind -cne $ArtifactKind) {
  throw "PACKAGE_FLAVOR_MISMATCH: package manifest does not match the installer target."
}
$configuredDataDir = ([string]$DataDir).Trim()
$dataDir = if ($configuredDataDir) {
  [System.IO.Path]::GetFullPath($configuredDataDir)
} else {
  Join-Path $env:ProgramData "QuickHack"
}
$expectedFlavor = if ($ArtifactKind -eq "DEMONSTRATION_SERVER") { "DEMONSTRATION" } else { "OPERATIONAL" }
$mutableRootName = if ($ArtifactKind -eq "DEMONSTRATION_SERVER") { "demonstration-server" } else { "operational-server" }
$runtimeConfigDir = Join-Path $env:ProgramData "QuickHack\$mutableRootName\config"
$runtimeConfigPath = Join-Path $runtimeConfigDir "server-runtime.json"
$migrationLauncher = Join-Path $resolvedInstallDir "Migrate-Database.cmd"
$nodeExecutable = Join-Path $resolvedInstallDir "runtime\node\node.exe"
$serverDir = Join-Path $resolvedInstallDir "server"
$provisionerPath = Join-Path $serverDir "tools\provision-initial-leader.mjs"
$postgresqlInstallerPath = Join-Path $serverDir "tools\postgresql-service-install.mjs"
$resolvedProvisionResultPath = [System.IO.Path]::GetFullPath($ProvisionResultPath)
$provisionResultDir = Split-Path -Parent $resolvedProvisionResultPath
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar

if (-not $resolvedProvisionResultPath.StartsWith(
  $temporaryRoot,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "The initial leader result path must be inside the Windows temporary directory."
}

if (-not (Test-Path -LiteralPath $migrationLauncher -PathType Leaf)) {
  throw "Database migration launcher was not found: $migrationLauncher"
}

if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  throw "QuickHack server runtime was not found: $nodeExecutable"
}

if (-not (Test-Path -LiteralPath $provisionerPath -PathType Leaf)) {
  throw "Initial leader provisioner was not found: $provisionerPath"
}

if (-not (Test-Path -LiteralPath $postgresqlInstallerPath -PathType Leaf)) {
  throw "PostgreSQL service installer was not found: $postgresqlInstallerPath"
}

function Set-PrivateDirectoryAcl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
  $administrators = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)

  foreach ($identity in @($currentUser, $system, $administrators)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }

  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-PrivateDirectoryAcl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($currentUser, "S-1-5-18", "S-1-5-32-544")
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) {
    throw "QuickHack private directory still inherits access rules: $Path"
  }
  foreach ($entry in $acl.Access) {
    if ($entry.AccessControlType -ne "Allow") {
      continue
    }
    try {
      $sid = $entry.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      $sid = $entry.IdentityReference.Value
    }
    if ($allowed -notcontains $sid) {
      throw "QuickHack private directory contains an unexpected ACL principal: $sid"
    }
  }
}

$isNewDataDir = -not (Test-Path -LiteralPath $dataDir -PathType Container)
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

if ($isNewDataDir) {
  # Existing ACLs are never replaced during an update.
  Set-PrivateDirectoryAcl -Path $dataDir
}
Assert-PrivateDirectoryAcl -Path $dataDir

Set-PrivateDirectoryAcl -Path $provisionResultDir
Set-PrivateDirectoryAcl -Path $runtimeConfigDir
Assert-PrivateDirectoryAcl -Path $provisionResultDir
Assert-PrivateDirectoryAcl -Path $runtimeConfigDir

if (-not (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf)) {
  $runtimeConfig = [ordered]@{
    schemaVersion = 3
    packageFlavor = $expectedFlavor
    environment = "production"
    coupangWriteApiEnabled = $false
    logenWriteApiEnabled = $false
    dataDirectory = $dataDir
    backupRetentionCount = 30
    database = [ordered]@{
      host = "127.0.0.1"
      port = 5432
      name = "quickhack"
      runtimeUser = "quickhack_runtime"
      migratorUser = "quickhack_migrator"
    }
  }
  if ($expectedFlavor -eq "DEMONSTRATION") {
    $runtimeConfig.database.coupangMockName = "quickhack_mock_coupang"
    $runtimeConfig.database.coupangMockUser = "quickhack_mock_coupang"
    $runtimeConfig.database.logenMockName = "quickhack_mock_logen"
    $runtimeConfig.database.logenMockUser = "quickhack_mock_logen"
  }
  $runtimeConfigJson = $runtimeConfig | ConvertTo-Json -Depth 3
  $runtimeConfigTemporaryPath = Join-Path $runtimeConfigDir (
    ".server-runtime.json.{0}.{1}.tmp" -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  )
  try {
    [System.IO.File]::WriteAllText(
      $runtimeConfigTemporaryPath,
      $runtimeConfigJson + [Environment]::NewLine,
      [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $runtimeConfigTemporaryPath -Destination $runtimeConfigPath -Force
  } finally {
    Remove-Item -LiteralPath $runtimeConfigTemporaryPath -Force -ErrorAction SilentlyContinue
  }
}

Push-Location $serverDir
try {
  & $nodeExecutable $postgresqlInstallerPath `
    "--install-dir" $resolvedInstallDir `
    "--data-dir" $dataDir `
    "--runtime-config" $runtimeConfigPath `
    "--service-name" $PostgresqlServiceName
  $postgresqlExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($postgresqlExitCode -ne 0) {
  throw "QuickHack PostgreSQL service initialization failed with exit code $postgresqlExitCode."
}

& $migrationLauncher "--runtime-config" $runtimeConfigPath
if ($LASTEXITCODE -ne 0) {
  throw "QuickHack database migration failed with exit code $LASTEXITCODE."
}

$provisionerArguments = @(
  $provisionerPath,
  "--runtime-config",
  $runtimeConfigPath,
  "--result-file",
  $resolvedProvisionResultPath
)
if ($AllowInitialLeaderCreation -eq "1") {
  $provisionerArguments += "--allow-create"
}

Push-Location $serverDir
try {
  & $nodeExecutable @provisionerArguments
  $provisionExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($provisionExitCode -ne 0) {
  throw "QuickHack initial account provisioning failed with exit code $provisionExitCode."
}

if (-not (Test-Path -LiteralPath $resolvedProvisionResultPath -PathType Leaf)) {
  throw "QuickHack initial account provisioning did not create a result."
}

$resultHeader = Get-Content -LiteralPath $resolvedProvisionResultPath -Encoding utf8 -TotalCount 2
if (
  $resultHeader.Count -ne 2 -or
  $resultHeader[0] -ne "QUICKHACK_INITIAL_LEADER_RESULT_V1" -or
  $resultHeader[1] -notin @("status=CREATED", "status=ALREADY_INITIALIZED")
) {
  throw "QuickHack initial account provisioning returned an invalid result."
}

Write-Host "QuickHack data directory initialized: $dataDir"
Write-Host "QuickHack runtime configuration initialized: $runtimeConfigPath"
Write-Host "QuickHack initial account provisioning completed."
