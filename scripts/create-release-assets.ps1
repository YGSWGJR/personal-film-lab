[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [string]$LocalAiArchive,
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [Parameter(Mandatory = $true)]
  [string]$UninstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ManualPath,
  [Parameter(Mandatory = $true)]
  [string]$InstallNotePath,
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [int]$PartSizeMiB = 1700
)

$ErrorActionPreference = "Stop"

foreach ($path in @($LocalAiArchive, $SetupPath, $UninstallerPath, $ManualPath, $InstallNotePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "发布输入文件不存在：$path"
  }
}

$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outputFiles = @(
  (Join-Path $OutputDir "个人拉片工作台 Setup $Version.exe"),
  (Join-Path $OutputDir "个人拉片工作台卸载工具-$Version.exe"),
  (Join-Path $OutputDir "个人拉片工作台使用说明-$Version.docx"),
  (Join-Path $OutputDir "个人拉片工作台-$Version-安装说明.txt")
)
Copy-Item -LiteralPath $SetupPath -Destination $outputFiles[0] -Force
Copy-Item -LiteralPath $UninstallerPath -Destination $outputFiles[1] -Force
Copy-Item -LiteralPath $ManualPath -Destination $outputFiles[2] -Force
Copy-Item -LiteralPath $InstallNotePath -Destination $outputFiles[3] -Force

$localAiName = "个人拉片工作台-$Version-local-ai.7z"
$chunkSize = [int64]$PartSizeMiB * 1MB
$input = [System.IO.File]::OpenRead([System.IO.Path]::GetFullPath($LocalAiArchive))
try {
  $partIndex = 1
  $buffer = New-Object byte[] (4MB)
  while ($input.Position -lt $input.Length) {
    $partName = "{0}.part.{1:D3}" -f $localAiName, $partIndex
    $partPath = Join-Path $OutputDir $partName
    $remaining = [Math]::Min($chunkSize, $input.Length - $input.Position)
    $out = [System.IO.File]::Open($partPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
      while ($remaining -gt 0) {
        $toRead = [int][Math]::Min($buffer.Length, $remaining)
        $read = $input.Read($buffer, 0, $toRead)
        if ($read -le 0) { throw "读取本地 AI 包时意外结束。" }
        $out.Write($buffer, 0, $read)
        $remaining -= $read
      }
    } finally {
      $out.Dispose()
    }
    Write-Host "已生成 $partName"
    $partIndex += 1
  }
} finally {
  $input.Dispose()
}

$checksumLines = @()
foreach ($file in $outputFiles) {
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  $checksumLines += "$hash  $([System.IO.Path]::GetFileName($file))"
}
$localAiHash = (Get-FileHash -LiteralPath $LocalAiArchive -Algorithm SHA256).Hash
$checksumLines += "$localAiHash  $localAiName"
$checksumLines += "# $localAiName 由发布页中的 .part.001、.part.002 等分卷按名称顺序合并得到。"
[System.IO.File]::WriteAllLines(
  (Join-Path $OutputDir "SHA256SUMS.txt"),
  $checksumLines,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "发布资产已生成：$OutputDir"
