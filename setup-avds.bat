@echo off
cd /d "%~dp0"
echo Creando emuladores Android para Orbit Rides
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-avds.ps1" %*
