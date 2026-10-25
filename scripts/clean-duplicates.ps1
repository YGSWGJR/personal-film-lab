[CmdletBinding()]
param(
    [switch]$Commit,
    [switch]$Purge,
    [switch]$Check,
    [switch]$Confirm
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$quarantineRoot = Join-Path $repoRoot ".duplicates-quarantine"
$reportPath = Join-Path $PSScriptRoot "clean-duplicates-report.txt"

if (-not (Test-Path -LiteralPath $repoRoot)) {
    throw "找不到仓库根目录：$repoRoot"
}

$repoRootFull = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\')
$scanRoots = @("src", "tests", "docs", "assets", "scripts", "resources")
$excludedSegments = @(".git", "node_modules", "out", "dist", ".duplicates-quarantine")

$enabledModes = @($Commit, $Purge, $Check) | Where-Object { $_ }
if ($enabledModes.Count -gt 1) {
    throw "参数 -Commit / -Purge / -Check 只能选择一个"
}

function Test-ExcludedPath {
    param([string]$FullPath)

    $relative = $FullPath.Substring($repoRootFull.Length).TrimStart('\')
    $segments = $relative -split '\\'
    foreach ($segment in $segments) {
        if ($excludedSegments -contains $segment) { return $true }
        if ($segment -like 'release*') { return $true }
    }
    return $false
}

function Get-DuplicateNameMatch {
    param([string]$Name)

    $match = [regex]::Match($Name, '^(.*) \((\d+)\)(\.[^.]+)?$')
    if ($match.Success) {
        $number = [int]$match.Groups[2].Value
        if ($number -lt 2) { return $null }
        return [pscustomobject]@{
            BaseName = $match.Groups[1].Value.TrimEnd()
            Extension = $match.Groups[3].Value
            Number = $number
        }
    }

    $match = [regex]::Match($Name, '^\((\d+)\)(\.[^.]+)?$')
    if ($match.Success) {
        $number = [int]$match.Groups[1].Value
        if ($number -lt 2) { return $null }
        return [pscustomobject]@{
            BaseName = ""
            Extension = $match.Groups[2].Value
            Number = $number
        }
    }

    return $null
}

function Get-ScanFiles {
    $files = New-Object System.Collections.Generic.List[System.IO.FileInfo]

    Get-ChildItem -LiteralPath $repoRoot -File -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-ExcludedPath $_.FullName) } |
        ForEach-Object { $files.Add($_) }

    foreach ($root in $scanRoots) {
        $rootPath = Join-Path $repoRoot $root
        if (-not (Test-Path -LiteralPath $rootPath)) { continue }
        Get-ChildItem -LiteralPath $rootPath -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { -not (Test-ExcludedPath $_.FullName) } |
            ForEach-Object { $files.Add($_) }
    }

    return $files
}

