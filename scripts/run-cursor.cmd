@echo off
setlocal EnableExtensions DisableDelayedExpansion
for %%I in ("%~dp0..") do set "plugin_root=%%~fI"
set "runtime="

if defined WORKLOUDER_CURSOR_EXECUTABLE if exist "%WORKLOUDER_CURSOR_EXECUTABLE%" set "runtime=%WORKLOUDER_CURSOR_EXECUTABLE%"
if not defined runtime if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" set "runtime=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
if not defined runtime if defined ProgramFiles if exist "%ProgramFiles%\Cursor\Cursor.exe" set "runtime=%ProgramFiles%\Cursor\Cursor.exe"
if not defined runtime if exist "%ProgramFiles(x86)%\Cursor\Cursor.exe" set "runtime=%ProgramFiles(x86)%\Cursor\Cursor.exe"

if not defined runtime for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\Cursor.exe" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "runtime=%%B"
if not defined runtime for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\Cursor.exe" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "runtime=%%B"
if not defined runtime for /f "delims=" %%I in ('where Cursor.exe 2^>nul') do if not defined runtime set "runtime=%%~fI"
if not defined runtime for /f "usebackq delims=" %%I in (`powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"`) do if not defined runtime set "runtime=%%I"

if not defined runtime (
  >&2 echo Work Louder: could not find Cursor.exe. Set WORKLOUDER_CURSOR_EXECUTABLE to its full path and try again.
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
set "NODE_OPTIONS="
set "NODE_REPL_EXTERNAL_MODULE="
"%runtime%" "%plugin_root%\src\entry.cjs" %*
set "exit_code=%ERRORLEVEL%"
endlocal & exit /b %exit_code%
