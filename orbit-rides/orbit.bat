@echo off
REM Atajo para no escribir powershell -ExecutionPolicy Bypass cada vez.
REM   orbit dev
REM   orbit release patch
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0orbit.ps1" %*
