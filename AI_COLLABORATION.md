# 人工智能工具协作规范（AI Collaboration Guide）

本文件是**当前三方协作体系的唯一规范**：说明各 AI 工具的角色、任务编号体系、文件所有权、
产物卫生硬规则与协作流程。历史阶段（S01–S25）的说明保留在文末「历史阶段」小节。

- **唯一事实源**：飞书多维表格分工表 <https://my.feishu.cn/base/GNcDbzfDJaApmZsvdpWc0Y5snGg>
  （任务编号 / 执行方 / 状态 / 实测结论以该表最新记录为准）。
- **指令位置**：`G:\ai\Doubao\<任务编号>实施指令.md`（如 `H1-A实施指令.md`）。
- **本文更新时间**：2026-10-25；基于 `main` 提交 `483df42`（H1-A/B 完成后，本文与 H1-C 同批提交）。

## 1. 参与工具与角色

| 工具 | 当前角色 | 负责内容 |
|---|---|---|
| Doubao（豆包，桌面版） | 架构协调 / 验收 | 产品方案、架构文档（S01）、任务拆分与实施指令编写、Base 分工表维护、逐步验收与结论回填、历史交付（S18 打包说明） |
| DSH（AI 开发智能体） | 底层管线 + H 批次 | libmpv 播放链路、FFmpeg 媒体服务、静帧/导出、数据层（SQLite）、检测算法与 Python 检测服务、窗口遮挡（W1）、本轮数据卫生 H1-A/B/C |
| CODEX（接入 DeepSeek V4.1 Flash） | 功能与界面 | 渲染层三栏工作台与时间轴、设置与静帧（S1）、转码极速化（T1）、打包内嵌 Python（P1-D/E）、检测环境自检（P1-B/E 部分）、学习统计、UI 集成联调 |
| 千问 2.1（本地 ComfyUI） | 视觉素材（历史贡献） | 应用/功能图标、空状态插画、启动页、加载动画等 21 张设计资产（`assets/design/`，S12 阶段） |

> H 批次本次改派：H1-A/H1-C 原记录执行方为「豆包」、H1-B 原为「CODEX」，现统一由 DSH 执行；
> 以 Base 最新记录为准，交付时同步回填执行方、状态与实测结论。

## 2. 任务编号体系

| 批次代号 | 批次主题 | 任务编号（已知） | 主要执行方 |
|---|---|---|---|
| **T** | P0-1 转码极速化 | T1-A~T1-E | CODEX |
| **D** | P0-2 镜头检测 | D1-A~D1-E、D1-CE 修复、D1-回归 | DSH |
| **P** | P0-3 安装自包含 | P1-A~P1-C（DSH）、P1-D~P1-E（CODEX） | DSH / CODEX |
| **S** | P1-4 设置与静帧 | S1-A~S1-D、STILL-TIME | CODEX |
| **W** | P1-5 窗口遮挡 | W1-A、W1-B | DSH |
| **H** | P2-6 数据卫生 | H1-A（清理副本）、H1-B（重打包）、H1-C（本规范） | DSH |
| **S26–S29** | P2-6 验收文档 | S26~S29 验收报告（产出中；已存在 `docs/S28-转码性能对比.md`） | Doubao / DSH |
| — | 追加任务 | 新增-删除镜头静帧指令等 | 以指令文件与 Base 为准 |

> 历史阶段编号为 S01–S25（见文末），与上述批次并存，不删除、仅归档。

## 3. 文件所有权（防冲突）

**总规则**：文件级所有权以各任务指令的「文件所有权（防冲突）」表为准；下表为目录级汇总。
同一文件可能被不同批次修改，必须**按提交顺序、基于最新规范文件**修改（见 §5 流程），
并在提交说明中注明所属任务编号。需要跨界修改时，先在 Base/指令中改派或明确知会对方。

