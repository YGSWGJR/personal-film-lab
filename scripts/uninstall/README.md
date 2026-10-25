# S31 卸载工具（V1）

独立卸载工具，一次完成六类清理（应用本体 / 用户设置 / 数据根 / 环境变量 / 注册表 / 运行进程），
支持完整卸载、保留数据卸载（推荐）、自定义勾选三种模式，带安全守卫、备份与失败日志。

> 依据：`G:\ai\Doubao\S31-卸载工具策划案.md`、`G:\ai\Doubao\S31-卸载工具-DSH实施指令.md`
> V1 独立运行，暂不并入 NSIS；V1.1 再集成安装包入口。

## 文件

| 文件 | 说明 |
|---|---|
| `scan-uninstall.ps1` | 扫描六类残留（userData 双位置探测：`G:\拉片\软件数据` 优先），输出 `uninstall-report.json`（UTF-8） |
| `uninstall.ps1` | WinForms 四步向导 + 安全守卫 + 执行/日志/备份；同时支持无人值守参数 |
| `README.md` | 本说明 |

## 环境

- Windows 10/11 + Windows PowerShell 5.1（WinForms 需 STA；脚本会自动以 `-STA` 重新启动）
- 不需要 Node / 外部模块；仅用 `System.Windows.Forms` / `System.Drawing` / `Compress-Archive`

## 使用

### 1. 只扫描（安全，不改系统）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scan-uninstall.ps1
# 报告：.\uninstall-report.json
```

### 2. 打开卸载向导

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\uninstall.ps1
```

向导四步：检测 → 选模式 → 确认（含备份选项与不可逆警示）→ 执行。
默认选中「保留数据卸载」：保留 `settings.json` 与 `settings.json` 解析出的数据根；清理应用本体、
缓存类残留、环境变量、注册表与快捷键。

### 3. 无人值守 / 自测（不弹窗）

```powershell
# 只演练，不实际删除
.\uninstall.ps1 -NoGui -Mode KeepData -DryRun

# 使用指定扫描报告，跳过重新扫描
.\uninstall.ps1 -NoGui -Mode Full -DryRun -SkipScan -ReportPath .\uninstall-report.json

# 自定义类（A=应用本体 B=用户设置 C=数据根 D=环境变量 E=注册表 F=进程）
.\uninstall.ps1 -NoGui -Mode Custom -CustomClasses A,B,D,E,F -DryRun
```

参数：`-ReportPath` / `-LogPath` / `-ResultPath` / `-Backup` / `-DryRun` / `-SkipScan` / `-UiSmoke`。

## 安全设计

- **白名单路径守卫**：删除目标必须位于白名单根（安装目录、`%APPDATA%\personal-film-lab`、
  settings.json 解析出的数据根）之内；驱动器根、`C:\Windows`、`Program Files`、ProgramData、
  用户主目录（除 Roaming\personal-film-lab 子树）一律拒绝，日志记 `SKIP-UNSAFE`。
- **数据根保护**：settings.json 缺失/损坏/必需字段缺失时 `dataParseOk=false`，数据根（C 类）
  整个跳过并在向导中禁用 C 勾选项。
- **精确目标**：只删 settings.json 中解析出的四个数据根及已知缓存清单；不删父目录。
- **进程**：只结束安装目录内同名主程序或路径在该目录下的进程；杀不掉则中止后续删除并提示。
- **环境变量**：仅删除用户级 `DSH_DATA_ROOT`。
- **注册表**：仅删除 DisplayName 含「个人拉片工作台」的 HKCU Uninstall 子键。
- **备份**：勾选时把 `settings.json` + 数据根下 `lapian.db` 打包到 `..\卸载备份\uninstall-backup-*.zip`；
  备份失败不阻断卸载（可在日志查看原因）。
- **日志**：`uninstall-log.txt`（与脚本同目录），每行 `[时间] [类] [结果] 目标 | 详情`，UTF-8。
- **DryRun**：只写日志与结果 JSON，不删除、不改进程/环境变量/注册表。

## S32 适配：userData 重定向到 `G:\拉片\软件数据`

`src/main/index.ts` 已把 Electron userData 重定向到 `G:\拉片\软件数据`，旧位置
`%APPDATA%\personal-film-lab` 仅作迁移残留兼容。卸载工具据此适配：

- **双位置扫描**：`userDataDirs` 按「`G:\拉片\软件数据` → `%APPDATA%\personal-film-lab`」顺序收集存在者；
  `settingsPath` 取第一个存在 `settings.json` 的位置；`roamingDir` 为主 userData 目录（用于展示与 B 类主目标）。
- **B 类清理**：遍历 `userDataDirs`（两个都存在则都处理）；保留模式只删缓存子目录与
  `*.tmp`/`session*.json`，保留 `settings.json`；完整模式删除整个用户数据目录。
- **备份**：`settings.json` 从探测到的实际位置取，`lapian.db` 仍从数据根取。
- **数据根缺失容错**：settings.json 指向的目录不存在时，C 类仅记 `SKIP 不存在`，不影响其他类执行。

验收命令（全部 DryRun）：

```powershell
# 1) 扫描：应得到 settingsPath=G:\拉片\软件数据\settings.json、dataParseOk=true、4 个数据根
.\scan-uninstall.ps1 -OutputPath .\report.json

# 2) 保留数据 DryRun：B 类缓存子目录 DRY-RUN，settings.json 不删除
.\uninstall.ps1 -NoGui -Mode KeepData -DryRun -SkipScan -ReportPath .\report.json

# 3) 完整 DryRun：B 类整个 userData 目录 + C 类数据根 DRY-RUN
.\uninstall.ps1 -NoGui -Mode Full -DryRun -SkipScan -ReportPath .\report.json

# 4) 备份：zip 应含 G:\拉片\软件数据\settings.json 与 lapian.db
.\uninstall.ps1 -NoGui -Mode KeepData -DryRun -Backup -SkipScan -ReportPath .\report.json

# 5) UI 冒烟
.\uninstall.ps1 -UiSmoke -DryRun -SkipScan -ReportPath .\report.json
```
## 自测与验收命令

```powershell
# 1) 扫描字段
.\scan-uninstall.ps1 -OutputPath .\report.json

# 2) 安全守卫：构造恶意清单（C:\Windows、D:\ 等）→ 应全部 SKIP-UNSAFE
.\uninstall.ps1 -NoGui -Mode Full -DryRun -SkipScan -ReportPath .\injected-report.json

# 3) 设置文件损坏：改名 settings.json 后扫描 → dataParseOk=false；
#    向导第 2 步 C 勾选项应禁用，执行时 C 类 SKIP-UNSAFE

# 4) UI 结构自检（不显示窗口）
.\uninstall.ps1 -UiSmoke -SkipScan -ReportPath .\report.json

# 5) 备份（DryRun 也会生成备份 zip，可测试）
.\uninstall.ps1 -NoGui -Mode KeepData -DryRun -Backup
```

## 已知限制

- 运行中的 `lapian.db` 被应用占用时，备份会失败并在日志记录（建议先让向导结束进程，再备份）。
- V1 未接入 NSIS 安装器；卸载入口、安装包体积增量在 V1.1 处理。
- 仅支持当前用户的 per-user 安装（`HKCU`），不支持系统级安装。