function Get-DuplicateItems {
    $items = New-Object System.Collections.Generic.List[object]

    foreach ($file in Get-ScanFiles) {
        $nameMatch = Get-DuplicateNameMatch $file.Name
        if ($null -eq $nameMatch) { continue }

        $canonicalName = if ([string]::IsNullOrEmpty($nameMatch.BaseName)) {
            $nameMatch.Extension
        } else {
            $nameMatch.BaseName + $nameMatch.Extension
        }
        $canonicalPath = Join-Path $file.DirectoryName $canonicalName
        $relativePath = $file.FullName.Substring($repoRootFull.Length).TrimStart('\')

        $items.Add([pscustomobject]@{
            File = $file
            RelativePath = $relativePath
            CanonicalName = $canonicalName
            CanonicalExists = (Test-Path -LiteralPath $canonicalPath -PathType Leaf)
            SizeBytes = $file.Length
        })
    }

    return $items
}

function Format-SizeBytes {
    param([double]$Bytes)
    if ($Bytes -ge 1MB) { return ("{0:N2} MB" -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ("{0:N2} KB" -f ($Bytes / 1KB)) }
    return ("{0} B" -f [int]$Bytes)
}

function Show-Summary {
    param($Items)
    $totalBytes = ($Items | Measure-Object -Property SizeBytes -Sum).Sum
    if ($null -eq $totalBytes) { $totalBytes = 0 }
    Write-Host ("将处理 {0} 个副本，共 {1}" -f $Items.Count, (Format-SizeBytes $totalBytes))
    $byDirectory = $Items | Group-Object {
        $parts = $_.RelativePath -split '\\'
        if ($parts.Count -le 1) { "(root)" } else { $parts[0] }
    } | Sort-Object Name
    foreach ($group in $byDirectory) {
        Write-Host ("  {0} = {1}" -f $group.Name, $group.Count)
    }
}

function Invoke-Check {
    $items = @(Get-DuplicateItems)
    $missingCanonical = @($items | Where-Object { -not $_.CanonicalExists })
    Write-Host ("当前副本数：{0}（其中找不到规范文件的：{1}）" -f $items.Count, $missingCanonical.Count)
    if ($items.Count -eq 0) { return 0 }
    return 1
}

function Invoke-DryRun {
    $items = @(Get-DuplicateItems)
    Show-Summary $items
    foreach ($item in $items | Sort-Object RelativePath) {
        $flag = if ($item.CanonicalExists) { "" } else { "  [警告：找不到规范文件]" }
        Write-Host ("  {0}  ({1}){2}" -f $item.RelativePath, (Format-SizeBytes $item.SizeBytes), $flag)
    }
    Write-Host ""
    Write-Host "dry-run 完成：未移动/删除任何文件。确认后执行 -Commit 移入 .duplicates-quarantine/。"
    return 0
}

function Invoke-Commit {
    $items = @(Get-DuplicateItems | Sort-Object RelativePath)
    if ($items.Count -eq 0) {
        Write-Host "没有需要清理的副本。"
        return 0
    }

    Show-Summary $items
    New-Item -ItemType Directory -Force -Path $quarantineRoot | Out-Null

    $moved = 0
    $skipped = 0
    $movedBytes = 0
    $reportLines = New-Object System.Collections.Generic.List[string]
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

    $reportLines.Add("# clean-duplicates 清理报告")
    $reportLines.Add("# 执行时间：$timestamp")
    $reportLines.Add("# 仓库：$repoRoot")
    $reportLines.Add("# 格式：相对路径`t大小`t字节`t动作`t时间")
    $reportLines.Add("")

    foreach ($item in $items) {
        if (-not $item.CanonicalExists) {
            $skipped++
            $reportLines.Add(("{0}`t{1}`t{2}`tSKIP(无规范文件)`t{3}" -f $item.RelativePath, (Format-SizeBytes $item.SizeBytes), $item.SizeBytes, $timestamp))
            Write-Warning ("跳过（找不到规范文件 {0}）：{1}" -f $item.CanonicalName, $item.RelativePath)
            continue
        }

        $targetPath = Join-Path $quarantineRoot $item.RelativePath
        $targetDir = Split-Path -Parent $targetPath
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

        if (Test-Path -LiteralPath $targetPath) {
            $skipped++
            $reportLines.Add(("{0}`t{1}`t{2}`tSKIP(隔离区已存在)`t{3}" -f $item.RelativePath, (Format-SizeBytes $item.SizeBytes), $item.SizeBytes, $timestamp))
            continue
        }

        try {
            Move-Item -LiteralPath $item.File.FullName -Destination $targetPath -Force
            $moved++
            $movedBytes += $item.SizeBytes
            $reportLines.Add(("{0}`t{1}`t{2}`tMOVED`t{3}" -f $item.RelativePath, (Format-SizeBytes $item.SizeBytes), $item.SizeBytes, $timestamp))
        } catch {
            $skipped++
            $reportLines.Add(("{0}`t{1}`t{2}`tFAILED({3})`t{4}" -f $item.RelativePath, (Format-SizeBytes $item.SizeBytes), $item.SizeBytes, $_.Exception.Message, $timestamp))
            Write-Warning ("移动失败：{0} -> {1}" -f $item.RelativePath, $_.Exception.Message)
        }
    }

    $reportLines.Add("")
    $reportLines.Add(("# 合计：移动 {0} 个（{1}），跳过 {2} 个" -f $moved, (Format-SizeBytes $movedBytes), $skipped))
    [System.IO.File]::WriteAllLines($reportPath, $reportLines, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host ("已移动 {0} 个副本到隔离区（{1}），跳过 {2} 个。" -f $moved, (Format-SizeBytes $movedBytes), $skipped)
    Write-Host ("报告：{0}" -f $reportPath)

    $remaining = @(Get-DuplicateItems)
    Write-Host ("剩余副本数：{0}" -f $remaining.Count)
    if ($remaining.Count -gt 0) {
        Write-Warning "仍有副本残留，请检查报告中的 SKIP/FAILED 记录。"
    }
    return 0
}

function Invoke-Purge {
    if (-not $Confirm) {
        throw "-Purge 不可恢复，请追加 -Confirm 明确确认后再执行"
    }
    if (-not (Test-Path -LiteralPath $quarantineRoot)) {
        Write-Host "隔离目录不存在，无需清理：$quarantineRoot"
        return 0
    }

    $files = @(Get-ChildItem -LiteralPath $quarantineRoot -Recurse -File -ErrorAction SilentlyContinue)
    $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $totalBytes) { $totalBytes = 0 }
    Write-Host ("即将删除隔离目录：{0}" -f $quarantineRoot)
    Write-Host ("隔离文件数：{0}，共 {1}" -f $files.Count, (Format-SizeBytes $totalBytes))

    Remove-Item -LiteralPath $quarantineRoot -Recurse -Force
    Write-Host ("已删除隔离目录，释放 {0}。" -f (Format-SizeBytes $totalBytes))
    return 0
}

try {
    if ($Purge) { exit (Invoke-Purge) }
    if ($Commit) { exit (Invoke-Commit) }
    if ($Check) { exit (Invoke-Check) }
    exit (Invoke-DryRun)
} catch {
    Write-Host ("执行失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
    exit 2
}