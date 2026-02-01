@echo off
chcp 65001 >nul
title OpenClaw SecurityAudit-CN 安装包构建工具
echo.
echo =============================================
echo   OpenClaw SecurityAudit-CN 安装包构建工具
echo   双击此文件即可自动构建 EXE 安装包
echo =============================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
