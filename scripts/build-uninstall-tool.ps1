# 编译独立卸载工具（NSIS 原生版，S46 起，替代 PyInstaller 版交付件）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-uninstall-tool.ps1 [-Version 0.5.2-alpha.3]
[CmdletBinding()]
param(
  [string]$Version = "0.5.2-alpha.3",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) {
  $OutDir = Join-Path $repoRoot "release\uninstall-tool"
}
$nsi = Join-Path $repoRoot "build\uninstall-tool.nsi"
$icon = Join-Path $repoRoot "build\icon.ico"
foreach ($f in @($nsi, $icon)) {
  if (-not (Test-Path -LiteralPath $f)) {
    throw "缺少文件：$f"
  }
}

# makensis 优先用 electron-builder 缓存里的 NSIS，回退系统安装
$cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache"
$cached = $null
if (Test-Path -LiteralPath $cacheRoot) {
  $cached = Get-ChildItem -Path $cacheRoot -Recurse -Filter "makensis.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
}
$makensis = $null
foreach ($c in @($cached.FullName, "C:\Program Files (x86)\NSIS\makensis.exe", "C:\Program Files\NSIS\makensis.exe")) {
  if ($c -and (Test-Path -LiteralPath $c)) {
    $makensis = $c
    break
  }
}
if (-not $makensis) {
  throw "找不到 makensis.exe（electron-builder 缓存与系统 NSIS 均未找到）"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$prev = Get-Location
try {
  Set-Location -LiteralPath $OutDir
  # makensis 会向 stderr 写 INFO 行，PowerShell 5.1 在 EAP=Stop 下会误判为终止错误，这里临时降级
  $ErrorActionPreference = "Continue"
  $log = & $makensis /INPUTCHARSET UTF8 $nsi 2>&1 | Out-String
  $exit = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  $log | Set-Content -LiteralPath (Join-Path $OutDir "log-makensis.txt") -Encoding UTF8
  if ($exit -ne 0) {
    throw "makensis 编译失败 exit=$exit（日志：$OutDir\log-makensis.txt）"
  }
} finally {
  Set-Location -LiteralPath $prev
  $ErrorActionPreference = "Stop"
}

$exe = Join-Path $OutDir ("个人拉片工作台卸载工具-{0}.exe" -f $Version)
# makensis 把相对 OutFile 解析到脚本所在目录（build\），无条件强搬到输出目录（覆盖旧件）
$inScriptDir = Join-Path $repoRoot ("build\个人拉片工作台卸载工具-{0}.exe" -f $Version)
if (Test-Path -LiteralPath $inScriptDir) {
  Move-Item -LiteralPath $inScriptDir -Destination $exe -Force
}
if (-not (Test-Path -LiteralPath $exe)) {
  throw "卸载工具未生成：$exe（确认 .nsi 内 TOOL_VERSION 与 -Version 参数一致）"
}
$vi = (Get-Item -LiteralPath $exe).VersionInfo
Write-Output "UNINSTALL_TOOL=$exe"
Write-Output "SIZE_BYTES=$((Get-Item -LiteralPath $exe).Length)"
Write-Output "ProductVersion=$($vi.ProductVersion)"
Write-Output "FileDescription=$($vi.FileDescription)"
