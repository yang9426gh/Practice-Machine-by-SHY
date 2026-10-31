@echo off
title Practice Machine by SHY - INSTALL
echo ============================================
echo  Practice Machine by SHY - First-time setup
echo  (Python / dependencies auto-install)
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows_install.ps1"
echo.
echo Window can be closed now.
pause
