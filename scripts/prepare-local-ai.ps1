[CmdletBinding()]
param(
  [string]$SourceRoot = $env:PFL_LOCAL_AI_SOURCE,
  [string]$OfflineArchive = $env:PFL_LOCAL_AI_ARCHIVE,
  [string]$TargetRoot = "",
  [switch]$AllowMissing,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $TargetRoot) {
  $TargetRoot = Join-Path $repoRoot "resources\local-ai"
}
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)
$repoFull = [System.IO.Path]::GetFullPath($repoRoot)
if (-not $TargetRoot.StartsWith($repoFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝写入仓库外的本地 AI 目录：$TargetRoot"
}

$targetPython = Join-Path $TargetRoot "runtime\python_embeded"
$targetComfy = Join-Path $TargetRoot "ComfyUI"
$targetModel = Join-Path $TargetRoot "models\text_encoders\qwen3vl_8b_w4a8.safetensors"

function Test-LocalAiReady {
  return (
    (Test-Path -LiteralPath (Join-Path $targetPython "python.exe")) -and
    (Test-Path -LiteralPath (Join-Path $targetComfy "main.py")) -and
    (Test-Path -LiteralPath $targetModel)
  )
}

if (-not $Force -and (Test-LocalAiReady)) {
  Write-Output "LOCAL_AI_ROOT=$TargetRoot"
  Write-Output "PYTHON=$targetPython\python.exe"
  Write-Output "MODEL=$targetModel"
  Write-Output "本地 AI 资源已存在并通过结构检查，跳过复制。"
  exit 0
}

if ($OfflineArchive) {
  $OfflineArchive = [System.IO.Path]::GetFullPath($OfflineArchive)
  if (-not (Test-Path -LiteralPath $OfflineArchive)) {
    throw "本地 AI 离线包不存在：$OfflineArchive"
  }
  $sevenZip = Join-Path $repoRoot "build\7zr.exe"
  if (-not (Test-Path -LiteralPath $sevenZip)) {
    throw "缺少 7zr.exe，无法解压本地 AI 离线包：$sevenZip"
  }
  New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
  & $sevenZip x $OfflineArchive "-o$TargetRoot" -y -aoa -bd -bb0
  if ($LASTEXITCODE -ne 0 -or -not (Test-LocalAiReady)) {
    throw "本地 AI 离线包解压失败或结构不完整。"
  }
  Write-Output "LOCAL_AI_ROOT=$TargetRoot"
  Write-Output "PYTHON=$targetPython\python.exe"
  Write-Output "MODEL=$targetModel"
  exit 0
}

if (-not $SourceRoot) {
  if ($AllowMissing) {
    Write-Warning "未提供本地 AI 资源。将构建仅含 OpenCV 备用引擎的应用主体。"
    Write-Warning "完整本地 AI 构建请设置 PFL_LOCAL_AI_ARCHIVE 后运行 npm run prepare:local-ai。"
    exit 0
  }
  throw @"
未找到本地 AI 资源。请使用以下任一方式：
  1. 设置 PFL_LOCAL_AI_ARCHIVE 为官方 local-ai.7z 路径；
  2. 设置 PFL_LOCAL_AI_SOURCE 为含 python_embeded、ComfyUI 和 Qwen3-VL 模型的目录；
  3. 运行 npm run prepare:local-ai -- -AllowMissing 构建 OpenCV 备用版。
"@
}

$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$sourcePython = Join-Path $SourceRoot "python_embeded"
$sourceComfy = Join-Path $SourceRoot "ComfyUI"
$sourceModelCandidates = @(
  (Join-Path $sourceComfy "models\text_encoders\qwen3vl_8b_w4a8.safetensors"),
  (Join-Path $sourceComfy "models\text_encoders\qwen3vl_8b_w4a8_gptq.safetensors"),
  (Join-Path $SourceRoot "models\text_encoders\qwen3vl_8b_w4a8.safetensors")
)
$sourceModel = $sourceModelCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

foreach ($required in @($sourcePython, $sourceComfy, $sourceModel)) {
  if (-not $required -or -not (Test-Path -LiteralPath $required)) {
    throw "本地 AI 源目录结构不完整，需要 python_embeded、ComfyUI 和 Qwen3-VL 模型：$SourceRoot"
  }
}

New-Item -ItemType Directory -Force -Path `
  $targetPython, `
  (Join-Path $TargetRoot "models\text_encoders") | Out-Null

$pythonExclude = @(
  (Join-Path $sourcePython "tests")
)
& robocopy $sourcePython $targetPython /E /COPY:DAT /DCOPY:DAT `
  /XD $pythonExclude `
  /XF "*.pyc" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) {
  throw "复制 Python 本地 AI 运行环境失败，robocopy exit=$LASTEXITCODE"
}

$comfyExclude = @(
  (Join-Path $sourceComfy "models"),
  (Join-Path $sourceComfy "custom_nodes"),
  (Join-Path $sourceComfy ".git"),
  (Join-Path $sourceComfy "tests"),
  (Join-Path $sourceComfy "tests-unit"),
  (Join-Path $sourceComfy "user"),
  (Join-Path $sourceComfy "output"),
  (Join-Path $sourceComfy "input")
)
& robocopy $sourceComfy $targetComfy /E /COPY:DAT /DCOPY:DAT `
  /XD $comfyExclude `
  /XF "*.pyc" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) {
  throw "复制 ComfyUI 本地推理核心失败，robocopy exit=$LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $targetModel)) {
  Copy-Item -LiteralPath $sourceModel -Destination $targetModel
}

if (-not (Test-LocalAiReady)) {
  throw "本地 AI 资源复制后结构检查失败：$TargetRoot"
}

Write-Output "LOCAL_AI_ROOT=$TargetRoot"
Write-Output "PYTHON=$TargetRoot\runtime\python_embeded\python.exe"
Write-Output "MODEL=$targetModel"
