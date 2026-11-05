[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$SourceRoot = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $Version = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
}
if (-not $SourceRoot) {
  $SourceRoot = Join-Path $repoRoot "resources\local-ai"
}
if (-not $OutputPath) {
  $OutputPath = Join-Path $repoRoot "release\个人拉片工作台-$Version-local-ai.7z"
}

$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$required = @(
  (Join-Path $SourceRoot "runtime\python_embeded\python.exe"),
  (Join-Path $SourceRoot "ComfyUI\main.py"),
  (Join-Path $SourceRoot "models\text_encoders\qwen3vl_8b_w4a8.safetensors")
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "本地 AI 资源不完整：$path"
  }
}

$sevenZip = Join-Path $repoRoot "build\7zr.exe"
if (-not (Test-Path -LiteralPath $sevenZip)) {
  throw "缺少 7zr.exe：$sevenZip"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

$previous = Get-Location
try {
  Set-Location -LiteralPath $SourceRoot
  & $sevenZip a -t7z -mx=5 -bd -bb0 $OutputPath ".\*"
  if ($LASTEXITCODE -ne 0) {
    throw "本地 AI 资源打包失败，7zr exit=$LASTEXITCODE"
  }
} finally {
  Set-Location -LiteralPath $previous
}

if (-not (Test-Path -LiteralPath $OutputPath)) {
  throw "本地 AI 资源包未生成：$OutputPath"
}
$item = Get-Item -LiteralPath $OutputPath
$hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash
Write-Output "LOCAL_AI_ARCHIVE=$($item.FullName)"
Write-Output "SIZE_BYTES=$($item.Length)"
Write-Output "SHA256=$hash"
