param(
  [string]$SourceRoot = "G:\ai\ComfyUI_ROB3700",
  [string]$TargetRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $TargetRoot) {
  $TargetRoot = Join-Path $PSScriptRoot "..\resources\local-ai"
}
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

$sourcePython = Join-Path $SourceRoot "python_embeded"
$sourceComfy = Join-Path $SourceRoot "ComfyUI"
$sourceModel = Join-Path $sourceComfy "models\text_encoders\qwen3vl_8b_w4a8.safetensors"

foreach ($required in @($sourcePython, $sourceComfy, $sourceModel)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "本地 AI 资源缺失：$required"
  }
}

New-Item -ItemType Directory -Force -Path `
  (Join-Path $TargetRoot "runtime\python_embeded"), `
  (Join-Path $TargetRoot "ComfyUI\models\embeddings"), `
  (Join-Path $TargetRoot "models\text_encoders") | Out-Null

$targetPython = Join-Path $TargetRoot "runtime\python_embeded"
$targetComfy = Join-Path $TargetRoot "ComfyUI"

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

$targetModel = Join-Path $TargetRoot "models\text_encoders\qwen3vl_8b_w4a8.safetensors"
if (-not (Test-Path -LiteralPath $targetModel)) {
  Copy-Item -LiteralPath $sourceModel -Destination $targetModel
}

Write-Output "LOCAL_AI_ROOT=$TargetRoot"
Write-Output "PYTHON=$TargetRoot\runtime\python_embeded\python.exe"
Write-Output "MODEL=$targetModel"
