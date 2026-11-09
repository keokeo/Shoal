@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\workbench.ps1" start %*
if errorlevel 1 pause
