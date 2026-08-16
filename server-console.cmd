@echo off
setlocal EnableExtensions

title QuickHack Server Console

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "RUNTIME_NODE_EXE=%ROOT%\runtime\node\node.exe"
set "SOURCE_NODE_EXE=%ROOT%\tools\node-portable\node-v24.17.0-win-x64\node.exe"
set "NODE_EXE="
if exist "%RUNTIME_NODE_EXE%" set "NODE_EXE=%RUNTIME_NODE_EXE%"
if not defined NODE_EXE if exist "%SOURCE_NODE_EXE%" set "NODE_EXE=%SOURCE_NODE_EXE%"
set "CONSOLE_SCRIPT=%ROOT%\tools\server-console.mjs"

if not defined NODE_EXE (
  echo [QuickHack Console] Portable node was not found.
  echo [QuickHack Console] Expected one of:
  echo [QuickHack Console] %RUNTIME_NODE_EXE%
  echo [QuickHack Console] %SOURCE_NODE_EXE%
  echo.
  pause
  exit /b 1
)

if not exist "%CONSOLE_SCRIPT%" (
  echo [QuickHack Console] Console script was not found.
  echo [QuickHack Console] Expected: %CONSOLE_SCRIPT%
  echo.
  pause
  exit /b 1
)

for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
if "%NODE_DIR:~-1%"=="\" set "NODE_DIR=%NODE_DIR:~0,-1%"
set "PATH=%NODE_DIR%;%PATH%"

pushd "%ROOT%" >nul 2>nul
if errorlevel 1 (
  echo [QuickHack Console] Failed to enter workspace:
  echo [QuickHack Console] %ROOT%
  echo.
  pause
  exit /b 1
)

echo.
echo [QuickHack Console] Starting local server console.
echo [QuickHack Console] URL: http://127.0.0.1:2999
echo.

"%NODE_EXE%" "%CONSOLE_SCRIPT%"

echo.
echo [QuickHack Console] Closed.
pause
