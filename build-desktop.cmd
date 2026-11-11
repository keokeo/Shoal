@echo off
rem Build the desktop installer and bump the version. Argument: patch (default), minor, major, x.y.z or keep.
node "%~dp0scripts\build-desktop.mjs" %*
if errorlevel 1 (
  pause
  exit /b 1
)
explorer "%~dp0desktop\src-tauri\target\release\bundle\nsis"
exit /b 0
