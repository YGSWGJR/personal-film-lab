[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$mpvDir = Join-Path $repoRoot "resources\mpv"
$ffmpegDir = Join-Path $repoRoot "resources\ffmpeg"
$sevenZip = Join-Path $repoRoot "build\7zr.exe"
$mpvDll = Join-Path $mpvDir "libmpv-2.dll"
$ffmpegExe = Join-Path $ffmpegDir "ffmpeg.exe"
$ffprobeExe = Join-Path $ffmpegDir "ffprobe.exe"

if (-not $Force -and (Test-Path $mpvDll) -and (Test-Path $ffmpegExe) -and (Test-Path $ffprobeExe)) {
  Write-Host "运行时资源已存在：$mpvDll"
  Write-Host "                        $ffmpegExe"
  Write-Host "                        $ffprobeExe"
  exit 0
}

if (-not (Test-Path -LiteralPath $sevenZip)) {
  throw "缺少 build\7zr.exe，无法解压运行时资源。"
}

$release = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest" `
  -Headers @{ "User-Agent" = "Personal-Film-Lab-Setup" }
$mpvAsset = $release.assets |
  Where-Object { $_.name -match '^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$' } |
  Select-Object -First 1
$ffmpegAsset = $release.assets |
  Where-Object { $_.name -match '^ffmpeg-x86_64-git-[0-9a-f]+\.7z$' } |
  Select-Object -First 1
$hashAsset = $release.assets | Where-Object { $_.name -eq "sha256.txt" } | Select-Object -First 1
if (-not $mpvAsset -or -not $ffmpegAsset -or -not $hashAsset) {
  throw "无法从 mpv-winbuild 最新发布中定位 x64 运行库资源。"
}

$tempRoot = Join-Path $env:TEMP ("personal-film-lab-runtime-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $hashResponse = Invoke-WebRequest -Uri $hashAsset.browser_download_url -UseBasicParsing
  $hashText = if ($hashResponse.Content -is [byte[]]) {
    [Text.Encoding]::UTF8.GetString($hashResponse.Content)
  } else {
    [string]$hashResponse.Content
  }
  $hashes = @{}
  foreach ($line in ($hashText -split "`r?`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$') {
      $hashes[$matches[2].Trim()] = $matches[1].ToUpperInvariant()
    }
  }

  foreach ($asset in @($mpvAsset, $ffmpegAsset)) {
    $archive = Join-Path $tempRoot $asset.name
    Write-Host "下载 $($asset.name)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -UseBasicParsing
    $expected = $hashes[$asset.name]
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if (-not $expected -or $actual -ne $expected) {
      throw "SHA-256 校验失败：$($asset.name)"
    }
    $extractDir = Join-Path $tempRoot ([IO.Path]::GetFileNameWithoutExtension($asset.name))
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    & $sevenZip x $archive "-o$extractDir" -y -aoa -bd -bb0 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "解压失败：$($asset.name)"
    }
  }

  New-Item -ItemType Directory -Force -Path $mpvDir, $ffmpegDir | Out-Null
  $foundMpv = Get-ChildItem -LiteralPath $tempRoot -Recurse -File -Filter "libmpv-2.dll" | Select-Object -First 1
  $foundFfmpeg = Get-ChildItem -LiteralPath $tempRoot -Recurse -File -Filter "ffmpeg.exe" | Select-Object -First 1
  $foundFfprobe = Get-ChildItem -LiteralPath $tempRoot -Recurse -File -Filter "ffprobe.exe" | Select-Object -First 1
  if (-not $foundMpv -or -not $foundFfmpeg -or -not $foundFfprobe) {
    throw "运行库压缩包中缺少 libmpv-2.dll、ffmpeg.exe 或 ffprobe.exe。"
  }
  Copy-Item -LiteralPath $foundMpv.FullName -Destination $mpvDll -Force
  Copy-Item -LiteralPath $foundFfmpeg.FullName -Destination $ffmpegExe -Force
  Copy-Item -LiteralPath $foundFfprobe.FullName -Destination $ffprobeExe -Force
  Write-Host "运行库已准备完成："
  Write-Host "  $mpvDll"
  Write-Host "  $ffmpegExe"
  Write-Host "  $ffprobeExe"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
