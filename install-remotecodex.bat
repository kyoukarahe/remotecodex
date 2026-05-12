@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-remotecodex.ps1" %*
