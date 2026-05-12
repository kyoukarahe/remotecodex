@echo off
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

if not exist "output\logs" mkdir "output\logs"

echo [%date% %time%] Starting RemoteCodex bot...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-remotecodex.ps1" -Root "%ROOT%"
npm.cmd start >> "output\logs\remotecodex-live.out.log" 2>> "output\logs\remotecodex-live.err.log"

endlocal
