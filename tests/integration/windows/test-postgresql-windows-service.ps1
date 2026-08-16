param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDir
)

$ErrorActionPreference = "Stop"
$serviceName = "QuickHackPostgreSQL"
$resolvedPackageDir = [System.IO.Path]::GetFullPath($PackageDir)
$programDataRoot = [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\') + '\'
$smokeBase = [System.IO.Path]::GetFullPath(
  (Join-Path $env:ProgramData "QuickHack-CI")
)
$smokeBasePrefix = $smokeBase.TrimEnd('\') + '\'
$smokeRoot = Join-Path $smokeBase ("postgresql-smoke-" + [Guid]::NewGuid().ToString("N"))
$smokeInstallDir = Join-Path $smokeRoot "install"
$dataDir = Join-Path $smokeRoot "data"
$configDir = Join-Path $smokeRoot "config"
$runtimeConfigPath = Join-Path $configDir "server-runtime.json"
$node = Join-Path $resolvedPackageDir "runtime\node\node.exe"
$serviceInstaller = Join-Path $resolvedPackageDir "server\tools\postgresql-service-install.mjs"
$backupTool = Join-Path $resolvedPackageDir "server\tools\postgresql-backup.mjs"
$restoreTool = Join-Path $resolvedPackageDir "server\tools\postgresql-restore.mjs"
$migrationLauncher = Join-Path $resolvedPackageDir "Migrate-Database.cmd"
$auditTool = Join-Path $resolvedPackageDir "server\tools\audit-postgresql-schema.mjs"
$roleContractTool = Join-Path $resolvedPackageDir "server\tools\verify-postgresql-operational-roles.mjs"
$sourcePostgresqlRuntime = Join-Path $resolvedPackageDir "runtime\postgresql"
$smokePostgresqlRuntime = Join-Path $smokeInstallDir "runtime\postgresql"
$pgCtl = Join-Path $smokePostgresqlRuntime "bin\pg_ctl.exe"

if (-not $smokeBasePrefix.StartsWith($programDataRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The PostgreSQL smoke base escaped ProgramData."
}
if (-not $smokeRoot.StartsWith($smokeBasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The PostgreSQL smoke directory escaped its isolated base."
}
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  throw "The fixed QuickHack PostgreSQL smoke service already exists."
}
if (-not (Test-Path -LiteralPath $sourcePostgresqlRuntime -PathType Container)) {
  throw "The staged PostgreSQL runtime was not found."
}

$listener = [System.Net.Sockets.TcpListener]::new(
  [System.Net.IPAddress]::Loopback,
  0
)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

New-Item -ItemType Directory -Path $dataDir, $configDir, (Split-Path -Parent $smokePostgresqlRuntime) -Force | Out-Null
Copy-Item -LiteralPath $sourcePostgresqlRuntime -Destination $smokePostgresqlRuntime -Recurse -Force
$runtimeConfig = [ordered]@{
  schemaVersion = 3
  packageFlavor = "DEMONSTRATION"
  environment = "production"
  coupangWriteApiEnabled = $false
  logenWriteApiEnabled = $false
  dataDirectory = $dataDir
  backupRetentionCount = 2
  database = [ordered]@{
    host = "127.0.0.1"
    port = $port
    name = "quickhack"
    runtimeUser = "quickhack_runtime"
    migratorUser = "quickhack_migrator"
    coupangMockName = "quickhack_mock_coupang"
    coupangMockUser = "quickhack_mock_coupang"
    logenMockName = "quickhack_mock_logen"
    logenMockUser = "quickhack_mock_logen"
  }
}
[System.IO.File]::WriteAllText(
  $runtimeConfigPath,
  ($runtimeConfig | ConvertTo-Json -Depth 3) + [Environment]::NewLine,
  [System.Text.UTF8Encoding]::new($false)
)

$env:NODE_ENV = "production"
Get-ChildItem Env:QUICKHACK_TEST_* -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }

try {
  & $node $serviceInstaller `
    "--install-dir" $smokeInstallDir `
    "--data-dir" $dataDir `
    "--runtime-config" $runtimeConfigPath
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL service installation smoke failed." }

  & $migrationLauncher "--runtime-config" $runtimeConfigPath
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL migration smoke failed." }

  Push-Location (Join-Path $resolvedPackageDir "server")
  try {
    & $node $auditTool "--runtime-config" $runtimeConfigPath
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL schema audit smoke failed." }
    & $node $roleContractTool "--runtime-config" $runtimeConfigPath
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL operational role smoke failed." }
    & $node $backupTool create `
      "--install-dir" $smokeInstallDir `
      "--runtime-config" $runtimeConfigPath
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup smoke failed." }
    & $node $backupTool verify `
      "--install-dir" $smokeInstallDir `
      "--runtime-config" $runtimeConfigPath
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup verification smoke failed." }
    $backup = Get-ChildItem -LiteralPath (Join-Path $dataDir "backups") -Filter "*.qhb" |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if (-not $backup) { throw "PostgreSQL smoke backup was not published." }
    & $node $restoreTool `
      "--install-dir" $smokeInstallDir `
      "--runtime-config" $runtimeConfigPath `
      "--backup-file" $backup.Name
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL staged restore smoke failed." }
    & $node $auditTool "--runtime-config" $runtimeConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Restored PostgreSQL schema audit smoke failed." }
  } finally {
    Pop-Location
  }
} finally {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne "Stopped") {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
  }
  if ($service -and (Test-Path -LiteralPath $pgCtl -PathType Leaf)) {
    $cleanupErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $pgCtl unregister "-N" $serviceName 2>$null
    $ErrorActionPreference = $cleanupErrorActionPreference
  }
  $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
  if ($resolvedSmokeRoot.StartsWith($smokeBasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ((Test-Path -LiteralPath $smokeBase -PathType Container) -and
      -not (Get-ChildItem -LiteralPath $smokeBase -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $smokeBase -Force -ErrorAction SilentlyContinue
  }
}
