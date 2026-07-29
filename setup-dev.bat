@echo off
cd /d "%~dp0"
echo Setup de entorno: APTraslados + Orbit Rides
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-dev.ps1" %*
