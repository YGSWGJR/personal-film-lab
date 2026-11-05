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

$apiHeaders = @{ "User-Agent" = "Personal-Film-Lab-Setup" }
$githubToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { "" }
if ($githubToken) {
  $apiHeaders["Authorization"] = "Bearer $githubToken"
}

$mpvRelease = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest" `
  -Headers $apiHeaders
$mpvAsset = $mpvRelease.assets |
  Where-Object { $_.name -match '^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$' } |
  Select-Object -First 1
$mpvHashAsset = $mpvRelease.assets | Where-Object { $_.name -eq "sha256.txt" } | Select-Object -First 1

$ffmpegRelease = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" `
  -Headers $apiHeaders
$ffmpegAsset = $ffmpegRelease.assets |
  Where-Object { $_.name -match '^ffmpeg-n9\.0-latest-win64-gpl-9\.0\.zip$' } |
  Select-Object -First 1
$ffmpegHashAsset = $ffmpegRelease.assets | Where-Object { $_.name -eq "checksums.sha256" } | Select-Object -First 1

if (-not $mpvAsset -or -not $mpvHashAsset -or -not $ffmpegAsset -or -not $ffmpegHashAsset) {
  throw "无法定位 mpv 或 BtbN FFmpeg 的 Windows x64 发布资产。"
}

function Read-HashMap {
  param([string]$Uri)
  $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing
  $text = if ($response.Content -is [byte[]]) {
    [Text.Encoding]::UTF8.GetString($response.Content)
  } else {
    [string]$response.Content
  }
  $map = @{}
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
      $map[$matches[2].Trim()] = $matches[1].ToUpperInvariant()
    }
  }
  return $map
}

function Get-VerifiedAsset {
  param(
    [object]$Asset,
    [hashtable]$Hashes,
    [string]$Destination
  )
  Write-Host "下载 $($Asset.name)"
  Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Destination -UseBasicParsing
  $expected = $Hashes[$Asset.name]
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
  if (-not $expected -or $actual -ne $expected) {
    throw "SHA-256 校验失败：$($Asset.name)"
  }
}

$tempRoot = Join-Path $env:TEMP ("personal-film-lab-runtime-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $mpvHashes = Read-HashMap $mpvHashAsset.browser_download_url
  $ffmpegHashes = Read-HashMap $ffmpegHashAsset.browser_download_url
  $mpvArchive = Join-Path $tempRoot $mpvAsset.name
  $ffmpegArchive = Join-Path $tempRoot $ffmpegAsset.name
  Get-VerifiedAsset -Asset $mpvAsset -Hashes $mpvHashes -Destination $mpvArchive
  Get-VerifiedAsset -Asset $ffmpegAsset -Hashes $ffmpegHashes -Destination $ffmpegArchive

  $mpvExtract = Join-Path $tempRoot "mpv"
  $ffmpegExtract = Join-Path $tempRoot "ffmpeg"
  New-Item -ItemType Directory -Force -Path $mpvExtract, $ffmpegExtract | Out-Null
  & $sevenZip x $mpvArchive "-o$mpvExtract" -y -aoa -bd -bb0 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "mpv-dev 解压失败。" }
  Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force

  New-Item -ItemType Directory -Force -Path $mpvDir, $ffmpegDir | Out-Null
  $foundMpv = Get-ChildItem -LiteralPath $mpvExtract -Recurse -File -Filter "libmpv-2.dll" | Select-Object -First 1
  $foundFfmpeg = Get-ChildItem -LiteralPath $ffmpegExtract -Recurse -File -Filter "ffmpeg.exe" | Select-Object -First 1
  $foundFfprobe = Get-ChildItem -LiteralPath $ffmpegExtract -Recurse -File -Filter "ffprobe.exe" | Select-Object -First 1
  $foundLicense = Get-ChildItem -LiteralPath $ffmpegExtract -Recurse -File -Filter "LICENSE.txt" | Select-Object -First 1
  if (-not $foundMpv -or -not $foundFfmpeg -or -not $foundFfprobe) {
    throw "运行库压缩包中缺少 libmpv-2.dll、ffmpeg.exe 或 ffprobe.exe。"
  }
  Copy-Item -LiteralPath $foundMpv.FullName -Destination $mpvDll -Force
  Copy-Item -LiteralPath $foundFfmpeg.FullName -Destination $ffmpegExe -Force
  Copy-Item -LiteralPath $foundFfprobe.FullName -Destination $ffprobeExe -Force
  if ($foundLicense) {
    Copy-Item -LiteralPath $foundLicense.FullName -Destination (Join-Path $ffmpegDir "LICENSE.txt") -Force
  }
  Write-Host "运行库已准备完成："
  Write-Host "  $mpvDll"
  Write-Host "  $ffmpegExe"
  Write-Host "  $ffprobeExe"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
