# S42 合作者本地部署 README

> 面向：本项目合作者（在**你自己的 Windows 机器**上从零部署并验证 S42 分支）
> 分支：`feat/s42-playback-detect`（冻结被测 commit：`31093c1`）
> 内容：S42 播放/检测/硬件三域（Z01–Z04）+ 两轮模拟点击测试修复
> 姊妹文档：`docs/LOCAL-SETUP.md`（既定机器布局与团队同步习惯）、`docs/handoff/s42/`（实施与测试记录）

---

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| OS | Windows 10/11 x64 | 原生视频子窗口、NLM 联网探测均为 Windows 专属 |
| Node | **≥ 22.12.0**，npm ≥ 10 | `node -v` 自查 |
| Git | 任意近期版本 | |
| GPU | 可选 | NVIDIA 显卡 + 驱动：影响代理转码速度与本地 Qwen 标签识别；无 GPU 时离线功能（OpenCV 切分）照常可用 |
| 网络 | 安装依赖与下载运行时需要 | 访问 GitHub/npm 受阻时见 §7 代理说明 |

## 2. 获取代码

```powershell
git clone https://github.com/YGSWGJR/personal-film-lab.git
cd personal-film-lab
git switch feat/s42-playback-detect
git log --oneline -1   # 应显示 31093c1 fix(data): preserve notes, edges...
```

## 3. 安装依赖（注意 allowScripts）

```powershell
npm install
```

- 本项目含原生模块（better-sqlite3 / koffi / electron-winstaller）。若 npm 报安装脚本被拦截（`blocked` / allowScripts 提示），逐个批准后重建：

```powershell
npm install-scripts approve better-sqlite3
npm install-scripts approve koffi
npm install-scripts approve electron-winstaller
npm rebuild better-sqlite3 koffi
```

- postinstall 会自动执行 `electron-builder install-app-deps` 重编原生模块，属正常现象。
- Electron 二进制下载超时时改用镜像（见 §7）。

## 4. 本地运行时准备（不入 git，必须本地放置）

仓库中这些目录是**本地运行时**（.gitignore 保护，clone 后为空或缺失）：

