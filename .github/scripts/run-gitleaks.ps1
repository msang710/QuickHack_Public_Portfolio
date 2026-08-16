param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "8.30.1"
$isWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
$isLinuxPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Linux
)

if ($isWindowsPlatform) {
    $archiveName = "gitleaks_${version}_windows_x64.zip"
    $expectedSha256 = "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e"
    $executableName = "gitleaks.exe"
    $archiveFormat = "zip"
}
elseif ($isLinuxPlatform) {
    $archiveName = "gitleaks_${version}_linux_x64.tar.gz"
    $expectedSha256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    $executableName = "gitleaks"
    $archiveFormat = "tar.gz"
}
else {
    throw "Gitleaks history scanning supports only Windows x64 and Linux x64 runners."
}

$downloadUrl = "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archiveName}"
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$installRoot = Join-Path $tempBase ("quickhack-gitleaks-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $installRoot $archiveName

New-Item -ItemType Directory -Path $installRoot | Out-Null

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "Gitleaks archive checksum mismatch."
    }

    if ($archiveFormat -eq "zip") {
        Expand-Archive -LiteralPath $archivePath -DestinationPath $installRoot -Force
    }
    else {
        $tarCommand = Get-Command "tar" -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        & $tarCommand.Source -xzf $archivePath -C $installRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Gitleaks archive extraction failed."
        }
    }

    $gitleaksPath = Join-Path $installRoot $executableName
    if (-not (Test-Path -LiteralPath $gitleaksPath -PathType Leaf)) {
        throw "Gitleaks executable was not found after extraction."
    }

    Push-Location $RepositoryRoot
    try {
        & $gitleaksPath git . --config ".gitleaks.toml" --redact --no-banner --verbose
        $scanExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($scanExitCode -ne 0) {
        exit $scanExitCode
    }
}
finally {
    if (Test-Path -LiteralPath $installRoot) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force
    }
}
