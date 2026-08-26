@echo off
setlocal EnableExtensions DisableDelayedExpansion

if "%~1"=="" (
  echo Trelio could not start: missing bundled JavaScript entrypoint. 1>&2
  exit /b 64
)

set "TRELIO_MINIMUM_NODE_MAJOR=22"
set "TRELIO_NODE_PATH="

rem Prefer explicit Codex runtime hints before checking any ambient PATH. This
rem keeps the plugin working when Codex Desktop could not create PATH aliases.
call :consider_node "%CODEX_MCP_NODE_PATH%"
if defined TRELIO_NODE_PATH goto launch
call :consider_node "%CODEX_BROWSER_USE_NODE_PATH%"
if defined TRELIO_NODE_PATH goto launch

if defined CODEX_ELECTRON_RESOURCES_PATH (
  call :consider_node "%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe"
  if defined TRELIO_NODE_PATH goto launch
)
if defined CODEX_CLI_PATH (
  for %%I in ("%CODEX_CLI_PATH%") do call :consider_node "%%~dpIcua_node\bin\node.exe"
  if defined TRELIO_NODE_PATH goto launch
)
if defined USERPROFILE (
  call :consider_node "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if defined TRELIO_NODE_PATH goto launch
)
if defined LOCALAPPDATA (
  for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do if not defined TRELIO_NODE_PATH call :consider_node "%%~fD\bin\node.exe"
  if defined TRELIO_NODE_PATH goto launch
)

rem The existing resolver understands durable Windows PATH and Program Files,
rem so a stale parent process can still reuse an already installed Node.js.
if defined SystemRoot (
  for /f "usebackq delims=" %%I in (`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0resolve-node.ps1" -PathOnly 2^>nul`) do if not defined TRELIO_NODE_PATH call :consider_node "%%I"
  if defined TRELIO_NODE_PATH goto launch
)

for /f "delims=" %%I in ('where node 2^>nul') do if not defined TRELIO_NODE_PATH call :consider_node "%%~fI"
if defined TRELIO_NODE_PATH goto launch

echo Trelio could not find Node.js 22 or newer. Update Codex or install Node.js 22+. 1>&2
exit /b 127

:launch
"%TRELIO_NODE_PATH%" %*
exit /b %ERRORLEVEL%

:consider_node
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
set "TRELIO_NODE_MAJOR="
for /f "usebackq delims=" %%V in (`"%~1" -p "process.versions.node.split('.')[0]" 2^>nul`) do if not defined TRELIO_NODE_MAJOR set "TRELIO_NODE_MAJOR=%%V"
if not defined TRELIO_NODE_MAJOR exit /b 0
for /f "delims=0123456789" %%V in ("%TRELIO_NODE_MAJOR%") do exit /b 0
if %TRELIO_NODE_MAJOR% LSS %TRELIO_MINIMUM_NODE_MAJOR% exit /b 0
set "TRELIO_NODE_PATH=%~f1"
exit /b 0
