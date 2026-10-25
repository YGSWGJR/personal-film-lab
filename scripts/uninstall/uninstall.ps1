[CmdletBinding()]
param(
    [string]$ReportPath,
    [ValidateSet("Gui", "Full", "KeepData", "Custom")]
    [string]$Mode = "Gui",
    [string[]]$CustomClasses = @("A", "B", "D", "E", "F"),
    [switch]$Backup,
    [switch]$DryRun,
    [switch]$NoGui,
    [switch]$SkipScan,
    [switch]$UiSmoke,
    [string]$LogPath,
    [string]$ResultPath
)

if ([string]::IsNullOrWhiteSpace($ReportPath)) { $ReportPath = Join-Path $PSScriptRoot "uninstall-report.json" }
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $PSScriptRoot "uninstall-log.txt" }
if ([string]::IsNullOrWhiteSpace($ResultPath)) { $ResultPath = Join-Path $PSScriptRoot "uninstall-result.json" }

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$CLASS_LABELS = [ordered]@{
    A = "应用本体"
    B = "用户设置"
    C = "数据根"
    D = "环境变量"
    E = "注册表"
    F = "运行进程"
}
$KEEP_CACHE_DIRS = @(
    "Cache", "Code Cache", "GPUCache", "GPUPersistentCache", "GrShaderCache", "ShaderCache",
    "DawnGraphiteCache", "DawnWebGPUCache", "Session Storage", "Local Storage", "Network",
    "blob_storage", "Shared Dictionary", "DIPS", "Crashpad", "logs", "lapian"
)
$KEEP_CACHE_FILE_PATTERNS = @("*.tmp", "session*.json")
$START_MENU_PATHS = @(
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu")
)
$DESKTOP_PATHS = @(
    [Environment]::GetFolderPath("Desktop"),
    (Join-Path $env:PUBLIC "Desktop")
)

$script:LogLines = New-Object System.Collections.Generic.List[string]
$script:FreedBytes = 0
$script:ClassResults = [ordered]@{}
$script:UnsafeTargets = New-Object System.Collections.Generic.List[string]
$script:LastError = $null

function Resolve-SafePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return [System.IO.Path]::GetFullPath($Path).TrimEnd("\") } catch { return $null }
}

