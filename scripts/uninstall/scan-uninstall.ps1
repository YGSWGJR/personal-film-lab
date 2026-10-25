[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$AppDir,
    [string]$SettingsPath
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $PSScriptRoot "uninstall-report.json" }

# S32：Electron userData 双位置探测（新位置优先；旧 roaming 位置兼容迁移残留）
$USERDATA_DIRS = @(
    "G:\拉片\软件数据",
    (Join-Path $env:APPDATA "personal-film-lab")
)

$SETTINGS_PATH_FIELDS = @(
    "dataRoot",
    "cacheDir",
    "exportDir",
    "stillDir",
    "proxyCacheDir",
    "frameCacheDir",
    "waveformCacheDir",
    "thumbCacheDir",
    "exportSubDir",
    "stillSubDir"
)
$REQUIRED_PATH_FIELDS = @("dataRoot", "cacheDir", "exportDir", "stillDir")
$UNINSTALL_BASE = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"

function Resolve-FullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try {
        return [System.IO.Path]::GetFullPath($Path.Trim()).TrimEnd('\')
    } catch {
        return $null
    }
}

function Get-UninstallEntry {
    $result = [pscustomobject]@{
        KeyPath = $null
        DisplayName = $null
        InstallLocation = $null
        UninstallString = $null
        DisplayIcon = $null
    }

    if (-not (Test-Path -LiteralPath $UNINSTALL_BASE)) { return $result }
    foreach ($key in Get-ChildItem -LiteralPath $UNINSTALL_BASE -ErrorAction SilentlyContinue) {
        try {
            $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
        } catch {
            continue
        }
        if ($props.DisplayName -and $props.DisplayName -like "*个人拉片工作台*") {
            $result.KeyPath = $key.PSPath
            $result.DisplayName = $props.DisplayName
            $result.InstallLocation = $props.InstallLocation
            $result.UninstallString = $props.UninstallString
            $result.DisplayIcon = $props.DisplayIcon
            return $result
        }
    }
    return $result
}

function Get-AppDirFromEntry {
    param($Entry)
    if ($Entry.InstallLocation) {
        $resolved = Resolve-FullPath $Entry.InstallLocation
        if ($resolved -and (Test-Path -LiteralPath $resolved)) { return $resolved }
    }
    if ($Entry.UninstallString) {
        $exe = $null
        if ($Entry.UninstallString -match '^\s*"([^"]+)"') {
            $exe = $Matches[1]
        } else {
            $exe = ($Entry.UninstallString -split '\s+')[0]
        }
        if ($exe) {
            $resolved = Resolve-FullPath (Split-Path -Parent $exe)
            if ($resolved) { return $resolved }
        }
    }
    return $null
}

function Get-MainProcessNames {
    param([string]$Dir)
    $names = New-Object System.Collections.Generic.List[string]
    if ($Dir -and (Test-Path -LiteralPath $Dir)) {
        $exes = @(Get-ChildItem -LiteralPath $Dir -Filter *.exe -File -ErrorAction SilentlyContinue)
        $mainExes = @($exes | Where-Object { $_.Name -notmatch '^(Uninstall|unins|elevate|crashpad)' })
        # 优先产品名对应的主程序
        $preferred = @($mainExes | Where-Object { $_.BaseName -like "*拉片*" })
        $chosen = if ($preferred.Count -gt 0) { $preferred } else { $mainExes }
        foreach ($item in $chosen) {
            if (-not $names.Contains($item.BaseName)) { $names.Add($item.BaseName) }
        }
    }
    return $names
}

$entry = Get-UninstallEntry
$appDirResolved = if ($AppDir) { Resolve-FullPath $AppDir } else { Get-AppDirFromEntry $entry }
if (-not $appDirResolved) {
    $appDirResolved = Resolve-FullPath (Join-Path $env:LOCALAPPDATA "Programs\personal-film-lab")
}
$userDataCandidates = @($USERDATA_DIRS | ForEach-Object { Resolve-FullPath $_ } | Where-Object { $_ })
$userDataDirs = @($userDataCandidates | Where-Object { Test-Path -LiteralPath $_ })
$roamingDir = if (Test-Path -LiteralPath "G:\拉片\软件数据") {
    Resolve-FullPath "G:\拉片\软件数据"
} elseif ($userDataDirs.Count -gt 0) {
    $userDataDirs[0]
} else {
    $userDataCandidates[0]
}

