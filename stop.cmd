@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\workbench.ps1" stop %*
if errorlevel 1 pause
