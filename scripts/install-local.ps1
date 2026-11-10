# 把刚编译出来的 NSIS 安装包静默安装到本机，并重新打开应用。
#
# 用法（二选一）：
#   npm run release:install     # 编译 + 安装 + 启动
#   npm run release             # 只编译（不安装）
#
# 安装前会先关掉正在运行的 AppDeck：安装程序本身也会强制关闭，
# 但提前关掉能避免 exe 被占用，也能让会话干净地落盘。
# 文件保存为 UTF-8 with BOM：Windows PowerShell 5.1 按 ANSI 读无 BOM 的脚本，
# 中文注释会被当成乱码（不影响执行，但容易误伤字符串）。

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nsisDir = Join-Path $root "src-tauri\target\release\bundle\nsis"

$setup = Get-ChildItem $nsisDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $setup) {
  throw "No installer found in $nsisDir - run 'npm run release' first"
}

Get-Process app-deck -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

Write-Host "Installing $($setup.Name) ..."
$p = Start-Process -FilePath $setup.FullName -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -ne 0) {
  throw "Install failed (exit code $($p.ExitCode)): $($setup.FullName)"
}

$exe = Join-Path $env:LOCALAPPDATA "AppDeck\app-deck.exe"
if (-not (Test-Path $exe)) {
  throw "Installed, but executable not found: $exe"
}

Start-Process -FilePath $exe | Out-Null
Write-Host "Installed and launched: $exe"