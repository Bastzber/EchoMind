@echo off
chcp 65001 >nul
echo Installing EchoMind panel for Premiere Pro...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause