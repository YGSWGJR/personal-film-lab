# 个人拉片工作台当前架构

本文描述 `0.1.9` 的可维护架构。`S01_开发架构文档.md` 保留为早期设计基线，遇到冲突时以当前源码和本文为准。

## 进程结构

应用使用 Electron 三进程边界：

| 层 | 目录 | 职责 |
|---|---|---|
| Main | `src/main` | 窗口、文件、libmpv、FFmpeg、SQLite、AI、MCP、导出和系统集成 |
| Preload | `src/preload` | `contextBridge` 白名单 API 与载荷校验 |
| Renderer | `src/renderer` | Vue 3 界面、时间线、标注表单和用户交互 |
| Shared | `src/shared` | 类型、IPC 通道名、zod schema、时间码与播放常量 |

Renderer 不直接访问 Node、文件系统或 SQLite。新增能力先从 `src/shared` 定义契约，再依次接主进程、preload 和界面。

## 主进程服务

- `PlayerService`：libmpv 生命周期、精确 seek、逐帧、音量、倍速和原生层级。
- `MediaService`：探测、抽帧、缩略图、音频波形、代理转码、队列和 GPU 加速。
- `DetectService`：统一调度 OpenCV 与本地 Qwen3-VL，管理任务、预览和写库。
- `LocalVisionService`：启动内置 Python 推理进程，分析镜头代表帧。
- `AiAccessService`：AI 任务快照、提示词、Provider 兼容层和本地 MCP 桥。
- `DataLayer`：SQLite 连接、迁移、事务仓储和项目包。
- `CaptureService`：截图、静帧文件和元数据。
- `ExportService`：PDF/Word 分镜本导出。
- `StatsService`：标签、节奏和完成度聚合。
- `SettingsService` / `SessionService`：配置与工作现场恢复。

## 数据

默认数据根解析顺序为：

1. `DSH_DATA_ROOT`
2. `settings.json` 中的 `dataRoot`
3. 用户数据目录下的 `lapian`

Electron userData 优先使用 `G:\拉片\软件数据`，目录不可创建时回退默认 userData。

核心 SQLite 表：

- `projects`
- `scenes`
- `shots`
- `stills`
- `tags`
- `shot_tags`
- `notes`
- `terms`

`.lapian` 项目包由 manifest、SQLite 快照和可选资源目录组成。导入时重映射冲突 ID，并对内置标签做幂等合并。

## 视频处理

libmpv 通过 koffi 调用，视频使用 Win32 原生子窗口。打开覆盖层时必须隐藏或置底原生窗口，关闭后恢复原层级。

FFmpeg 负责：

- 元信息探测
- 精确抽帧
- 镜头检测采样
- 代理转码
- 音频波形
- 导出自动缩略图

NVIDIA 环境优先使用 CUDA 解帧、`scale_cuda` 和 NVENC；失败时依次回退硬件解码、D3D11VA 和软件编码。

## 镜头识别

本地模式先将视频切成画面候选，再用 Qwen3-VL 读取代表帧。模型输出必须经过 schema 校验，不能直接写数据库。

OpenCV 模式通过 stdio JSON-RPC 调用 Python。抽帧目录按 job ID 隔离，图片读取使用 `np.fromfile + cv2.imdecode` 支持中文路径。

两类结果都先进入 preview。用户确认后才写库，且不覆盖锁定或人工镜头。

## 导出

PDF 通过 Electron `webContents.printToPDF` 生成；Word 使用 `docx` 包生成可编辑表格。两套导出共享镜头数据装配，但保留独立的排版逻辑。

## 构建与资源

| 资源 | 准备方式 | 是否入库 |
|---|---|---|
| npm 依赖 | `npm ci` | 否 |
| mpv/FFmpeg | `npm run prepare:runtime` | 否 |
| Python/OpenCV | `npm run prepare:python` | 否 |
| 本地 AI | `PFL_LOCAL_AI_ARCHIVE` 或 `PFL_LOCAL_AI_SOURCE` | 否 |
| 应用源码与契约 | Git | 是 |

完整安装版使用 `Setup + local-ai.7z` 两文件结构，避免 NSIS 单文件承载超大载荷时截断。`npm run build` 只构建应用主体，`npm run package:local-ai` 生成独立的本地 AI 资源包。

`better-sqlite3 13.x` 与 Electron 45 的 V8 API 对齐。不要为了省去本机编译而降到 12.x；本项目会通过 `postinstall` 使用 `electron-builder install-app-deps` 编译 Electron ABI 版本。

## 安全边界

- preload 只暴露白名单方法。
- 外部路径写入前做根目录和危险目录校验。
- MCP 只监听本机回环地址并使用临时 Token。
- 写笔记、标签、检测应用和取消任务需要用户授权。
- 用户删除永久生效，因此默认要求二次确认。
