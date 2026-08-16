@echo off
setlocal EnableExtensions

title QuickHack Coupang Mock

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "PORT=3100"
set "URL=http://127.0.0.1:%PORT%"
set "HEALTH_URL=%URL%/health"
set "NODE_DIR=%ROOT%\tools\node-portable\node-v24.17.0-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "MOCK_LAUNCHER=%ROOT%\tools\mock-runtime-launcher.mjs"

if not exist "%NODE_EXE%" (
  echo [Coupang Mock] Portable node was not found.
  echo [Coupang Mock] Expected: %NODE_EXE%
  echo.
  if "%~1"=="" pause
  exit /b 1
)

if not exist "%MOCK_LAUNCHER%" (
  echo [Coupang Mock] Mock runtime launcher was not found.
  echo [Coupang Mock] Expected: %MOCK_LAUNCHER%
  echo.
  if "%~1"=="" pause
  exit /b 1
)

pushd "%ROOT%" >nul 2>nul
if errorlevel 1 (
  echo [Coupang Mock] Failed to enter workspace:
  echo [Coupang Mock] %ROOT%
  echo.
  if "%~1"=="" pause
  exit /b 1
)

if /I "%~1"=="start" goto START_ONLY
if /I "%~1"=="restart" goto START_ONLY
if /I "%~1"=="stop" goto STOP_ONLY
if /I "%~1"=="status" goto STATUS_ONLY

:MENU
cls
echo.
echo QuickHack Coupang Mock Server
echo.
echo   1. Start / Restart
echo   2. Stop
echo   3. Status
echo   4. Exit
echo.
"%SystemRoot%\System32\choice.exe" /C 1234 /N /M "Select: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto STATUS_ONLY
if errorlevel 2 goto STOP_ONLY
if errorlevel 1 goto START_ONLY

:START_ONLY
echo.
echo [Coupang Mock] Restarting mock server on %URL%.
echo [Coupang Mock] Workspace: %ROOT%
echo [Coupang Mock] Database: PostgreSQL quickhack_mock_coupang
echo.

call :STOP_PORT

echo [Coupang Mock] Starting mock server in a separate window.
echo [Coupang Mock] Product source: generated synthetic catalog
echo [Coupang Mock] Default generation: order every 30s, return/exchange every 3m.
echo [Coupang Mock] Default API failure simulation: 10%% random failure.
echo.

start "QuickHack Coupang Mock Server" "%SystemRoot%\System32\cmd.exe" /k ""%NODE_EXE%" "%MOCK_LAUNCHER%" coupang --host 127.0.0.1 --port %PORT%"

echo [Coupang Mock] Waiting for mock server...
call :WAIT_FOR_SERVER
if errorlevel 1 (
  echo [Coupang Mock] Mock server did not respond in time.
  echo [Coupang Mock] Check the "QuickHack Coupang Mock Server" window.
  echo.
  if "%~1"=="" pause
  exit /b 1
)

echo [Coupang Mock] Ready: %URL%
echo [Coupang Mock] Failure policy: %URL%/admin/failure-policy
echo.
if "%~1"=="" pause
exit /b 0

:STOP_ONLY
echo.
echo [Coupang Mock] Stopping mock server on port %PORT%.
call :STOP_PORT
echo [Coupang Mock] Done.
echo.
if "%~1"=="" pause
exit /b 0

:STATUS_ONLY
echo.
echo [Coupang Mock] Checking port %PORT%.
"%SystemRoot%\System32\netstat.exe" -ano | "%SystemRoot%\System32\findstr.exe" /R /C:":%PORT% .*LISTENING"
if errorlevel 1 (
  echo [Coupang Mock] No process is listening on port %PORT%.
) else (
  echo.
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 2; $r.Content } catch { 'Health check failed: ' + $_.Exception.Message }"
)
echo.
if "%~1"=="" pause
exit /b 0

:STOP_PORT
for /f "tokens=5" %%P in ('"%SystemRoot%\System32\netstat.exe" -ano ^| "%SystemRoot%\System32\findstr.exe" /R /C:":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    echo [Coupang Mock] Stopping PID %%P on port %PORT%.
    "%SystemRoot%\System32\taskkill.exe" /F /PID %%P >nul 2>nul
  )
)
exit /b 0

:WAIT_FOR_SERVER
for /l %%I in (1,1,30) do (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 1; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 exit /b 0
  "%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul
)
exit /b 1
