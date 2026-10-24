# 个人拉片工作台（Personal Film Lab）

面向个人学习电影语言与影像分析的桌面工具：导入影片 → 智能/手动切分镜头 → 标注镜头语言 → 静帧截图 → 一键导出标准分镜本（PDF / Word）。

**技术栈**：Electron · libmpv · FFmpeg · OpenCV（Python 检测服务）· SQLite · yt-dlp

## 开发（阶段 0–2 · 骨架 + 播放链路）

```bash
npm install        # 安装依赖（Electron 45 + electron-vite + Vue 3 + electron-builder + koffi）
npm run dev        # 开发模式启动窗口（HMR）
npm start          # 构建后启动窗口（electron-vite preview）
npm run smoke      # 冒烟校验：窗口 + preload 白名单桥 + app:info；设置 SMOKE_VIDEO 时追加播放器全链路
npm run typecheck  # 主进程 / 渲染层类型检查
npm run build      # 打包 Windows 安装包（release/）
npm run build:dir  # 只产出未压缩目录，验证打包链路
```

工程骨架按 S01 §4 落地：

| 路径 | 内容 |
|---|---|
| `src/main/index.ts` | 主进程入口：生命周期 + IPC 注册 + 关闭 DirectComposition |
| `src/main/app.ts` | 主窗口创建与安全基线（contextIsolation / sandbox / 禁止新窗口） |
| `src/main/ipc/index.ts` | IPC 注册器（统一 `IpcResult` 信封） |
| `src/main/player/` | 播放链路：`mpv-lib.ts`（FFI）· `mpv-client.ts` · `native-overlay.ts` · `player-service.ts` |
| `src/preload/index.ts` | `contextBridge` 白名单桥 + zod 载荷校验 |
| `src/renderer/` | Vue 3 三栏工作台 + 播放器 UI / 快捷键 |
| `src/shared/` | `types.ts` / `ipc-channels.ts` / `schemas.ts` / `ipc-result.ts` |

### 播放链路（libmpv）

- 运行时依赖 `resources/mpv/libmpv-2.dll`（官方 dev 包，**文件名是 `libmpv-2.dll`，不是 `mpv-2.dll`**；静态链接单文件，无需额外运行时库）。该 DLL 体积约 120MB，按二进制资源处理、不入库，放置到 `resources/mpv/` 即可；打包时由 electron-builder `extraResources` 复制到安装包 `resources/mpv/`。
- 主进程用 `koffi` 直接调用 libmpv client API；画面经 `wid` 交给 mpv 的 vo/gpu（D3D11）渲染到 Win32 子窗口，渲染层通过 `player:setBounds` 上报播放器区域。因 Chromium DirectComposition 会遮挡原生子窗口，主进程启动时关闭该特性。
- 帧级能力：`player:frameStep` 前后各 1 帧（等待 `playback-restart` + `time-pos` 稳定 + 帧号实际变化），`player:seek` 使用 `absolute+exact` 精确落帧；25fps 与 23.81fps 素材实测单帧步进稳定。
- 快捷键（渲染层捕获后经 IPC 执行）：`Space` 播放/暂停、`←/→` 逐帧、`Shift+←/→` ±1 秒。

### 媒体处理（FFmpeg）

