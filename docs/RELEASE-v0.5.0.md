# v0.5.0 发布说明（S42：播放 / 检测 / 硬件 / 项目媒体）

发布日期：2026-11-15
分支：`integrate/s42-v050`（已合入 `main`，tag `v0.5.0`）
共同基线：`e8888bd`；双端功能：Codex `feat/s42-project-media`（bc6524c）× ZCode `feat/s42-playback-detect`（31093c1）

## 本版要点

### 播放与原生视频（ZCode）
- Space 连按不再丢键（含无物理键码的键盘通道）；片尾 EOF 正确重播并刷新按钮状态。
- 原生视频窗口与弹层/分镜墙层级：主进程串行化 + 原子 bounds，快速开合不再卡墙或永久隐藏；弹层期间的层级变更只记账不落盘。
- 模态弹窗显式过渡时长：后台节流下 transitionend 丢失不再造成遮罩残留挡点击。

### 检测与数据保全（ZCode）
- **重切数据保全**：重新切分不再丢失笔记、静帧、镜头连线、镜头标注、分镜墙布局与分组成员（原 QA-01 系列 P0）。
- 检测内存与子进程治理：任务级内存记录（RSS/帧数/子进程/批次）、子进程兜底回收、预览与任务缓存上限驱逐。
- 检测缩略图修复：资产协议盘符路径 + thumbs 白名单（此前全部 404/403）。

### 标签策略与隐私（ZCode）
- 标签识别可选本机 Qwen / 云端视觉模型；云端需隐私确认 + 真实联网校验（Windows Network List Manager，断网零请求）+ 已配置供应商；**不存在"云端切分"选项**。
- 本地 Qwen 回退端到端实测通过（云端失败自动回退，实测推理输出）。

### 硬件能力扫描（ZCode）
- 设置页新增「硬件与运行环境」：切分/标签四条能力线 × 五类结构化状态（原因 + 修复指引）+ 手动重扫；检测弹窗新增预检条。

### 项目媒体（Codex）
- 项目媒体成为独立实体（数据库迁移 013），镜头/场景/静帧按媒体隔离；项目中心、媒体标签切换、会话恢复。
- 分镜墙标注与时间线控件可靠性修复；NLE 轨道选择/锁定/恢复完善。

### 交互习惯（双端）
- 焦点在按钮/链接上时空格、回车激活控件，全局快捷键让位；确认框默认聚焦「取消」（Enter=确认契约不变）。
- 品牌区反馈入口（点击 / Enter / Space 打开，Issues 指向本仓库，无邮箱行）；反馈/选择卡弹窗统一 Teleport 居中与无障碍属性。

## 测试与验收

- `npm run typecheck` 0 error；`npm run smoke` 及专项门控（HARDWARE / PLAYBACK_STRESS 50 次 / OVERLAY_STRESS 30 轮 / REDETECT_PRESERVE / WALL_UI / STAGED_DETECT / TIMELINE_WHEEL_ZOOM / NLE_TRACKS）全部通过。
- 迁移单测：schema 12→13、双媒体隔离、v12 备份回滚安全。
- 模拟点击复验：双端交叉，缺陷 7 项全部修复并复测（见 `docs/handoff/s42/`）。
- 证据：`s42-gui-regression/outputs/`（Codex 端）、ZCode 门控 JSON（同目录）。

## 升级与安装

- Setup 双击安装/升级；**项目数据位于 `G:\拉片\软件数据`（本机既定），不受安装位置影响**；旧库自动迁移至 schema 13（自动生成 v12 备份）。
- 本地 Qwen 标签识别（可选）：需要 local-ai 资源包——**内容与历版一致，可直接复用 v0.4.0 Release 的 `personal-film-lab-0.4.0-local-ai.7z`**，本版未重复上传。
- 卸载工具与 0.3.1+ 为同一二进制，可复用。

## 资产清单（本 Release）

| 资产 | 说明 |
|---|---|
| `personal-film-lab-setup-0.5.0.exe` | 安装器（369MB，SHA-256 见 SHA256SUMS） |
| `personal-film-lab-uninstaller-0.5.0.exe` | 卸载工具（与 0.3.1+ 同一二进制） |
| `personal-film-lab-user-guide-0.5.0.docx` | 使用说明（本版已更新） |
| `personal-film-lab-install-notes-0.5.0.txt` | 安装说明 |
| `SHA256SUMS.txt` | 资产哈希清单 |
| local-ai 资源 | 未变化，复用 v0.4.0 Release 资产，勿重复下载 |

## 已知边界

- 云端标签识别需自备 OpenAI 兼容端点与 Key；未配置时该选项显示"未配置"并禁用（诚实状态，非故障）。
- F04 最终构件真实断网复验与完整 100 分评分（评分标准 QA-S42-ASTS-1.0）待整合后批次执行。
