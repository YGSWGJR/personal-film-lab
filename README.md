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

### 播放器冒烟（PowerShell）

```powershell
$env:SMOKE_VIDEO = 'D:\path\clip.mp4'      # 追加播放器全链路断言
$env:SMOKE_BAD_FILE = 'D:\path\bad.mp4'    # 非法格式错误处理断言（可选）
$env:SMOKE_RESULT = 'D:\tmp\smoke.json'    # 结果 JSON
$env:SMOKE_HOLD_MS = '15000'               # 保持窗口，便于外部截屏目检（可选）
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

## 智能体工作目录

| 智能体 | 工作分支 | 工作目录 | 职责 |
|---|---|---|---|
| dsh | `feature/player`、`feature/detect`、`feature/export` | `src/main/{player,media,capture,detect,export,stats}`、`src/services/detect`、`src/export` | 管线与算法向：播放 / 检测 / 导出 |
| codex | `feature/ui` | `src/renderer`、`src/preload`、`src/main/app.ts` | 界面向：三栏工作台、时间轴、标注交互 |
| dsh + codex 共管 | 各自分支内 | `src/shared`、`src/data`、`docs/` | 契约与数据层：变更需在 PR/提交说明中同步 S01 |

> 目录结构完整定义见 S01 §4；各分支按 S01 从零落地，无需等待其他分支。

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