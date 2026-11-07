@echo off
title Practice Machine by SHY - INSTALL
if not exist "%~dp0windows_install.ps1" (
  echo ERROR: windows_install.ps1 not found next to this file.
  echo You probably ran INSTALL.bat from inside the zip.
  echo Extract the whole "Practice Machine by SHY" folder first, then run INSTALL.bat again.
  pause
  exit /b 1
)
echo ============================================
echo  Practice Machine by SHY - First-time setup
echo  (Python / dependencies auto-install)
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows_install.ps1"
echo.
echo Window can be closed now.
pause