if (-not [string]::IsNullOrWhiteSpace($SettingsPath)) {
    $settingsResolved = Resolve-FullPath $SettingsPath
} else {
    $settingsResolved = $null
    foreach ($candidateDir in $userDataCandidates) {
        $candidateSettings = Join-Path $candidateDir "settings.json"
        if (Test-Path -LiteralPath $candidateSettings) {
            $settingsResolved = Resolve-FullPath $candidateSettings
            break
        }
    }
    if (-not $settingsResolved) {
        $settingsResolved = Resolve-FullPath (Join-Path $userDataCandidates[0] "settings.json")
    }
}

$dataFields = [ordered]@{}
$dataRoots = New-Object System.Collections.Generic.List[string]
$seenRoots = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)
$dataParseOk = $false

if ($settingsResolved -and (Test-Path -LiteralPath $settingsResolved)) {
    try {
        $settings = Get-Content -LiteralPath $settingsResolved -Raw -Encoding UTF8 | ConvertFrom-Json
        $requiredOk = $true
        foreach ($field in $SETTINGS_PATH_FIELDS) {
            $property = $settings.PSObject.Properties[$field]
            $value = if ($property) { [string]$property.Value } else { $null }
            $resolved = Resolve-FullPath $value
            if ([string]::IsNullOrWhiteSpace($value)) { $resolved = $null }
            $dataFields[$field] = $resolved
            if ($REQUIRED_PATH_FIELDS -contains $field -and -not $resolved) { $requiredOk = $false }
            if ($resolved) { [void]$seenRoots.Add($resolved) }
        }
        $dataParseOk = $requiredOk
    } catch {
        $dataParseOk = $false
        foreach ($field in $SETTINGS_PATH_FIELDS) { $dataFields[$field] = $null }
    }
} else {
    foreach ($field in $SETTINGS_PATH_FIELDS) { $dataFields[$field] = $null }
    $dataParseOk = $false
}

foreach ($root in $seenRoots) { $dataRoots.Add($root) }

$envVar = [Environment]::GetEnvironmentVariable("DSH_DATA_ROOT", "User")
if ([string]::IsNullOrWhiteSpace($envVar)) { $envVar = $null }

$processes = New-Object System.Collections.Generic.List[int]
$mainNames = Get-MainProcessNames $appDirResolved
$appDirForMatch = if ($appDirResolved) { $appDirResolved.TrimEnd('\') + '\' } else { $null }
foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
    if ($mainNames -contains $proc.Name) {
        [void]$processes.Add([int]$proc.Id)
        continue
    }
    try {
        if ($appDirForMatch -and $proc.Path -and $proc.Path.StartsWith($appDirForMatch, [System.StringComparison]::OrdinalIgnoreCase)) {
            [void]$processes.Add([int]$proc.Id)
        }
    } catch {
        # 部分系统进程读取 Path 会抛异常，忽略
    }
}

$report = [ordered]@{
    appDir = $appDirResolved
    roamingDir = $roamingDir
    userDataDirs = @($userDataDirs)
    settingsPath = $settingsResolved
    dataRoots = @($dataRoots)
    envVar = $envVar
    registryKey = $entry.KeyPath
    processes = @($processes | Sort-Object -Unique)
    reportGeneratedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
}
# 附加诊断字段（不影响验收必需字段）
$report["dataParseOk"] = $dataParseOk
$report["dataFields"] = $dataFields
$report["mainProcessNames"] = @($mainNames)
$report["registryDisplayName"] = $entry.DisplayName

$json = $report | ConvertTo-Json -Depth 6
$outDir = Split-Path -Parent $OutputPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
[System.IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("扫描完成：{0}" -f $OutputPath)
Write-Host ("  应用目录：{0}" -f $appDirResolved)
Write-Host ("  用户数据（主）：{0}" -f $roamingDir)
Write-Host ("  用户数据候选（存在）：{0}" -f $(if ($userDataDirs.Count -gt 0) { $userDataDirs -join "; " } else { "(无)" }))
Write-Host ("  设置文件：{0}（可解析={1}）" -f $settingsResolved, $dataParseOk)
Write-Host ("  数据根：{0} 个" -f $dataRoots.Count)
foreach ($root in $dataRoots) { Write-Host ("    - {0}" -f $root) }
Write-Host ("  环境变量 DSH_DATA_ROOT：{0}" -f $(if ($envVar) { $envVar } else { "(空)" }))
Write-Host ("  卸载注册表项：{0}" -f $(if ($entry.KeyPath) { $entry.KeyPath } else { "(未找到)" }))
Write-Host ("  运行进程：{0}" -f $(if ($processes.Count -gt 0) { ($processes -join ', ') } else { "(无)" }))

exit 0