function Write-UninstallLog {
    param([string]$Class, [string]$Result, [string]$Target, [string]$Detail = "")
    $line = "[{0}] [{1}] [{2}] {3}{4}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Class, $Result, $Target, $(if ($Detail) { " | $Detail" } else { "" })
    $script:LogLines.Add($line)
    try {
        $logDir = Split-Path -Parent $LogPath
        if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        [System.IO.File]::AppendAllText($LogPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Get-PathSizeBytes {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return 0 }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (-not $item.PSIsContainer) { return [int64]$item.Length }
        $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($null -eq $sum) { return 0 }
        return [int64]$sum
    } catch { return 0 }
}

function Format-Size {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ("{0:N2} GB" -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ("{0:N2} MB" -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ("{0:N2} KB" -f ($Bytes / 1KB)) }
    return ("{0} B" -f [int]$Bytes)
}

function Get-ScanData {
    if (-not $SkipScan) {
        $scanScript = Join-Path $PSScriptRoot "scan-uninstall.ps1"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanScript -OutputPath $ReportPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "扫描失败（scan-uninstall.ps1 退出码 $LASTEXITCODE）" }
    }
    if (-not (Test-Path -LiteralPath $ReportPath)) { throw "找不到扫描报告：$ReportPath" }
    $json = Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return $json
}

function Get-AllowedRoots {
    param($Report)
    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($root in @($Report.appDir, $Report.roamingDir)) {
        $resolved = Resolve-SafePath $root
        if ($resolved) { $roots.Add($resolved) }
    }
    $roamingBase = Resolve-SafePath (Join-Path $env:APPDATA "personal-film-lab")
    if ($roamingBase) { $roots.Add($roamingBase) }
    foreach ($root in @($Report.dataRoots)) {
        $resolved = Resolve-SafePath $root
        if ($resolved) { $roots.Add($resolved) }
    }
    return @($roots | Sort-Object -Unique)
}

function Test-SafeDeleteTarget {
    param([string]$Target, [string[]]$AllowedRoots)
    $resolved = Resolve-SafePath $Target
    if (-not $resolved) { return $false }
    # 驱动器根目录永不删除
    if ($resolved -match "^[A-Za-z]:$") { return $false }

    # 系统/程序目录硬拒绝（即使被伪造清单列为允许根也不放行）
    foreach ($deny in @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)) {
        if ([string]::IsNullOrWhiteSpace($deny)) { continue }
        $denyResolved = Resolve-SafePath $deny
        if ($denyResolved -and ($resolved -eq $denyResolved -or $resolved.StartsWith($denyResolved + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
            return $false
        }
    }

    # 用户主目录只允许其下的 Roaming\personal-film-lab 子树
    $userProfile = Resolve-SafePath $env:USERPROFILE
    $roamingBase = Resolve-SafePath (Join-Path $env:APPDATA "personal-film-lab")
    if ($userProfile -and ($resolved -eq $userProfile -or $resolved.StartsWith($userProfile + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
        if (-not $roamingBase) { return $false }
        $inRoaming = ($resolved -eq $roamingBase -or $resolved.StartsWith($roamingBase + "\", [System.StringComparison]::OrdinalIgnoreCase))
        if (-not $inRoaming) { return $false }
    }

    foreach ($root in $AllowedRoots) {
        $rootResolved = Resolve-SafePath $root
        if (-not $rootResolved) { continue }
        if ($resolved -eq $rootResolved -or $resolved.StartsWith($rootResolved + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Remove-SafeTarget {
    param(
        [string]$Class,
        [string]$Target,
        [string[]]$AllowedRoots,
        [switch]$IsFile
    )
    if ([string]::IsNullOrWhiteSpace($Target)) {
        Write-UninstallLog $Class "SKIP" "(空路径)" "路径为空"
        return
    }
    if (-not (Test-Path -LiteralPath $Target)) {
        Write-UninstallLog $Class "SKIP" $Target "不存在"
        return
    }
    $resolved = Resolve-SafePath $Target
    if (-not (Test-SafeDeleteTarget $resolved $AllowedRoots)) {
        $script:UnsafeTargets.Add($Target)
        Write-UninstallLog $Class "SKIP-UNSAFE" $Target "不在白名单根内或为受保护路径"
        return
    }
    $size = Get-PathSizeBytes $resolved
    if ($DryRun) {
        $script:FreedBytes += $size
        Write-UninstallLog $Class "DRY-RUN" $resolved ("将删除，{0}" -f (Format-Size $size))
        return
    }
    try {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
        $script:FreedBytes += $size
        Write-UninstallLog $Class "OK" $resolved ("已删除，{0}" -f (Format-Size $size))
    } catch {
        Write-UninstallLog $Class "FAILED" $resolved $_.Exception.Message
    }
}

function Stop-AppProcesses {
    param($Report, [string[]]$AllowedRoots)
    $pids = @($Report.processes)
    if ($pids.Count -eq 0) {
        Write-UninstallLog "F" "SKIP" "(无匹配进程)" "无运行中的 electron 进程"
        return $true
    }
    if ($DryRun) {
        Write-UninstallLog "F" "DRY-RUN" ("PID: " + ($pids -join ", ")) "将结束这些进程"
        return $true
    }
    foreach ($pidValue in $pids) {
        try {
            $proc = Get-Process -Id $pidValue -ErrorAction Stop
            $path = $null
            try { $path = $proc.Path } catch { $path = $null }
            $nameOk = @($Report.mainProcessNames) -contains $proc.Name
            $pathOk = $false
            if ($path) {
                $appDir = Resolve-SafePath $Report.appDir
                $pathOk = $appDir -and $path.StartsWith($appDir + "\", [System.StringComparison]::OrdinalIgnoreCase)
            }
            if (-not ($nameOk -or $pathOk)) {
                Write-UninstallLog "F" "SKIP-UNSAFE" ("PID $pidValue") "进程不属于本应用"
                continue
            }
            Stop-Process -Id $pidValue -Force -ErrorAction Stop
            Write-UninstallLog "F" "OK" ("PID $pidValue / $($proc.Name)") "已结束"
        } catch {
            Write-UninstallLog "F" "FAILED" ("PID $pidValue") $_.Exception.Message
        }
    }
    Start-Sleep -Milliseconds 800
    $remaining = New-Object System.Collections.Generic.List[string]
    foreach ($pidValue in $pids) {
        if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { $remaining.Add([string]$pidValue) }
    }
    if ($remaining.Count -gt 0) {
        $script:LastError = "以下进程未能结束：$($remaining -join ', ')。请手动关闭软件后重试。"
        Write-UninstallLog "F" "FAILED" ("PID: " + ($remaining -join ", ")) $script:LastError
        return $false
    }
    return $true
}

function Remove-UserSettings {
    param($Report, [string[]]$AllowedRoots, [bool]$Full)
    if ($Full) {
        Remove-SafeTarget "B" $Report.roamingDir $AllowedRoots
        return
    }
    $roaming = Resolve-SafePath $Report.roamingDir
    if (-not $roaming -or -not (Test-Path -LiteralPath $roaming)) {
        Write-UninstallLog "B" "SKIP" $Report.roamingDir "目录不存在"
        return
    }
    foreach ($dirName in $KEEP_CACHE_DIRS) {
        $target = Join-Path $roaming $dirName
        Remove-SafeTarget "B" $target $AllowedRoots
    }
    foreach ($pattern in $KEEP_CACHE_FILE_PATTERNS) {
        foreach ($file in @(Get-ChildItem -LiteralPath $roaming -Filter $pattern -File -Force -ErrorAction SilentlyContinue)) {
            Remove-SafeTarget "B" $file.FullName $AllowedRoots -IsFile
        }
    }
    Write-UninstallLog "B" "OK" $roaming "已清理缓存类残留（保留 settings.json）"
}

function Remove-EnvVar {
    param($Report)
    $name = "DSH_DATA_ROOT"
    $current = [Environment]::GetEnvironmentVariable($name, "User")
    if ([string]::IsNullOrWhiteSpace($current)) {
        Write-UninstallLog "D" "SKIP" $name "用户级变量不存在"
        return
    }
    if ($DryRun) {
        Write-UninstallLog "D" "DRY-RUN" $name ("当前值：" + $current)
        return
    }
    try {
        [Environment]::SetEnvironmentVariable($name, $null, "User")
        $after = [Environment]::GetEnvironmentVariable($name, "User")
        if ([string]::IsNullOrWhiteSpace($after)) {
            Write-UninstallLog "D" "OK" $name "已删除用户级环境变量"
        } else {
            Write-UninstallLog "D" "FAILED" $name "删除后仍存在"
        }
    } catch {
        Write-UninstallLog "D" "FAILED" $name $_.Exception.Message
    }
}

function Remove-DataRoots {
    param($Report, [string[]]$AllowedRoots)
    if (-not $Report.dataParseOk) {
        Write-UninstallLog "C" "SKIP-UNSAFE" "(数据根)" "settings.json 无法解析，按安全策略拒绝删除数据目录"
        return
    }
    $roots = @($Report.dataRoots)
    if ($roots.Count -eq 0) {
        Write-UninstallLog "C" "SKIP" "(数据根)" "未解析到数据目录"
        return
    }
    foreach ($root in $roots) {
        Remove-SafeTarget "C" $root $AllowedRoots
    }
}

function Remove-AppDir {
    param($Report, [string[]]$AllowedRoots)
    $appDir = Resolve-SafePath $Report.appDir
    if (-not $appDir) {
        Write-UninstallLog "A" "SKIP" $Report.appDir "未找到安装目录"
        return
    }
    $scriptDir = Resolve-SafePath $PSScriptRoot
    if ($scriptDir -and ($scriptDir -eq $appDir -or $scriptDir.StartsWith($appDir + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
        $script:LastError = "卸载脚本位于应用安装目录内，无法在运行时删除自身。请把卸载工具放到其他目录后重试。"
        Write-UninstallLog "A" "SKIP-UNSAFE" $appDir $script:LastError
        return
    }
    Remove-SafeTarget "A" $appDir $AllowedRoots
}

function Remove-RegistryEntry {
    param($Report)
    $key = $Report.registryKey
    if ([string]::IsNullOrWhiteSpace($key)) {
        Write-UninstallLog "E" "SKIP" "(注册表)" "未找到卸载注册表项"
        return
    }
    if ($key -notmatch "Uninstall\\[^\\]+$") {
        Write-UninstallLog "E" "SKIP-UNSAFE" $key "不是预期的卸载项"
        return
    }
    try {
        $props = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        if (-not $props.DisplayName -or $props.DisplayName -notlike "*个人拉片工作台*") {
            Write-UninstallLog "E" "SKIP-UNSAFE" $key "DisplayName 不匹配，拒绝删除"
            return
        }
    } catch {
        Write-UninstallLog "E" "SKIP-UNSAFE" $key "无法读取注册表项，拒绝删除"
        return
    }
    if ($DryRun) {
        Write-UninstallLog "E" "DRY-RUN" $key "将删除卸载注册表项"
        return
    }
    try {
        Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction Stop
        Write-UninstallLog "E" "OK" $key "已删除卸载注册表项"
    } catch {
        Write-UninstallLog "E" "FAILED" $key $_.Exception.Message
    }
}

function Remove-Shortcuts {
    $deleted = 0
    $seenLinks = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($dir in @($START_MENU_PATHS + $DESKTOP_PATHS)) {
        if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
        $links = @(Get-ChildItem -LiteralPath $dir -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*个人拉片*" })
        foreach ($link in $links) {
            if (-not $seenLinks.Add($link.FullName)) { continue }
            $resolvedDir = Resolve-SafePath $dir
            $resolvedLink = Resolve-SafePath $link.FullName
            if (-not $resolvedDir -or -not $resolvedLink -or -not $resolvedLink.StartsWith($resolvedDir + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-UninstallLog "S" "SKIP-UNSAFE" $link.FullName "快捷方式路径异常"
                continue
            }
            if ($DryRun) {
                Write-UninstallLog "S" "DRY-RUN" $link.FullName "将删除快捷方式"
                $deleted++
                continue
            }
            try {
                Remove-Item -LiteralPath $link.FullName -Force -ErrorAction Stop
                Write-UninstallLog "S" "OK" $link.FullName "已删除快捷方式"
                $deleted++
            } catch {
                Write-UninstallLog "S" "FAILED" $link.FullName $_.Exception.Message
            }
        }
    }
    if ($deleted -eq 0) { Write-UninstallLog "S" "SKIP" "(快捷方式)" "未找到个人拉片快捷方式" }
}

function New-Backup {
    param($Report)
    $settings = Resolve-SafePath $Report.settingsPath
    $dbPath = $null
    foreach ($root in @($Report.dataRoots)) {
        $candidate = Join-Path $root "lapian.db"
        if (Test-Path -LiteralPath $candidate) { $dbPath = $candidate; break }
    }
    $files = @()
    if ($settings -and (Test-Path -LiteralPath $settings)) { $files += $settings }
    if ($dbPath -and (Test-Path -LiteralPath $dbPath)) { $files += $dbPath }
    if ($files.Count -eq 0) {
        Write-UninstallLog "BACKUP" "SKIP" "(备份)" "没有可备份的 settings.json / lapian.db"
        return $null
    }
    $backupDir = Join-Path (Split-Path -Parent $PSScriptRoot) "卸载备份"
    if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
    $zipPath = Join-Path $backupDir ("uninstall-backup-{0}.zip" -f (Get-Date).ToString("yyyyMMdd-HHmmss"))
    try {
        Compress-Archive -LiteralPath $files -DestinationPath $zipPath -CompressionLevel Optimal -Force
        Write-UninstallLog "BACKUP" "OK" $zipPath ("已备份：" + ($files -join "; "))
        return $zipPath
    } catch {
        Write-UninstallLog "BACKUP" "FAILED" $zipPath $_.Exception.Message
        return $null
    }
}

function Invoke-Uninstall {
    param(
        [string]$SelectedMode,
        [string[]]$SelectedClasses,
        [bool]$DoBackup,
        $Report,
        [scriptblock]$ProgressCallback
    )
    $classes = New-Object System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($class in $SelectedClasses) { [void]$classes.Add($class.ToUpper()) }
    $fullSettings = ($SelectedMode -eq "Full")
    $modeLabels = @{ Full = "完整卸载"; KeepData = "保留数据卸载"; Custom = "自定义勾选" }

    $allowedRoots = Get-AllowedRoots $Report
    Write-UninstallLog "INFO" "START" ("模式=" + $modeLabels[$SelectedMode] + "; 类=" + (@($classes) -join ",") + "; DryRun=" + [bool]$DryRun)

    $backupDone = $false
    if ($DoBackup -and -not $classes.Contains("F")) { [void](New-Backup $Report); $backupDone = $true }

    $order = @("F", "B", "D", "C", "A", "E")
    $index = 0
    foreach ($class in $order) {
        $index++
        if ($ProgressCallback) { & $ProgressCallback $index $order.Count $class }
        if (-not $classes.Contains($class)) {
            Write-UninstallLog $class "SKIP" "(未选择)" "模式未包含该类"
            continue
        }
        switch ($class) {
            "F" {
                $ok = Stop-AppProcesses $Report $allowedRoots
                if (-not $ok) {
                    Write-UninstallLog "INFO" "ABORT" "(进程)" "进程未能结束，已中止后续删除"
                    return $false
                }
                if ($DoBackup -and -not $backupDone) { [void](New-Backup $Report); $backupDone = $true }
            }
            "B" { Remove-UserSettings $Report $allowedRoots $fullSettings }
            "D" { Remove-EnvVar $Report }
            "C" { Remove-DataRoots $Report $allowedRoots }
            "A" { Remove-AppDir $Report $allowedRoots }
            "E" { Remove-RegistryEntry $Report }
        }
    }
    if ($classes.Contains("A")) { Remove-Shortcuts }
    return $true
}
# ---------------- WinForms 向导 ----------------

$script:SelectedMode = "KeepData"
$script:CustomClasses = @("A", "B", "D", "E", "F")
$script:DoBackup = $true
$script:BackupPath = $null
$script:Step = 1
$script:Executing = $false
$script:Report = $null
$script:AllowedRoots = @()
$script:ContentPanel = $null
$script:BtnBack = $null
$script:BtnNext = $null
$script:BtnCancel = $null
$script:ModeRadios = @{}
$script:CustomChecks = @{}
$script:CustomPanel = $null
$script:BackupCheck = $null
$script:ProgressBar = $null
$script:StatusLabel = $null

function New-UiFont {
    param([double]$Size, [bool]$Bold = $false)
    $style = if ($Bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    return New-Object System.Drawing.Font("Microsoft YaHei UI", $Size, $style)
}

function New-MainForm {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "卸载个人拉片工作台"
    $form.ClientSize = New-Object System.Drawing.Size(920, 680)
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.Font = New-UiFont 9

    $header = New-Object System.Windows.Forms.Label
    $header.Text = "个人拉片工作台 · 卸载向导"
    $header.Font = New-UiFont 15 $true
    $header.AutoSize = $true
    $header.Location = New-Object System.Drawing.Point(24, 18)
    $form.Controls.Add($header)

    $subHeader = New-Object System.Windows.Forms.Label
    $subHeader.Text = "S31 卸载工具 V1 · 六类清理（应用本体 / 用户设置 / 数据根 / 环境变量 / 注册表 / 运行进程）"
    $subHeader.ForeColor = [System.Drawing.Color]::DimGray
    $subHeader.AutoSize = $true
    $subHeader.Location = New-Object System.Drawing.Point(26, 52)
    $form.Controls.Add($subHeader)

    $bottom = New-Object System.Windows.Forms.Panel
    $bottom.Dock = [System.Windows.Forms.DockStyle]::Bottom
    $bottom.Height = 64
    $form.Controls.Add($bottom)

    $script:BtnCancel = New-Object System.Windows.Forms.Button
    $script:BtnCancel.Text = "取消"
    $script:BtnCancel.Size = New-Object System.Drawing.Size(96, 32)
    $script:BtnCancel.Location = New-Object System.Drawing.Point(800, 16)
    $script:BtnCancel.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
    $bottom.Controls.Add($script:BtnCancel)

    $script:BtnNext = New-Object System.Windows.Forms.Button
    $script:BtnNext.Text = "下一步"
    $script:BtnNext.Size = New-Object System.Drawing.Size(96, 32)
    $script:BtnNext.Location = New-Object System.Drawing.Point(696, 16)
    $script:BtnNext.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
    $bottom.Controls.Add($script:BtnNext)

    $script:BtnBack = New-Object System.Windows.Forms.Button
    $script:BtnBack.Text = "返回"
    $script:BtnBack.Size = New-Object System.Drawing.Size(96, 32)
    $script:BtnBack.Location = New-Object System.Drawing.Point(592, 16)
    $script:BtnBack.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
    $bottom.Controls.Add($script:BtnBack)

    $script:ContentPanel = New-Object System.Windows.Forms.Panel
    $script:ContentPanel.Location = New-Object System.Drawing.Point(24, 82)
    $script:ContentPanel.Size = New-Object System.Drawing.Size(872, 520)
    $form.Controls.Add($script:ContentPanel)

    $script:BtnCancel.Add_Click({
        if ($script:Executing) { return }
        $answer = [System.Windows.Forms.MessageBox]::Show("确定退出卸载向导吗？不会执行任何删除。", "确认退出", "YesNo", "Question")
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { $script:MainForm.Close() }
    })
    $script:BtnNext.Add_Click({
        switch ($script:Step) {
            1 { Show-Step2 }
            2 { Show-Step3 }
            3 { Start-UninstallFromUi }
        }
    })
    $script:BtnBack.Add_Click({
        switch ($script:Step) {
            2 { Show-Step1 }
            3 { Show-Step2 }
        }
    })

    $script:MainForm = $form
    return $form
}

function Reset-Content {
    $script:ContentPanel.SuspendLayout()
    $script:ContentPanel.Controls.Clear()
    $script:ContentPanel.ResumeLayout()
}

function Set-NavState {
    param([bool]$BackEnabled, [string]$NextText = "下一步", [bool]$NextEnabled = $true, [bool]$CancelEnabled = $true)
    $script:BtnBack.Enabled = $BackEnabled
    $script:BtnNext.Text = $NextText
    $script:BtnNext.Enabled = $NextEnabled
    $script:BtnCancel.Enabled = $CancelEnabled
}

function Add-SectionTitle {
    param([string]$Text, [int]$Y)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Font = New-UiFont 11 $true
    $label.AutoSize = $true
    $label.Location = New-Object System.Drawing.Point(0, $Y)
    $script:ContentPanel.Controls.Add($label)
}

function Show-Step1 {
    $script:Step = 1
    Reset-Content
    Set-NavState $false "下一步"
    Add-SectionTitle "第 1 步 / 4 · 检测残留" 0

    $report = $script:Report
    $roamingSize = Get-PathSizeBytes $report.roamingDir
    $dataLines = New-Object System.Collections.Generic.List[string]
    $totalData = [int64]0
    foreach ($root in @($report.dataRoots)) {
        $size = Get-PathSizeBytes $root
        $totalData += $size
        $dataLines.Add(("    - {0}（{1}）" -f $root, (Format-Size $size)))
    }
    if ($dataLines.Count -eq 0) { $dataLines.Add("    (未解析到数据目录)") }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("安装目录：")
    $lines.Add(("    {0}" -f $report.appDir))
    $lines.Add("")
    $lines.Add("用户数据目录（Roaming）：")
    $lines.Add(("    {0}（{1}）" -f $report.roamingDir, (Format-Size $roamingSize)))
    $lines.Add("")
    $lines.Add(("设置文件：{0}" -f $report.settingsPath))
    $lines.Add(("    可解析：{0}" -f $(if ($report.dataParseOk) { "是" } else { "否（数据根删除将被禁用）" })))
    $lines.Add("")
    $lines.Add("数据根（由 settings.json 解析，共 $(@($report.dataRoots).Count) 个，合计 $(Format-Size $totalData)）：")
    foreach ($line in $dataLines) { $lines.Add($line) }
    $lines.Add("")
    $lines.Add(("环境变量 DSH_DATA_ROOT：{0}" -f $(if ($report.envVar) { $report.envVar } else { "(空)" })))
    $lines.Add(("卸载注册表项：{0}" -f $(if ($report.registryKey) { $report.registryKey } else { "(未找到)" })))
    $lines.Add(("运行中的进程：{0}" -f $(if (@($report.processes).Count -gt 0) { (@($report.processes) -join ", ") } else { "(无)" })))
    $lines.Add("")
    if (-not $report.dataParseOk) {
        $lines.Add("⚠ 设置文件无法解析或必需字段缺失：按安全策略，本次不会删除数据根（C 类）。")
    }

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ReadOnly = $true
    $box.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $box.Font = New-UiFont 9
    $box.WordWrap = $true
    $box.Location = New-Object System.Drawing.Point(0, 34)
    $box.Size = New-Object System.Drawing.Size(860, 480)
    $box.Text = ($lines -join "`r`n")
    $script:ContentPanel.Controls.Add($box)
}

function Update-CustomVisibility {
    if ($script:CustomPanel) {
        $script:CustomPanel.Visible = ($script:SelectedMode -eq "Custom")
    }
}

function Show-Step2 {
    $script:Step = 2
    Reset-Content
    Set-NavState $true "下一步"
    Add-SectionTitle "第 2 步 / 4 · 选择卸载模式" 0

    $script:ModeRadios = @{}
    $modes = @(
        @{ Key = "Full"; Text = "完整卸载（A+B+C+D+E+F 全清，不可恢复）" },
        @{ Key = "KeepData"; Text = "保留数据卸载（推荐）——删除应用/设置/缓存/环境变量/注册表，保留项目数据" },
        @{ Key = "Custom"; Text = "自定义勾选——逐类选择要清理的内容" }
    )
    $y = 40
    foreach ($modeDef in $modes) {
        $radio = New-Object System.Windows.Forms.RadioButton
        $radio.Text = $modeDef.Text
        $radio.AutoSize = $true
        $radio.Location = New-Object System.Drawing.Point(4, $y)
        $radio.Checked = ($script:SelectedMode -eq $modeDef.Key)
        $radio.Tag = $modeDef.Key
        $radio.Add_CheckedChanged({
            if ($this.Checked) {
                $script:SelectedMode = [string]$this.Tag
                Update-CustomVisibility
            }
        })
        $script:ContentPanel.Controls.Add($radio)
        $script:ModeRadios[$modeDef.Key] = $radio
        $y += 38
    }

    $script:CustomPanel = New-Object System.Windows.Forms.Panel
    $script:CustomPanel.Location = New-Object System.Drawing.Point(24, ($y + 8))
    $script:CustomPanel.Size = New-Object System.Drawing.Size(820, 250)
    $script:ContentPanel.Controls.Add($script:CustomPanel)

    $title = New-Object System.Windows.Forms.Label
    $title.Text = "自定义清理项（数据类默认保留）："
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point(0, 0)
    $script:CustomPanel.Controls.Add($title)

    $script:CustomChecks = @{}
    $cy = 30
    foreach ($class in @("A", "B", "C", "D", "E", "F")) {
        $check = New-Object System.Windows.Forms.CheckBox
        $label = $CLASS_LABELS[$class]
        $check.Text = ("{0} · {1}" -f $class, $label)
        $check.AutoSize = $true
        $check.Location = New-Object System.Drawing.Point(10, $cy)
        $check.Checked = ($script:CustomClasses -contains $class)
        if ($class -eq "C" -and -not $script:Report.dataParseOk) {
            $check.Checked = $false
            $check.Enabled = $false
            $check.Text = ("{0} · {1}（设置文件无法解析，已禁用）" -f $class, $label)
        }
        $check.Tag = $class
        $check.Add_CheckedChanged({
            $classKey = [string]$this.Tag
            $set = New-Object System.Collections.Generic.List[string]
            foreach ($key in $script:CustomChecks.Keys) {
                if ($script:CustomChecks[$key].Checked) { $set.Add($key) }
            }
            $script:CustomClasses = @($set)
        })
        $script:CustomPanel.Controls.Add($check)
        $script:CustomChecks[$class] = $check
        $cy += 32
    }

    Update-CustomVisibility
}

function Get-EffectiveClasses {
    switch ($script:SelectedMode) {
        "Full" { return @("A", "B", "C", "D", "E", "F") }
        "KeepData" { return @("A", "B", "D", "E", "F") }
        default {
            $set = @($script:CustomClasses)
            if ($set.Count -eq 0) { return @() }
            return $set
        }
    }
}

function Show-Step3 {
    $script:Step = 3
    Reset-Content
    Set-NavState $true "开始卸载"
    Add-SectionTitle "第 3 步 / 4 · 确认清理清单" 0

    $classes = @(Get-EffectiveClasses)
    $modeText = @{ Full = "完整卸载"; KeepData = "保留数据卸载"; Custom = "自定义勾选" }[$script:SelectedMode]
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add(("模式：{0}" -f $modeText))
    $lines.Add(("将清理：{0}" -f (($classes | ForEach-Object { "$_($($CLASS_LABELS[$_]))" }) -join "、")))
    $lines.Add("")
    $lines.Add(("A 应用本体：{0}" -f $script:Report.appDir))
    if ($classes -contains "B") {
        if ($script:SelectedMode -eq "Full" -or $script:SelectedMode -eq "Custom") {
            $lines.Add(("B 用户设置：整目录删除 {0}" -f $script:Report.roamingDir))
        } else {
            $lines.Add(("B 用户设置：仅清理缓存类残留，保留 settings.json（{0}）" -f $script:Report.roamingDir))
        }
    }
    if ($classes -contains "C") {
        $lines.Add("C 数据根（不可恢复）：")
        foreach ($root in @($script:Report.dataRoots)) { $lines.Add(("    - {0}" -f $root)) }
    }
    if ($classes -contains "D") { $lines.Add("D 环境变量：DSH_DATA_ROOT（用户级）") }
    if ($classes -contains "E") { $lines.Add("E 注册表：卸载项 $($script:Report.registryKey)") }
    if ($classes -contains "F") { $lines.Add("F 运行进程：结束本应用 electron 进程") }
    $lines.Add("")
    if (-not $script:Report.dataParseOk) {
        $lines.Add("⚠ 设置文件无法解析：C 数据根类已禁用/将被跳过。")
    }

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ReadOnly = $true
    $box.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $box.Location = New-Object System.Drawing.Point(0, 34)
    $box.Size = New-Object System.Drawing.Size(860, 330)
    $box.Text = ($lines -join "`r`n")
    $script:ContentPanel.Controls.Add($box)

    $script:BackupCheck = New-Object System.Windows.Forms.CheckBox
    $script:BackupCheck.Text = "卸载前备份 settings.json 与项目数据库（lapian.db）到「卸载备份」目录"
    $script:BackupCheck.AutoSize = $true
    $script:BackupCheck.Checked = $script:DoBackup
    $script:BackupCheck.Location = New-Object System.Drawing.Point(2, 378)
    $script:BackupCheck.Add_CheckedChanged({ $script:DoBackup = $this.Checked })
    $script:ContentPanel.Controls.Add($script:BackupCheck)

    $warn = New-Object System.Windows.Forms.Label
    $warn.Text = "⚠ 删除操作不可逆，请确认已备份重要数据。"
    $warn.ForeColor = [System.Drawing.Color]::Firebrick
    $warn.Font = New-UiFont 10 $true
    $warn.AutoSize = $true
    $warn.Location = New-Object System.Drawing.Point(2, 414)
    $script:ContentPanel.Controls.Add($warn)

    if ($DryRun) {
        $dryLabel = New-Object System.Windows.Forms.Label
        $dryLabel.Text = "当前为 DryRun 模式：只记录日志，不实际删除。"
        $dryLabel.ForeColor = [System.Drawing.Color]::DarkOrange
        $dryLabel.AutoSize = $true
        $dryLabel.Location = New-Object System.Drawing.Point(2, 446)
        $script:ContentPanel.Controls.Add($dryLabel)
    }
}

function Start-UninstallFromUi {
    $script:Step = 4
    Reset-Content
    Set-NavState $false "执行中…" $false $false
    Add-SectionTitle "第 4 步 / 4 · 执行卸载" 0

    $script:ProgressBar = New-Object System.Windows.Forms.ProgressBar
    $script:ProgressBar.Location = New-Object System.Drawing.Point(0, 50)
    $script:ProgressBar.Size = New-Object System.Drawing.Size(860, 24)
    $script:ProgressBar.Minimum = 0
    $script:ProgressBar.Maximum = 100
    $script:ContentPanel.Controls.Add($script:ProgressBar)

    $script:StatusLabel = New-Object System.Windows.Forms.Label
    $script:StatusLabel.Text = "准备执行…"
    $script:StatusLabel.AutoSize = $true
    $script:StatusLabel.Location = New-Object System.Drawing.Point(0, 86)
    $script:ContentPanel.Controls.Add($script:StatusLabel)

    $script:Executing = $true
    $classes = @(Get-EffectiveClasses)
    $progressCallback = {
        param($index, $total, $class)
        $percent = [int](($index - 1) * 100 / [Math]::Max(1, $total))
        $script:ProgressBar.Value = [Math]::Min(100, [Math]::Max(0, $percent))
        $script:StatusLabel.Text = ("正在执行：{0} · {1}" -f $class, $CLASS_LABELS[$class])
        [System.Windows.Forms.Application]::DoEvents()
    }
    try {
        $ok = Invoke-Uninstall -SelectedMode $script:SelectedMode -SelectedClasses $classes -DoBackup $script:DoBackup -Report $script:Report -ProgressCallback $progressCallback
    } catch {
        $script:LastError = $_.Exception.Message
        Write-UninstallLog "INFO" "FAILED" "(执行)" $script:LastError
        $ok = $false
    } finally {
        $script:Executing = $false
    }

    $script:ProgressBar.Value = 100
    $script:StatusLabel.Text = "执行完成"
    [System.Windows.Forms.Application]::DoEvents()

    $resultLabel = New-Object System.Windows.Forms.Label
    $resultLabel.Font = New-UiFont 11 $true
    $resultLabel.AutoSize = $true
    $resultLabel.Location = New-Object System.Drawing.Point(0, 130)
    if ($ok) {
        $resultLabel.Text = ("卸载完成。释放空间：{0}" -f (Format-Size $script:FreedBytes))
    } else {
        $resultLabel.Text = "卸载未完全成功，请查看日志与提示。"
        $resultLabel.ForeColor = [System.Drawing.Color]::Firebrick
    }
    $script:ContentPanel.Controls.Add($resultLabel)

    $detail = New-Object System.Windows.Forms.TextBox
    $detail.Multiline = $true
    $detail.ReadOnly = $true
    $detail.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $detail.Location = New-Object System.Drawing.Point(0, 170)
    $detail.Size = New-Object System.Drawing.Size(860, 320)
    $detail.Text = ("日志：{0}`r`n{1}" -f $LogPath, ($script:LogLines -join "`r`n"))
    $script:ContentPanel.Controls.Add($detail)

    if ($script:LastError) {
        [System.Windows.Forms.MessageBox]::Show($script:LastError, "卸载提示", "OK", "Warning") | Out-Null
    }

    Set-NavState $false "完成" $true $true
    $script:BtnNext.Add_Click({ $script:MainForm.Close() })
    $script:BtnCancel.Visible = $false
    [void](Write-UninstallResult $script:SelectedMode $classes $script:BackupPath)
}

# ---------------- 结果与入口 ----------------

function Write-UninstallResult {
    param([string]$SelectedMode, [string[]]$Classes, [string]$BackupZip)
    try {
        $result = [ordered]@{
            mode = $SelectedMode
            classes = @($Classes)
            dryRun = [bool]$DryRun
            freedBytes = $script:FreedBytes
            freedText = (Format-Size $script:FreedBytes)
            logPath = $LogPath
            backupPath = $BackupZip
            unsafeTargets = @($script:UnsafeTargets)
            lastError = $script:LastError
            finishedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
            logLines = @($script:LogLines)
        }
        $json = $result | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Initialize-Log {
    try {
        $logDir = Split-Path -Parent $LogPath
        if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        [System.IO.File]::WriteAllText($LogPath, "", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

if (-not $NoGui -and -not $UiSmoke) {
    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
        $argList = @("-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
        $argList += @("-ReportPath", "`"$ReportPath`"", "-Mode", $Mode, "-LogPath", "`"$LogPath`"", "-ResultPath", "`"$ResultPath`"")
        if ($Backup) { $argList += "-Backup" }
        if ($DryRun) { $argList += "-DryRun" }
        Start-Process -FilePath "powershell.exe" -ArgumentList $argList | Out-Null
        exit 0
    }
}

Initialize-Log
try {
    $script:Report = Get-ScanData
} catch {
    $message = "扫描失败：$($_.Exception.Message)"
    if ($NoGui -or $UiSmoke) { Write-Error $message; exit 1 }
    [System.Windows.Forms.MessageBox]::Show($message, "扫描失败", "OK", "Error") | Out-Null
    exit 1
}
$script:AllowedRoots = Get-AllowedRoots $script:Report

if ($NoGui) {
    if ($Mode -eq "Gui") {
        Write-Error "NoGui 模式必须指定 -Mode Full / KeepData / Custom"
        exit 1
    }
    $classes = switch ($Mode) {
        "Full" { @("A", "B", "C", "D", "E", "F") }
        "KeepData" { @("A", "B", "D", "E", "F") }
        "Custom" {
            $valid = @($CustomClasses | Where-Object { $CLASS_LABELS.Contains($_) })
            if ($valid.Count -eq 0) { Write-Error "CustomClasses 为空或无效"; exit 1 }
            $valid
        }
    }
    $doBackup = [bool]$Backup
    $ok = $false
    try {
        $ok = Invoke-Uninstall -SelectedMode $Mode -SelectedClasses $classes -DoBackup $doBackup -Report $script:Report
    } catch {
        $script:LastError = $_.Exception.Message
        Write-UninstallLog "INFO" "FAILED" "(执行)" $script:LastError
    }
    [void](Write-UninstallResult $Mode $classes $script:BackupPath)
    Write-Host ("执行结束：OK={0} 释放={1} 日志={2}" -f $ok, (Format-Size $script:FreedBytes), $LogPath)
    if (-not $ok -and $script:LastError) { exit 2 }
    exit 0
}

if ($UiSmoke) {
    $form = New-MainForm
    Show-Step1
    $smoke = [ordered]@{}
    $smoke.step1Controls = $script:ContentPanel.Controls.Count
    Show-Step2
    $smoke.modeRadioCount = $script:ModeRadios.Count
    $smoke.customCheckCount = $script:CustomChecks.Count
    $smoke.cDisabled = (-not $script:CustomChecks["C"].Enabled)
    $smoke.defaultMode = $script:SelectedMode
    $script:SelectedMode = "Custom"
    $script:ModeRadios["Custom"].Checked = $true
    Update-CustomVisibility
    $smoke.customVisible = $script:CustomPanel.Visible
    $smoke.selectedAfter = $script:SelectedMode
    $smoke.panelExists = ($null -ne $script:CustomPanel)
    $smoke.checkedStates = @($script:ModeRadios.Keys | ForEach-Object { "$_=$($script:ModeRadios[$_].Checked)" })
    $smoke.keepDataClasses = @(Get-EffectiveClasses)
    $script:SelectedMode = "KeepData"
    $smoke.keepDataEffective = @(Get-EffectiveClasses)
    Show-Step3
    $smoke.step3Controls = $script:ContentPanel.Controls.Count
    $smoke.uiOk = ($smoke.modeRadioCount -eq 3) -and ($smoke.customCheckCount -eq 6) -and ($smoke.selectedAfter -eq "Custom")
    $form.Close()
    $smokeJson = $smoke | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($ResultPath, $smokeJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host $smokeJson
    exit $(if ($smoke.uiOk) { 0 } else { 1 })
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-MainForm
Show-Step1
[void][System.Windows.Forms.Application]::Run($form)