| 目录 | 作用 | 获取方式 |
|---|---|---|
| `resources/python/` | 内置 Python 3.12 + OpenCV/NumPy/ONNX Runtime（镜头切分引擎） | `npm run prepare:runtime`（拉取运行时资源），失败时用 `npm run prepare:python` |
| `resources/transnetv2/models/transnetv2.onnx` | TransNetV2 混合切分模型（31MB） | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-transnetv2-model.ps1` |
| `resources/mpv/*.dll`、`resources/ffmpeg/*.exe` | libmpv 播放 / FFmpeg 转码抽帧 | `npm run prepare:runtime`；或按 `resources/mpv/README.md` 手动放置 |
| `resources/local-ai/` | 本地 Qwen3-VL 推理资源（约 11GB，**可选**） | 没有它：镜头切分完全可用，「标签识别」提示环境未就绪（这是预期的诚实状态，不是故障） |

准备完成的自检：

```powershell
npm run typecheck        # vue-tsc + tsc，0 error
npm run smoke            # 默认冒烟：首屏 + preload 白名单 + app:info
```

两条都绿，说明基础部署成功。

## 5. 启动

```powershell
# 开发模式（热更新）
npm run dev

# 生产目录版（测试用，不打包安装器）
npm run build:dir
.\release\win-unpacked\个人拉片工作台.exe
```

首次启动会按默认位置重建数据根；**建议测试一律用隔离环境**（见 §6）。

## 6. 环境变量与数据隔离（S42 新增 DSH_USER_DATA_ROOT）

| 变量 | 作用 |
|---|---|
| `DSH_DATA_ROOT` | 重定向项目数据库 / 代理 / 帧缓存等数据根（设置界面锁定为只读覆盖） |
| `DSH_USER_DATA_ROOT` | **S42 新增**：同时重定向 Electron userData（settings / session / Chromium 缓存）。测试时**两个都设**，才能完全隔离真实用户数据 |
| `DSH_PLAYER_DEBUG` | 指向一个文件路径：记录播放器 overlay 状态时序日志（带 seq 序号，E01/E02 类问题取证用） |
| `PFL_TRANSNETV2_MODEL` | 覆盖 TransNetV2 模型路径（一般不需要） |

隔离启动示例（PowerShell）：

```powershell
$env:DSH_DATA_ROOT='D:\s42-test\gui-data'
$env:DSH_USER_DATA_ROOT='D:\s42-test\user-data'
$env:DSH_PLAYER_DEBUG='D:\s42-test\player-debug.log'
.\release\win-unpacked\个人拉片工作台.exe
```

> 注意：只设 `DSH_DATA_ROOT` 不隔离 userData，设置与会话仍会写到默认用户目录——S42 测试曾因此踩坑（缺陷 QA-06）。

## 7. 常见网络/环境坑（实测记录，勿重复踩）

1. **Electron 下载卡住**：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 后再跑安装/打包。
2. **git push 到 GitHub 失败**：代理未开时直连会被间歇性重置——开代理（`$env:HTTPS_PROXY='http://127.0.0.1:7897'` 按你的代理端口调整）或直连重试循环，几轮内可成功。
3. **.ps1 中文乱码**：仓库脚本为 UTF-8 带 BOM，用 PowerShell 5.1 直接 `-File` 执行即可；自己写脚本时务必带 BOM 或改用 pwsh。
4. **nvidia-smi 不可读**：硬件扫描会显示「未检测到 NVIDIA GPU」并给出修复指引——装驱动后点「重新扫描」即可，无需重启应用。

## 8. 验证门禁（改代码后必跑）

```powershell
npm run typecheck                      # 0 error
npm run smoke                          # 默认冒烟
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/clean-duplicates.ps1 -Check   # 副本数 0
```

S42 专项门控（按需启用，`DSH_DATA_ROOT` 指向隔离目录）：

| 门控 | 需要的附加环境 | 验证内容 |
|---|---|---|
| `SMOKE_HARDWARE=1` | 无 | 硬件能力扫描结构 / 五态 / 重扫 / 缓存 |
| `SMOKE_PLAYBACK_STRESS=1` | `SMOKE_VIDEO=<视频路径>` | Space 50 次连按不丢键、奇偶一致、不滚页 |
| `SMOKE_OVERLAY_STRESS=1` | 无 | 分镜墙 30 轮往返 + 窗口 resize 无卡墙 |
| `SMOKE_REDETECT_PRESERVE=1` | 无 | 重切不丢笔记/连线/标注/布局/分组/静帧 |
| `SMOKE_WALL_UI=1` / `SMOKE_STAGED_DETECT_UI=1` | 后者配 `SMOKE_VIDEO` | 既有功能回归 |

示例：

```powershell
$env:DSH_DATA_ROOT='D:\s42-test\smoke-data'
$env:SMOKE_REDETECT_PRESERVE='1'
npx electron . --smoke-test --disable-gpu
$LASTEXITCODE   # 0 = 全部通过
```

## 9. 协作规范（必须遵守）

- **禁止** `git add .`、禁止推 `main`、禁止改写历史（--amend / reset --hard / force push）。
- 按主题原子提交，只 add 明确路径；commit 用语义化前缀（fix/feat/test/docs）。
- 测试一律用隔离数据根；**禁止**触碰真实用户数据目录。
- 发现缺陷：先复现留证（截图 + DSH_PLAYER_DEBUG 日志 + 只读 DB 核验），写缺陷报告回传，不直接改对方负责域的代码。
- 交付回执：每次测试/修复后更新 `docs/handoff/s42/` 下的状态文档。

## 10. S42 本分支已修复的关键缺陷（了解背景用）

- 重切数据保全：静帧（QA-01）、笔记/连线/标注/布局/分组成员（`31093c1`）——重切不再丢任何用户内容。
- Space 播放不丢键（含无物理键码的键盘通道）；片尾 EOF 正确重播。
- 原生视频窗口与弹层/分镜墙层级：串行化 + 原子 bounds，弹层期间层级变更只记账。
- 检测内存治理（任务级 RSS/帧数/子进程记录、子进程兜底回收、缓存上限驱逐）。
- 标签策略 local/cloud：云端需隐私确认 + 真实联网（Windows Network List Manager 校验，断网零请求）+ 已配置供应商；**不存在云端切分选项**。
- 硬件能力扫描（设置页「硬件与运行环境」+ 检测弹窗预检条，五类状态 + 修复指引 + 手动重扫）。
- 模态弹窗显式过渡时长（后台节流下 transitionend 丢失不再导致遮罩残留）。
- 检测缩略图资产协议修复（盘符绝对路径 + thumbs 白名单）。

---

有问题先查 `docs/LOCAL-SETUP.md`（机器布局/同步习惯）与 `docs/handoff/s42/zcode-status.md`（本分支实施细节）；仍无解再联系实施方。
