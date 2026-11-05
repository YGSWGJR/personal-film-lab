[CmdletBinding()]
param(
  [string]$Tag = "v0.1.9",
  [string]$Destination = ".\downloads"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repo = "YGSWGJR/personal-film-lab"
$releaseUri = "https://api.github.com/repos/$repo/releases/tags/$Tag"
$release = Invoke-RestMethod -Uri $releaseUri -Headers @{ "User-Agent" = "Personal-Film-Lab-Downloader" }
$Destination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$wantedNames = @(
  "个人拉片工作台 Setup 0.1.9.exe",
  "个人拉片工作台卸载工具-0.1.9.exe",
  "个人拉片工作台使用说明-v0.1.9.docx",
  "个人拉片工作台-0.1.9-安装说明.txt",
  "SHA256SUMS.txt"
)

foreach ($name in $wantedNames) {
  $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if (-not $asset) {
    Write-Warning "发布中未找到：$name"
    continue
  }
  $target = Join-Path $Destination $name
  Write-Host "下载 $name"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target -UseBasicParsing
}

$parts = @($release.assets | Where-Object { $_.name -match '^个人拉片工作台-0\.1\.9-local-ai\.7z\.part\.\d{3}$' } | Sort-Object name)
if ($parts.Count -gt 0) {
  $localParts = @()
  foreach ($part in $parts) {
    $target = Join-Path $Destination $part.name
    Write-Host "下载 $($part.name) ($([math]::Round($part.size / 1GB, 2)) GB)"
    Invoke-WebRequest -Uri $part.browser_download_url -OutFile $target -UseBasicParsing
    $localParts += $target
  }

  $archive = Join-Path $Destination "个人拉片工作台-0.1.9-local-ai.7z"
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
  $output = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    foreach ($part in $localParts) {
      $input = [System.IO.File]::OpenRead($part)
      try {
        $input.CopyTo($output)
      } finally {
        $input.Dispose()
      }
    }
  } finally {
    $output.Dispose()
  }
} else {
  $single = $release.assets | Where-Object { $_.name -eq "个人拉片工作台-0.1.9-local-ai.7z" } | Select-Object -First 1
  if ($single) {
    Invoke-WebRequest -Uri $single.browser_download_url -OutFile (Join-Path $Destination $single.name) -UseBasicParsing
  } else {
    Write-Warning "发布中未找到本地 AI 资源包或分卷。"
  }
}

$checksums = Join-Path $Destination "SHA256SUMS.txt"
if (Test-Path -LiteralPath $checksums) {
  Write-Host "校验下载文件的 SHA-256"
  foreach ($line in Get-Content -LiteralPath $checksums) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
      $expected = $matches[1].ToUpperInvariant()
      $file = Join-Path $Destination $matches[2].Trim()
      if (Test-Path -LiteralPath $file) {
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($actual -ne $expected) {
          throw "SHA-256 校验失败：$file"
        }
      }
    }
  }
}

Write-Host "下载完成：$Destination"
Write-Host "安装时请将 Setup 与同名 local-ai.7z 放在同一目录。"