| 目录 / 文件 | 主责 | 协作/说明 | 禁止交叉 |
|---|---|---|---|
| `src/main/player/` | **DSH** | S03/S04 libmpv、W1 弹层联动 | CODEX/豆包不得直接改播放内核；播放器 UI 在 `renderer` |
| `src/main/media/` | **CODEX** | T1-A~E（编码器/队列/硬解）；DSH 初始实现（S05）只读复用 | DSH 无 T1 指令时不改 `media-service.ts`/`encoders.ts` |
| `src/main/capture/` | **DSH** | S11 静帧截图；T1-E 仅允许按指令扩展缩略图参数 | CODEX 不越权改截图主流程 |
| `src/main/export/` | **DSH** | S11 分镜本 PDF/Word | 其他方只读调用 |
| `src/main/detect/`（TypeScript） | **DSH** | D1-A~E 算法调度；P1-B/P1-E（CODEX）按提交顺序共享 `detect-service.ts` | 同一时段只允许一方修改该文件 |
| `src/main/detect/python/` | **DSH** | D1-A/B/C 算法；D1-D/E 不改 Python | CODEX 不得改检测算法脚本 |
| `src/main/settings/` 与设置服务 | **CODEX** | S1-A~D、P1-A 设置迁移 | 豆包只负责设置项文案/参数定义（如需要） |
| `src/main/data/import-service.ts` | **CODEX** | P1-A 导入向导 | DSH 不改该新增文件 |
| `src/data/` | **DSH** | S06 数据层（db/仓储/项目包） | 其他方新增能力放独立文件，不改 `db.ts` 既有逻辑 |
| `src/shared/` | **DSH + CODEX 共管** | 契约先行：IPC 通道/类型/schema 变更须同步 S01 并知会对方 | 禁止单方改通道名后不通知 |
| `src/preload/` | **DSH + CODEX 共管** | 各批次按需追加白名单 API；同一时段按任务占用 | 禁止无白名单地透传任意通道 |
| `src/renderer/src/` | **CODEX** | 三栏 UI/时间轴/设置界面；Vue 组件与样式 | DSH 仅按 W1 指令改 `App.vue` 弹层联动函数；豆包负责 UI 规范 |
| `scripts/` | **DSH + CODEX 共用** | DSH：`clean-duplicates.ps1` 等；CODEX：`prepare-python-runtime.ps1` | 新增脚本须在对应任务指令登记 |
| `docs/` | **Doubao（指令/验收）** | CODEX/DSH 可新增各自任务报告（如 S18/S28/S30），不改他人报告 | 不改 S01 架构契约而不回写 |
| `release/`、`out/`、`release-p1d*` | **构建产物（只读）** | 打包由任务执行方负责（H1-B 为 DSH） | 禁止手工修改产物文件；旧验证目录只读保留 |
| `resources/` | **本地二进制（不入库）** | mpv/ffmpeg 由使用方放置；`resources/python/` 由 P1-D 脚本生成 | 不把二进制提交进 git；不手工改运行时 |

## 4. 禁止 `(n)` 副本硬规则

1. **禁止产生**：任何新建、保存、另存操作**不得生成 `文件名 (N).ext` 或 `(N).ext` 形态**的文件（N≥2）。
   发现即视为产物污染，必须清理后才能提交/打包。
2. **清理工具**：`scripts/clean-duplicates.ps1`
   ```powershell
   ./scripts/clean-duplicates.ps1            # dry-run：只列清单，不删文件
   ./scripts/clean-duplicates.ps1 -Check     # 门禁：退出码 0 表示无副本
   ./scripts/clean-duplicates.ps1 -Commit    # 移入 .duplicates-quarantine/（可回滚）并生成报告
   ./scripts/clean-duplicates.ps1 -Purge -Confirm  # 二次确认后释放隔离区
   ```
   报告：`scripts/clean-duplicates-report.txt`；隔离目录：`.duplicates-quarantine/`（已加入 `.gitignore`）。
3. **每步验收附加卫生检查**（缺一不可）：
   - 提交前 `git status --porcelain` 确认没有 `?? .* (N).` / `?? (N).` 未跟踪副本；
   - `./scripts/clean-duplicates.ps1 -Check` 退出码 0；
   - 打包前额外检查 `release/win-unpacked/` 全目录无 `(n)` 文件（尤其 `resources/detect/python/`）。
4. **副本导致 typecheck 失败的处理口径**：以**规范文件零报错**为准，副本文件不参与编译、
   不因副本报错而"修副本"；先清理副本再重跑 `npm run typecheck`。
5. **`.git/`、`node_modules/`、`out/`、`dist/`、`release*/` 不纳入清理扫描**（脚本内白名单）。

## 5. 协作流程

1. **Base 驱动**：Doubao 在飞书多维表格创建/更新任务（编号、执行方、状态、验收标准），
   编写实施指令到 `G:\ai\Doubao\<编号>实施指令.md`。
2. **执行方接单**：按指令的「前置阅读」「文件所有权」「验收」执行；只改授权文件，
   不生成副本；需要改契约（`src/shared/`、S01）时先改契约并知会协作方。
3. **回填 Base**：完成后把状态改为「已完成」、执行方改为实际执行方，并在「实测结论」字段
   （`fldceskTOf`）写入可核对的实测值（命令结果、体积、耗时、报告路径等）；阻塞则写「阻塞」+ 原因。
4. **卫生门禁**：提交前 `git status` 无副本未跟踪项、`clean-duplicates.ps1 -Check` 退出码 0；
   `npm run typecheck` 规范文件零报错。
5. **打包前 git 干净**：打包必须从干净工作区开始——所有授权修改已提交，未提交文件已确认归属；
   副本已清理（H1-B 步骤 0 口径）。
