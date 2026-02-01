# OpenClaw SecurityAudit-CN Windows Installer 一键构建脚本
# 双击运行或在 PowerShell 中执行: powershell -ExecutionPolicy Bypass -File build-installer.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  OpenClaw SecurityAudit-CN 安装包构建工具  " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# 获取脚本所在目录
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Get-Item "$scriptDir\..\..").FullName
$appDir = $scriptDir

Write-Host "[信息] 脚本目录: $scriptDir" -ForegroundColor Gray
Write-Host "[信息] 项目根目录: $rootDir" -ForegroundColor Gray
Write-Host ""

# 步骤 1: 检查 Node.js
Write-Host "[1/8] 检查 Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "       Node.js 版本: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "       错误: 未安装 Node.js，请先安装 Node.js 22+" -ForegroundColor Red
    Read-Host "按 Enter 键退出"
    exit 1
}

# 步骤 2: 检查 pnpm
Write-Host "[2/8] 检查 pnpm..." -ForegroundColor Yellow
try {
    $pnpmVersion = pnpm --version
    Write-Host "       pnpm 版本: $pnpmVersion" -ForegroundColor Green
} catch {
    Write-Host "       未安装 pnpm，正在安装..." -ForegroundColor Yellow
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) {
        Write-Host "       错误: pnpm 安装失败" -ForegroundColor Red
        Read-Host "按 Enter 键退出"
        exit 1
    }
}

# 步骤 3: 安装主项目依赖
Write-Host "[3/8] 安装主项目依赖..." -ForegroundColor Yellow
Set-Location $rootDir
pnpm install 2>&1 | Out-Null
Write-Host "       依赖安装完成" -ForegroundColor Green

# 步骤 4: 构建主项目
Write-Host "[4/8] 构建 OpenClaw 主项目..." -ForegroundColor Yellow
pnpm build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "       警告: 主项目构建可能有问题，继续..." -ForegroundColor Yellow
}
Write-Host "       主项目构建完成" -ForegroundColor Green

# 步骤 5: 构建 Control UI
Write-Host "[5/8] 构建 Control UI..." -ForegroundColor Yellow
Set-Location "$rootDir\ui"
pnpm build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "       错误: UI 构建失败" -ForegroundColor Red
    Read-Host "按 Enter 键退出"
    exit 1
}
Write-Host "       Control UI 构建完成" -ForegroundColor Green

# 步骤 6: 安装 Windows 应用依赖
Write-Host "[6/8] 安装打包依赖..." -ForegroundColor Yellow
Set-Location $appDir
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "       警告: npm install 可能有问题" -ForegroundColor Yellow
}
Write-Host "       依赖安装完成" -ForegroundColor Green

# 步骤 7: 准备图标文件
Write-Host "[7/8] 准备图标文件..." -ForegroundColor Yellow

# 确保 build 目录存在
$buildDir = "$appDir\build"
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
}

# 复制 PNG 到 build 目录
$pngSource = "$appDir\renderer\logo.png"
$pngDest = "$buildDir\icon.png"
$icoDest = "$buildDir\icon.ico"

if (Test-Path $pngSource) {
    Copy-Item $pngSource $pngDest -Force
    Write-Host "       复制 icon.png 到 build/" -ForegroundColor Green
    
    # 如果没有 ICO，复制 PNG 作为 ICO（electron-builder 会处理）
    if (-not (Test-Path $icoDest)) {
        Copy-Item $pngSource $icoDest -Force
        Write-Host "       创建 icon.ico (从 PNG)" -ForegroundColor Green
    } else {
        Write-Host "       ICO 图标已存在" -ForegroundColor Green
    }
} else {
    Write-Host "       警告: 未找到源图标文件 $pngSource" -ForegroundColor Yellow
}

# 步骤 8: 构建安装包
Write-Host "[8/8] 构建 Windows 安装包..." -ForegroundColor Yellow
Write-Host ""

# 运行 electron-builder
npx electron-builder --win nsis --x64

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "           构建成功!                        " -ForegroundColor Green
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host ""
    
    # 显示生成的文件
    $distDir = "$appDir\dist"
    if (Test-Path $distDir) {
        Write-Host "生成的安装包:" -ForegroundColor Cyan
        Get-ChildItem $distDir -Filter "*.exe" | ForEach-Object {
            $sizeMB = [math]::Round($_.Length / 1MB, 2)
            Write-Host "  -> $($_.Name) ($sizeMB MB)" -ForegroundColor White
        }
        Write-Host ""
        Write-Host "安装包位置: $distDir" -ForegroundColor Cyan
        
        # 打开输出目录
        Start-Process explorer.exe $distDir
    }
} else {
    Write-Host ""
    Write-Host "构建失败! 请检查上方错误信息" -ForegroundColor Red
}

Write-Host ""
Read-Host "按 Enter 键退出"
