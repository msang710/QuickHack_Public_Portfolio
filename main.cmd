@echo off
setlocal EnableExtensions

title QuickHack Client

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "RUNTIME_NODE_EXE=%ROOT%\runtime\node\node.exe"
set "SOURCE_NODE_EXE=%ROOT%\tools\node-portable\node-v24.17.0-win-x64\node.exe"
set "NODE_EXE="
if exist "%RUNTIME_NODE_EXE%" set "NODE_EXE=%RUNTIME_NODE_EXE%"
if not defined NODE_EXE if exist "%SOURCE_NODE_EXE%" set "NODE_EXE=%SOURCE_NODE_EXE%"
set "CLIENT_LAUNCHER=%ROOT%\tools\client-runtime-launcher.mjs"

if not defined NODE_EXE (
  echo [QuickHack Client] Portable Node was not found.
  echo [QuickHack Client] Expected one of:
  echo [QuickHack Client] %RUNTIME_NODE_EXE%
  echo [QuickHack Client] %SOURCE_NODE_EXE%
  echo.
  pause
  exit /b 1
)

if not exist "%CLIENT_LAUNCHER%" (
  echo [QuickHack Client] Client runtime launcher was not found.
  echo [QuickHack Client] Expected: %CLIENT_LAUNCHER%
  echo.
  pause
  exit /b 1
)

set "URL=http://127.0.0.1:3001"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

if /I "%~1"=="status" goto STATUS_ONLY
if /I "%~1"=="stop" goto STOP_ONLY
if /I "%~1"=="restart" goto RESTART_CLIENT
if /I "%~1"=="start" goto START_CLIENT
if not "%~1"=="" goto UNKNOWN_COMMAND

:START_CLIENT
echo.
echo [QuickHack Client] Starting the local client runtime.
"%NODE_EXE%" "%CLIENT_LAUNCHER%" start
if errorlevel 1 goto LAUNCH_FAILED
echo [QuickHack Client] Opening: %URL%
echo [QuickHack Client] The central server remains managed by server-console.cmd.
echo.
call :OPEN_BROWSER
exit /b 0

:RESTART_CLIENT
"%NODE_EXE%" "%CLIENT_LAUNCHER%" restart
if errorlevel 1 goto LAUNCH_FAILED
call :OPEN_BROWSER
exit /b 0

:STOP_ONLY
"%NODE_EXE%" "%CLIENT_LAUNCHER%" stop
if errorlevel 1 goto LAUNCH_FAILED
exit /b 0

:STATUS_ONLY
"%NODE_EXE%" "%CLIENT_LAUNCHER%" status
if errorlevel 1 goto LAUNCH_FAILED
exit /b 0

:UNKNOWN_COMMAND
echo [QuickHack Client] Unknown command: %~1
echo [QuickHack Client] Supported commands: start, restart, stop, status
exit /b 1

:LAUNCH_FAILED
echo.
echo [QuickHack Client] Failed to start or control the local client runtime.
echo [QuickHack Client] The central server must be started separately with server-console.cmd.
echo.
pause
exit /b 1

:OPEN_BROWSER
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --start-maximized
  exit /b 0
)

if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL% --start-maximized
  exit /b 0
)

start "" "%URL%"
exit /b 0
