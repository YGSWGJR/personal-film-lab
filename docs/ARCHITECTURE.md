# 个人拉片工作台当前架构

本文描述 `0.4.0` 的可维护架构。`S01_开发架构文档.md` 保留为早期设计基线，遇到冲突时以当前源码和本文为准。

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
- `DataLayer`：SQLite 连接、迁移、事务仓储和项目包；含 `WallRepository`（项目分镜本）与 `WallBoardsRepository`（独立分镜本：boards/nodes/edges/tags/annotations + 复合节点）。
- `BoardExportService`：独立分镜本自动保存（board.json + assets 防抖同步到 `boardSaveDir`）与 board.json 导入。
- `CaptureService`：截图、静帧文件和元数据。
- `ExportService`：PDF/Word 分镜本导出。
- `StatsService`：标签、节奏和完成度聚合。
- `SettingsService` / `SessionService`：配置与工作现场恢复。
- `lapian-asset` 自定义协议：按 `projects/` 根白名单暴露资产，响应带 CORS 头（渲染层把资产画进 canvas 导出需要）。

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
- 独立分镜本（迁移 010~012）：`wall_boards`、`wall_nodes`（source=image/text/composite，`parent_id` 自引用表达复合节点层级）、`wall_node_edges`、`wall_node_tags`（六类节点标签，与镜头标签同构不混表）、`wall_node_annotations`
- 项目分镜本（迁移 006~009）：`shot_layout`、`shot_edges`、`shot_groups`、`shot_annotations`

`.lapian` 项目包由 manifest、SQLite 快照和可选资源目录组成。导入时重映射冲突 ID，并对内置标签做幂等合并。

## 分镜墙与独立分镜本（0.3.0~0.4.0）

双轨制：**项目分镜本**基于 `shot_layout` 系（project 维度，依赖已切分镜头）；**独立分镜本**基于 `wall_boards` 系（无素材可创作，图片资产复制到 `projects/boards/<boardId>/`，经 `lapian-asset://boards/…` 协议访问）。

- **时间线语义**：独立分镜本节点经 BFS 分层映射为 WorkspaceShot——同层并行节点共享同一时间段（同时发生），连线跨层才推进；复合节点整体占一个链路位，时长 = 内部子节点按内部连线 BFS 分层的总长（与主链同语义）。
- **复合节点（组即节点）**：`createComposite` 收编 ≥2 个顶层节点（禁止嵌套），外部连线自动重路由到复合节点（内部连线保留）；`dissolveComposite` 释放成员并删除复合节点及其连线。
- **API 分流**：`StoryboardWall` 在 board 模式下所有写操作必须走 `wall:addNodeEdge`/`wall:removeNodeEdge`/`wall:saveNodeAnnotations`/`wall:listNodeTags` 等 node 级通道（boardId = 真实分镜本 id）；项目模式走 `wall:addEdge` 等 shot 级通道。混用会因外键校验静默失败（0.4.0 修复的系统性根因）。
- **投影模式**：`workbenchShots` 数据源切换为分镜本节点映射；编辑路由层把投影下的笔记/标签/景别写回 `wall_nodes`/`wall_node_tags`，结构编辑（拆分/合并/删除）禁用并提示回分镜墙操作。
- **独立保存**：设置项 `boardSaveDir`（默认 `数据根\exports\boards`）；所有分镜本变更 IPC 在主进程 `boardExport.schedule(boardId)` 防抖 800ms 导出 `board-<id8>/board.json + assets/`；`wall:importBoardFile` 按 idMap 重建为新分镜本（含父子层级/连线/标签/标注与资产复制）。

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

S41 起检测拆分为两条独立管线（DetectService）：

- 边界任务（`detect:runBoundary`）：抽帧 → TransNetV2+OpenCV 混合边界（stdio JSON-RPC 调用 Python）→ 按任务隔离生成缩略图 → `applyDetected` 单事务写入 shots/scenes 并自动应用 → `detect:event:boundaryApplied`。Qwen 不参与；模型缺失自动回退 OpenCV。
- 标签任务（`detect:runLabels`）：读取已落库镜头 → 逐镜头抽取中点代表帧 → Qwen3-VL 分析 → 仅生成 LabelPreviewResult（含 shotId+startMs+endMs 几何版本快照）→ `detect:event:labelsDone`。不写库。
- 标签应用（`detect:applyLabels`）：按 `overwrite-all` / `preserve-manual` 策略在单事务内更新字段与受管标签；以应用时的 `manualFields` 为准保护人工字段，几何变化或锁定镜头逐个跳过（LABEL_RESULT_STALE / SHOT_LOCKED）。

抽帧目录按 job ID 隔离，图片读取使用 `np.fromfile + cv2.imdecode` 支持中文路径。旧的一次性 `detect:run`/`detect:apply` 保留为兼容路径（MCP 使用）。

`manualFields` 数据流：shot.update 按补丁键标记 shotSize/cameraMethod/dialogue/remark；tag assign/unassign 标记 tags 并设 origin='manual'；split 右段继承、merge 取并集；AI 写入（applyLabelUpdates）不标记。迁移 005 新增 `shots.manual_fields_json`。

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
