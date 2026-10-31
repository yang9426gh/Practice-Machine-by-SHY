@echo off
title Practice Machine by SHY - UNINSTALL
echo Close the server first if it is running (this script will try to stop it).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows_uninstall.ps1"
pause