- 运行时依赖 `resources/ffmpeg/ffmpeg.exe` 与 `resources/ffmpeg/ffprobe.exe`（**FFmpeg 9.0.2-full_build**，www.gyan.dev 官方 Windows 构建；静态链接单文件，**无外部 DLL 依赖**）。体积各约 220MB，按二进制资源处理、不入库，放置到 `resources/ffmpeg/` 即可；打包时由 electron-builder `extraResources` 复制到安装包 `resources/ffmpeg/`。
- 用途：`ffprobe` 元信息探测（时长 / 分辨率 / 帧率 / 编码）；`ffmpeg` 抽帧（静帧截图、镜头检测采样）与转码代理（高码率转低码率代理，保证低配机流畅）。
- **安装记录（2026-10-24）**：GitHub / gyan.dev 直连下载不稳定，改经 winget 安装 `Gyan.FFmpeg` 9.0.2（`winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --disable-interactivity`），从安装目录 `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-9.0.2-full_build\bin\` 拷贝 `ffmpeg.exe` / `ffprobe.exe` 至 `resources/ffmpeg/`。系统 PATH 已注册全局 `ffmpeg` / `ffprobe` / `ffplay` 别名，与仓库内二进制不冲突。
- 集成约定：主进程媒体服务直接 spawn `resources/ffmpeg/ffmpeg.exe`（开发期取仓库路径，打包后取 `process.resourcesPath`）；失败时输出 stderr 便于排查。

### 媒体处理服务（MediaService）

实现位于 `src/main/media/`，IPC 通道见 S01 §6.2 `media` 域，统一 Promise 接口：

| 能力 | 通道 | 说明 |
|---|---|---|
| 元信息探测 | `media:probe` | 时长 / 分辨率 / 帧率 / 容器 / 视频与音频编码 / 码率 / 大小 / 是否含音视频轨 |
| 精确抽帧 | `media:extractFrame` | 按毫秒时间点抽单帧 JPG/PNG；默认落 `userData/lapian/frames/` |
| 批量抽帧 | `media:extractFrames` | 按固定间隔抽帧（最小 50ms、最多 20000 帧保护），供镜头检测采样；调用方指定 `outputDir` |
| 转码代理 | `media:transcodeProxy` | H.264 + yuv420p + 最高 720p（不放大）+ AAC 128k + faststart；只写新文件，绝不修改源文件；默认落 `userData/lapian/proxies/` |

统一特性：

- **超时**：探测默认 30s、单帧 60s、批量抽帧 30min、转码 60min，均可用 `timeoutMs` 覆盖；超时返回 `*_TIMEOUT` 错误并结束进程树。
- **失败诊断**：错误信封 `error.details` 带 `command` / `exitCode` / `stderr` 尾部 / `elapsedMs` / `timeoutMs` / `path`，便于定位编码或路径问题。
- **进度与取消**：批量抽帧/转码通过 `media:event:progress` 推送 `{ jobId, stage, percent, message }`（约 1% 或 250ms 节流）；`media:cancelJob` 可中止任务，返回 `CANCELLED`。
- **错误码**：`FFMPEG_NOT_FOUND` / `INPUT_NOT_FOUND` / `INPUT_EMPTY` / `PROBE_FAILED` / `PROBE_TIMEOUT` / `NO_VIDEO_STREAM` / `EXTRACT_FRAME_FAILED` / `EXTRACT_FRAMES_FAILED` / `TRANSCODE_FAILED` / `CANCELLED` 等。

### OpenCV 镜头检测（DetectService）

- `src/main/detect/python/server.py` 通过 stdio JSON-RPC 接收帧列表；`features.py` 提取饱和度 / 对比度 / 亮度 / 16-bin 色调直方图，`difference.py` 计算加权差异曲线，`peaks.py` 做自适应阈值与闪白/淡变过滤，`clustering.py` 按色调直方图距离聚类场景。
- `detect:run` 异步返回 `jobId`，进度经 `detect:event:progress` 推送；完成时 `detect:event:done` 返回带临时 id 的 `shots` 与 `scenes` 预览，不直接写库。
- `detect:apply` 使用预览 id 确认写库：未锁定镜头被本次结果替换，`locked=1` 镜头保留且重叠候选跳过；场景按确认结果整体替换。
- Python 依赖：OpenCV ≥ 5.0、NumPy ≥ 2.5。开发期使用 `DSH_PYTHON`、`PYTHON` 或系统 `python`；打包时将 `src/main/detect/python/*.py` 复制到 `resources/detect/python/`。

### 示波器与音频波形（ScopeService，S20）

- `scope:analyzeFrame` 使用 `media:extractFrame` 生成最大 640px 宽的临时帧，经独立常驻 Python JSON-RPC 服务计算 Luma/R/G/B 64-bin 直方图、128 列亮度波形、色度矢量密度、RGB Parade 与 CIE 1931 散点。
- 渲染层提供直方图 / 波形图 / 矢量图 / 分量图 / CIE 1931 五个 Tab；播放中按 300ms 调度并带 ±500ms 帧缓存，暂停与 seek 立即刷新，失败保留上一次成功画面。
- `scope:extractAudioWaveform` 以 8kHz 单声道 f32le 流式读取音频，默认按 100ms 桶计算 peak/RMS；时间轴第四轨共享缩放、平移与播放头，Ctrl+滚轮缩放，Shift+滚轮平移。
- Python 脚本位于 `src/main/scope/python/`，打包时复制到 `resources/scope/python/`；S07 检测算法目录保持不变。

### 数据层（SQLite / better-sqlite3）

- 单库 `userData/lapian/lapian.db`（WAL + 外键），迁移脚本在 `src/data/migrations/`，启动时按 `PRAGMA user_version` 自动升级；测试可用环境变量 `DSH_DATA_ROOT` 指向临时目录。
- 表：`projects` / `scenes` / `shots` / `stills` / `tags` / `shot_tags` / `notes` / `terms`；shots 含景别 `shot_size`、摄法 `camera_method`、台词 `dialogue`、备注 `remark`、来源 `origin` 与锁定 `locked`。
- 仓储在 `src/data/repositories/`，**所有写操作都在 `db.transaction` 内**；子实体写入同时刷新项目 `updated_at`。
- IPC / preload 提供完整 CRUD：`project:*`、`shot:*`、`still:*`、`tag:*`（含 assign/unassign）、`note:list/get/upsert/delete`、`term:*`（含 JSON 导入导出），统一 `IpcResult` 信封与 zod 入参校验。
- 项目文件：`project:save` / `project:saveAs` 导出单个 `.lapian`（zip）= `manifest.json` + 项目 SQLite 快照 `project.db` + `assets/` 资源目录；`project:open` 导入并重映射 id（冲突时自动换新 id、名称加「（导入）」）。默认导出目录 `userData/lapian/packages/`。
- 原生模块：better-sqlite3 v13 内置 N-API 预编译，Electron 45 直接可用；打包配置 `asarUnpack: node_modules/better-sqlite3/**`、`npmRebuild: false`，已用打包产物冒烟验证。

### 分镜本导出（PDF / Word）

- `export:storyboard` 从项目数据装配固定八列：镜号 / 时长 / 缩略图 / 景别 / 摄法 / 画面内容 / 台词 / 备注。
- 缩略图缺失时自动调用 `still:captureAt` 生成镜头中点 `role=auto-thumb` JPEG；画面内容使用靠近中点的 `role=main` PNG。
- PDF 使用 Electron `webContents.printToPDF`（A4 竖版、封面、重复表头），Word 使用 `docx` 生成可编辑表格，显式指定 Microsoft YaHei。
- 导出文件写入 `projects/<projectId>/exports/`，渲染层提供镜头范围、表头、图片策略与格式配置界面。

### 冒烟（播放器 + 媒体 + 数据层，PowerShell）

```powershell
$env:SMOKE_VIDEO = 'D:\path\clip.mp4'            # 播放器链路断言
$env:SMOKE_BAD_FILE = 'D:\path\bad.mp4'          # 播放器/媒体错误处理断言（可选）
$env:SMOKE_MEDIA_VIDEO = 'D:\path\clip.mp4'      # 媒体探测/抽帧断言
$env:SMOKE_TRANSCODE_VIDEO = 'D:\path\clip2.mp4' # 代理转码断言，默认同 SMOKE_MEDIA_VIDEO
$env:SMOKE_CANCEL_VIDEO = 'D:\path\long.mp4'     # 取消任务断言（可选）
$env:SMOKE_MEDIA_OUT = 'D:\tmp\media-smoke'      # 抽帧/代理输出目录
$env:SMOKE_RESULT = 'D:\tmp\smoke.json'          # 结果 JSON
$env:SMOKE_HOLD_MS = '15000'                     # 保持窗口，便于外部截屏目检（可选）
$env:DSH_DATA_ROOT = 'D:\tmp\data-smoke'          # 数据层测试根目录（隔离主库）
$env:SMOKE_DATA_PKG = 'D:\tmp\data-smoke\pkg\project.lapian'  # 项目包保存/打开往返
$env:SMOKE_SCOPE_VIDEO = 'D:\path\clip.mp4'       # 示波器分析/缓存/音频波形断言
npm run smoke
```

已知限制：视频区域是原生子窗口，DOM 无法覆盖在其上方；点击视频区不会触发 DOM 事件（键盘快捷键不受影响）。后续如需播放器控件浮层，需评估 Electron 的 `WebContentsView` 或改用 GPU 帧共享方案。
## 文档索引

| 编号 | 文档 | 说明 |
|---|---|---|
| S01 | [docs/S01_开发架构文档.md](docs/S01_开发架构文档.md) | 开发架构（唯一权威）：模块边界 / IPC 通道 / 数据模型 / 开发顺序 |
| — | [docs/产品方案V2.pdf](docs/产品方案V2.pdf) | 产品方案 V2（产品依据） |

## 分支策略

- `main`：主干，始终可运行、可演示；**禁止直接提交**，只接受功能分支合并。
- 功能分支（均从 `main` 拉出，按模块划分）：

| 分支 | 模块 | 说明 |
|---|---|---|
| `feature/player` | 播放链路 | libmpv 播放、FFmpeg 媒体处理、静帧截图 |
| `feature/detect` | 镜头/场景检测 | OpenCV 检测服务（色彩特征 / 差异曲线 / 峰值 / 聚类） |
| `feature/ui` | 渲染层 | Vue3 三栏工作台、三层时间轴、详情卡 |
| `feature/export` | 导出与统计 | 分镜本 PDF/Word、学习统计 |
| `feature/integration` | 模块集成与联调 | S03–S13 IPC 接线、真实数据主流程、边界修复（S14） |
| `feature/scope` | 示波器与音频 | 五类示波器、当前帧分析缓存、第四层音频包络（S20） |

## 智能体工作目录

| 智能体 | 工作分支 | 工作目录 | 职责 | 状态 |
|---|---|---|---|---|
| dsh | `feature/player`、`feature/export` | `src/main/{player,media,capture,export,stats}`、`src/export` | 管线与导出：播放 / 截图 / 导出 | 已完成（S03–S06、S11） |
| codex | `feature/ui`、`feature/detect`、`feature/integration`、`feature/scope` | `src/renderer`、`src/preload`、`src/main/{detect,scope}`、`src/main/app.ts` | 界面、镜头检测、集成联调与示波器 | **已完成（S20）** |
| dsh + codex 共管 | 各自分支内 | `src/shared`、`src/data`、`docs/` | 契约与数据层：变更需在 PR/提交说明中同步 S01 | 契约已同步 |

> 目录结构完整定义见 S01 §4；各分支按 S01 从零落地，无需等待其他分支。

> S07 状态（2026-10-24）：`feature/detect` 已完成 DetectService、Python 算法、`detect:*` IPC、migration 003 与合成帧单测；真实样例 dry-run/apply 已通过。UI 接入仍按计划留给 S14。

> S14 状态（2026-10-24）：**已完成**。`feature/integration` 已接通本地导入 / 代理转码 / 检测预览与确认写库 / 三栏真实数据 / 截图标注 / PDF 与 Word 导出；UI 类型检查、Electron 冒烟与真实项目联调通过。

> S20 状态（2026-10-24）：**已完成**。`feature/scope` 已交付五类 canvas 示波器、常驻 Python 帧分析、±500ms 缓存、第四层音频包络与缩放联动；黑/白/红帧数值、CIE、IPC 冒烟与真实播放节流联调通过。

## 提交规范

- **格式**：`<模块>: <动词> <简述>`，例如：`player: add frameStep api`
- **模块名**：`player` / `media` / `import` / `detect` / `shot` / `still` / `note` / `tag` / `term` / `export` / `stats` / `data` / `ui` / `preload` / `shared` / `docs` / `chore` / `build` / `test`
- **动词**：`add`（新增）/ `fix`（修复）/ `refactor`（重构）/ `update`（更新）/ `remove`（删除）/ `docs`（文档）
- **规则**：
  - 一行主题 ≤ 72 字符；需要说明动机时在正文分段书写
  - 原子提交：一次提交只做一件事，同域改动小步提交
  - 涉及 `shared/` 或 `docs/` 的提交，正文须注明对 S01 的影响
  - 示例：`detect: add difference curve weights`、`ui: fix timeline seg overlap`、`docs: update IPC channel list`

## 协作流程

1. **契约先行**：修改 IPC 通道或数据模型，先改 `src/shared/` 并同步 S01，再进入实现。
2. **拉分支**：从 `main` 拉取功能分支：`git checkout -b feature/xxx main`。
3. **开发**：在各自工作目录内按 S01 落地，遵循提交规范小步提交。
4. **合并**：功能完成且验收通过后合并回 `main`（使用 `--no-ff` 保留分支历史）；`main` 始终保持可运行。
5. **里程碑**：
   - V1（S01 阶段 4）：本地导入 → 播放 → 手动切分 → 截图 → 标注 → PDF 导出
   - V2（S01 阶段 6）：色彩检测自动切分 / 链接导入 / Word 导出 / 学习统计
6. **冲突处理**：`shared/`、`data/` 冲突由双方知会后解决；代码与文档冲突以 S01 为准并回写文档。

## 合规提示

在线解析仅支持自有或已获授权内容，使用前请遵守各平台服务条款。
