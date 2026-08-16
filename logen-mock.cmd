@echo off
setlocal EnableExtensions

title QuickHack Logen Mock

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE_EXE=%ROOT%\tools\node-portable\node-v24.17.0-win-x64\node.exe"
set "MOCK_LAUNCHER=%ROOT%\tools\mock-runtime-launcher.mjs"

if not exist "%NODE_EXE%" (
  echo [Logen Mock] Portable Node was not found:
  echo %NODE_EXE%
  pause
  exit /b 1
)

if not exist "%MOCK_LAUNCHER%" (
  echo [Logen Mock] Mock runtime launcher was not found:
  echo %MOCK_LAUNCHER%
  pause
  exit /b 1
)

cd /d "%ROOT%"

echo.
echo QuickHack Logen Mock Server
echo URL: http://127.0.0.1:3200
echo Test secretKey: LOGEN-MOCK-TEST-SECRET
echo Press Ctrl+C to stop.
echo.

"%NODE_EXE%" "%MOCK_LAUNCHER%" logen --host 127.0.0.1 --port 3200
if errorlevel 1 pause
