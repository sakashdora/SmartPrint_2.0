@echo off
setlocal
title SmartPrint - Cloudflare Live Edge Runner
echo ============================================================
echo           SmartPrint Live Cloudflare Runner                
echo ============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [Error] Node.js is not found in PATH.
    echo Please install Node.js from https://nodejs.org and re-run.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cloudflare-tunnel.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [Notice] Cloudflare tunnel runner exited with code %ERRORLEVEL%.
    pause
)
