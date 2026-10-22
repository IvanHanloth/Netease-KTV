@echo off
rem Netease KTV one-click start for Windows (double-click friendly).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
