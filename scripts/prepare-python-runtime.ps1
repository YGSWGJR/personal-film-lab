[CmdletBinding()]
param(
    [string]$PythonVersion = "3.12.10",
    [string]$NumpyVersion = "2.5.4",
    [string]$OpenCvVersion = "5.0.0.93",
    [switch]$VerifyOnly,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot "resources\python"
$sitePackagesDir = Join-Path $runtimeDir "Lib\site-packages"
$pythonExe = Join-Path $runtimeDir "python.exe"
$sizeFile = Join-Path $runtimeDir "SIZE.txt"

if (-not $runtimeDir.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作工作区外的运行时目录：$runtimeDir"
}

function Invoke-Download {
    param(
        [string]$Uri,
        [string]$OutFile
    )

    for ($attempt = 1; $attempt -le 2; $attempt++) {
        try {
            Write-Host "下载（$attempt/2）：$Uri"
            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -TimeoutSec 180
            return
        } catch {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Seconds 2
        }
    }
}

function Expand-ZipArchive {
    param(
        [string]$ArchivePath,
        [string]$Destination
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $destinationRoot = [System.IO.Path]::GetFullPath($Destination)
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $targetPath = [System.IO.Path]::GetFullPath((Join-Path $destinationRoot $entry.FullName))
            if (-not $targetPath.StartsWith($destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "压缩包包含不安全路径：$($entry.FullName)"
            }
            if ([string]::IsNullOrEmpty($entry.Name)) {
                New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
            } else {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function Test-Runtime {
    if (-not (Test-Path -LiteralPath $pythonExe)) { return $false }
    $versionText = (& $pythonExe --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch "^Python\s+3\.12\.") { return $false }
    $probe = (& $pythonExe -c "import numpy, cv2; print(numpy.__version__ + '|' + cv2.__version__)" 2>&1 | Out-String).Trim()
    return $LASTEXITCODE -eq 0 -and $probe.Contains("|")
}

function Write-SizeReport {
    param([string]$ProbeResult = "")

    $files = Get-ChildItem -LiteralPath $runtimeDir -Recurse -File
    $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    $totalMb = [math]::Round($totalBytes / 1MB, 2)
    $lines = @(
        "Python runtime: $PythonVersion embed-amd64",
        "numpy: $NumpyVersion",
        "opencv-python: $OpenCvVersion",
        "Generated: $((Get-Date).ToString('s'))",
        "Total bytes: $totalBytes",
        "Total MB: $totalMb",
        "Self-test: $ProbeResult",
        "",
        "Top-level sizes:"
    )
    foreach ($item in Get-ChildItem -LiteralPath $runtimeDir -Force) {
        if ($item.PSIsContainer) {
            $size = (Get-ChildItem -LiteralPath $item.FullName -Recurse -File | Measure-Object -Property Length -Sum).Sum
        } else {
            $size = $item.Length
        }
        $lines += ("{0}: {1:N2} MB" -f $item.Name, ($size / 1MB))
    }
    Set-Content -LiteralPath $sizeFile -Value $lines -Encoding UTF8
}

if ($VerifyOnly) {
    if (-not (Test-Runtime)) {
        throw "内嵌 Python 运行时缺失或自检失败：$pythonExe"
    }
    Write-SizeReport "verified"
    Write-Host "内嵌 Python 运行时自检通过：$pythonExe"
    exit 0
}

if (-not $Force -and (Test-Runtime)) {
    Write-SizeReport "verified (existing runtime reused)"
    Write-Host "内嵌 Python 运行时已存在且自检通过，跳过下载。"
    exit 0
}

if (Test-Path -LiteralPath $runtimeDir) {
    Remove-Item -LiteralPath $runtimeDir -Recurse -Force
}

$tempRoot = Join-Path $env:TEMP ("personal-film-lab-python-" + [guid]::NewGuid().ToString("N"))
$wheelDir = Join-Path $tempRoot "wheels"
New-Item -ItemType Directory -Force -Path $tempRoot, $wheelDir | Out-Null

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $embedUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    $embedZip = Join-Path $tempRoot "python-embed.zip"
    Invoke-Download -Uri $embedUrl -OutFile $embedZip

    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Expand-ZipArchive -ArchivePath $embedZip -Destination $runtimeDir

    $pipDownloadArgs = @(
        "-m", "pip", "download",
        "--only-binary=:all:",
        "--platform", "win_amd64",
        "--python-version", "3.12",
        "--implementation", "cp",
        "--abi", "cp312",
        "numpy==$NumpyVersion",
        "opencv-python==$OpenCvVersion",
        "-d", $wheelDir
    )
    & python @pipDownloadArgs
    if ($LASTEXITCODE -ne 0) {
        throw "pip 下载 cp312 wheels 失败，退出码：$LASTEXITCODE"
    }

    New-Item -ItemType Directory -Force -Path $sitePackagesDir | Out-Null
    $wheels = Get-ChildItem -LiteralPath $wheelDir -Filter "*.whl"
    if ($wheels.Count -eq 0) { throw "未下载到任何 cp312 wheel" }
    foreach ($wheel in $wheels) {
        Write-Host "解压依赖：$($wheel.Name)"
        Expand-ZipArchive -ArchivePath $wheel.FullName -Destination $sitePackagesDir
    }

    $pthPath = Join-Path $runtimeDir "python312._pth"
    if (-not (Test-Path -LiteralPath $pthPath)) {
        throw "未找到 Python embeddable 路径配置：$pthPath"
    }
    Set-Content -LiteralPath $pthPath -Encoding ASCII -Value @(
        "python312.zip",
        ".",
        "Lib/site-packages"
    )

    foreach ($dllName in @("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll")) {
        $sourceDll = Join-Path $env:SystemRoot "System32\$dllName"
        if (-not (Test-Path -LiteralPath $sourceDll)) {
            throw "缺少 VC 运行库：$sourceDll"
        }
        Copy-Item -LiteralPath $sourceDll -Destination (Join-Path $runtimeDir $dllName) -Force
    }

    $probe = (& $pythonExe -c "import numpy, cv2; print('numpy=' + numpy.__version__ + '; opencv=' + cv2.__version__)" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "内嵌 Python 导入自检失败：$probe"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sitePackagesDir "numpy"))) {
        throw "Lib/site-packages 中缺少 numpy"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sitePackagesDir "cv2"))) {
        throw "Lib/site-packages 中缺少 cv2"
    }

    Write-SizeReport $probe
    $sizeText = Get-Content -LiteralPath $sizeFile -Raw
    Write-Host $sizeText
    Write-Host "内嵌 Python 运行时准备完成：$pythonExe"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
