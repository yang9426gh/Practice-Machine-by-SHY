@echo off
title Practice Machine by SHY
if not exist "%~dp0windows_start.ps1" (
  echo ERROR: windows_start.ps1 not found next to this file.
  echo You probably ran START.bat from inside the zip.
  echo Extract the whole "Practice Machine by SHY" folder first, then run START.bat again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows_start.ps1"
echo.
echo (Close this window anytime - the server keeps running)
pause
