[CmdletBinding()]
param(
    [string]$ModelRevision = "4b2cef0e4f246904228785e9f0a693a2363e0a6b",
    [switch]$VerifyOnly
)

# S39-1：下载并校验 TransNetV2 ONNX 模型（固定 revision + 大小 + SHA-256）。
# 模型权重不入 Git；LICENSE / MODEL_CARD.md / SHA256SUMS.txt 已入库。

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $repoRoot "resources\transnetv2\models"
$modelPath = Join-Path $modelDir "transnetv2.onnx"
$expectedSize = 31250929
$expectedSha256 = "C4D54A682BACE32F25136EF83CA2C9D403E8F8193775EFEB995172A0D95A8E0C"
$downloadUrl = "https://huggingface.co/edgetools/transnetv2/resolve/$ModelRevision/transnetv2.onnx"

function Get-FileSha256 {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = $sha.ComputeHash($stream)
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
    return ([System.BitConverter]::ToString($hash)).Replace("-", "")
}

function Test-Model {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -ne $expectedSize) { return $false }
    return (Get-FileSha256 -Path $Path) -eq $expectedSha256
}

if (-not $modelDir.StartsWith((Join-Path $repoRoot "resources\transnetv2"), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作工作区外的模型目录：$modelDir"
}

if (Test-Model -Path $modelPath) {
    Write-Host "TransNetV2 模型已存在且校验通过：$modelPath"
    if (-not $VerifyOnly) { exit 0 }
    exit 0
}

if ($VerifyOnly) {
    throw "TransNetV2 模型缺失或校验失败（大小应为 $expectedSize，SHA-256 应为 $expectedSha256）：$modelPath"
}

Write-Host "下载 TransNetV2 ONNX 模型：$downloadUrl"
$tempRoot = Join-Path $env:TEMP ("personal-film-lab-transnetv2-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$partPath = Join-Path $tempRoot "transnetv2.onnx.part"

try {
    $downloadOk = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-Host "下载（$attempt/3）"
            Invoke-WebRequest -Uri $downloadUrl -OutFile $partPath -UseBasicParsing -TimeoutSec 600
            $downloadOk = $true
            break
        } catch {
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds 3
        }
    }
    if (-not $downloadOk) { throw "下载失败" }

    $size = (Get-Item -LiteralPath $partPath).Length
    if ($size -ne $expectedSize) {
        throw "模型大小不符：实际 $size，期望 $expectedSize。下载源可能已变更，禁止接入未校验的模型。"
    }
    $sha256 = Get-FileSha256 -Path $partPath
    if ($sha256 -ne $expectedSha256) {
        throw "模型 SHA-256 不符：实际 $sha256，期望 $expectedSha256。下载内容可能损坏或被替换，禁止接入。"
    }

    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    Move-Item -LiteralPath $partPath -Destination $modelPath -Force
    Write-Host "TransNetV2 模型下载并校验通过：$modelPath（$expectedSize bytes，SHA-256 $sha256）"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