6. **验收与合并**：Doubao 按验收标准核验后，功能分支合并回 `main`（`--no-ff`），
   `main` 始终保持可运行；发布前至少跑 `npm run typecheck` 与应用启动冒烟。

## 6. 当前状态快照（2026-10-25）

- **git**：`main` 最新提交 `483df42`（H1-A 清理脚本/报告 + S30 打包卫生报告）；工作区仍有历史遗留未跟踪目录
  （`release-p1d*`、`bench-tmp/`、`assets/design/*_src`、旧 Base 导出 ndjson 等），不属于副本，未擅自处理。
- **已完成并合入**：S 批次（S01–S25 历史交付）、T 批次、D 批次、P 批次、W 批次（git 历史可查）；
  H1-A（190 个副本清理，`-Check=0`，白名单零触碰，`-Purge` 释放 6.23 MB）与 H1-B（win-unpacked 无副本、NSIS 重建 326.64MB、打包产物 64 项冒烟通过）已完成。
- **已完成**：H1-A / H1-B / H1-C（本文件）；无在途任务。
- **遗留事项**：
  - 历史验证目录 `release-p1d-installer` / `release-p1d-npm` / `release-p1d3` / `release-p1d4` /
    `release-p1d5` / `release-p1e` 含旧副本，建议征得用户同意后手动清理（H1-B 报告登记，不擅自删除）；
  - `.git/refs/heads` 下存在历史遗留的 `main (2)~(6)`、`feature/* (2)/(3)` 等异常 ref 文件，
    会导致 `git gc/repack` 报警；本批次按"不擅自动 `.git`"原则未处理，待用户确认后清理；
  - `release/win-unpacked.tmp` / `.tmp.lock` 为历史构建残留，H1-B 重建后已由新产物覆盖。
- **文档索引**：S01 架构文档、S18 交付报告、S28 转码性能对比、S30 打包卫生报告（H1-B 产出）。

## 7. 历史阶段（S01–S25）

> 以下为旧版内容，保留历史记录；其中「参与工具」「协作流程」为当时口径，已被 §1/§5 取代。

### 7.1 参与开发的 AI 工具（历史）

| 工具 | 承担角色 | 负责内容 |
|---|---|---|
| Doubao（豆包，桌面版） | 架构与协调 | 产品方案、系统架构、S01 开发架构文档、任务分解与详细指令编写、视觉素材策划（配合 ComfyUI）、逐步验收、S18 打包交付（NSIS 安装包 + 使用说明 + 交付报告） |
| dsh（AI 开发智能体） | 底层管线 | 播放链路（libmpv FFI）、媒体处理（FFmpeg 探测 / 抽帧 / 代理转码）、静帧截图、PDF / Word 分镜本导出（S03–S06、S11） |
| Codex（接入 DeepSeek V4.1 Flash 模型） | 功能与界面 | 渲染层三栏工作台与三层时间轴、镜头色彩差异检测（OpenCV）、集成联调、音频波形轨、可配置路径设置、工作区会话、视频窗口层级、学习统计面板（S07–S10、S12 UI 实现、S14、S17、S21–S25） |
| 千问 2.1（本地部署 ComfyUI） | 视觉素材 | 生成应用图标、功能图标、空状态插画、启动页、加载动画、风格参考等 21 张设计资产（S12，存于 `assets/design/`） |

### 7.2 旧协作流程（S01–S25 时代）

1. 分工表驱动（S01–S25 步骤编号写入多维表格）。
2. 契约先行（IPC/数据模型改动先改 `src/shared/` 与 S01）。
3. 分支协作（各智能体独立 feature 分支，小步原子提交，验收后合并 `main`）。
4. 质量门禁（`npm run typecheck` 与 `npm run smoke` 全绿方可合并）。
5. 逐步骤验收（Doubao 回写分工表状态，未通过不发下一步指令）。

### 7.3 关键产物索引（历史保留）

| 产物 | 路径 |
|---|---|
| 开发架构文档（唯一权威） | `docs/S01_开发架构文档.md` |
| 产品方案 V2 | `docs/产品方案V2.pdf` |
| UI 设计规范与线框 | `docs/ui/UI设计规范.md`、`docs/ui/ui-wireframe.html` |
| 用户使用说明 | `docs/个人拉片工作台使用说明.docx` |
| 打包交付报告 | `docs/S18-交付报告.md` |

### 7.4 环境依赖提示（历史保留）

- 运行时二进制（libmpv-2.dll、ffmpeg/ffprobe.exe）体积较大，不入库，按 `README.md` 安装记录放置到
  `resources/mpv/` 与 `resources/ffmpeg/`。
- 镜头检测服务需要 Python + OpenCV ≥ 5.0 + NumPy ≥ 2.5，代码位于 `src/main/detect/python/`；
  发布版内嵌运行时由 `scripts/prepare-python-runtime.ps1` 生成到 `resources/python/`（不入库）。
