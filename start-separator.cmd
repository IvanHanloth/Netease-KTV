@echo off
rem Start a standalone Netease KTV separator server on Windows (double-click friendly).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-separator.ps1" %*
pause
