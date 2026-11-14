# 本机部署习惯与团队同步指南（LOCAL-SETUP）

> 定位：汇总本项目在本机**既定的文件布局、GitHub 同步流程、协作规范与已知坑**——"我们一直怎么做"。
> 通用安装与从源码开发说明见根 [README](../README.md)「安装使用 / 从源码开发」，本文件不重复。
> 与总记忆 `G:\ai\codex\长记忆\拉片项目-总记忆.md` §5~§7 同源；改习惯时两处同步更新并注明日期。
> 最近核对：2026-11-14。

## 1. 机器布局总图（既定路径，勿改动）

| 位置 | 内容 | 说明 |
|---|---|---|
| `G:\自我研发软件\自制软件` | 源码仓库（main 分支） | GitHub 更新的唯一落点，**原目录 pull，不重新 clone** |
| `G:\拉片\软件数据` | 用户数据根（settings.json、lapian.db、proxies、frames、波形） | `src/main/index.ts:45` 硬编码重定向；DSH_DATA_ROOT 环境变量可覆盖（优先级最高，平时不设） |
| `G:\自我研发软件\软件安装\0.x.0安装包\` | 发行交付目录（Setup、local-ai.7z、手册、卸载工具、SHA256SUMS） | 只保留当前版；**local-ai.7z 主本勿删**（历版 SHA 一致时直接复用，勿重传 12GB） |
| `G:\ai\codex\长记忆\拉片项目-总记忆.md` | 项目唯一全量主记忆 | 增量修订，注明日期；不恢复散落记忆 |
| `G:\ai\Doubao\拉片软件\` | 策划与发布资料 | 保留产品方案 V2、竞品学习、卸载工具源码 |
| 飞书 Base | 任务状态唯一源 | token 与表 ID 见总记忆 §5；状态选项统一：待开始/进行中/已完成 |

> 2026-11-14 核实：`G:\拉片\软件数据` 已被清空（全盘 + 回收站搜索无 `lapian.db`，无备份）；下次启动软件将按默认值从零重建数据根。

## 2. 仓库内不入库的本地运行时（.gitignore 保护，pull 永不触碰）

| 本地文件 | 作用 | 丢失时重建 |
|---|---|---|
| `resources/mpv/libmpv-2.dll` (+`.dll.a`) | libmpv 帧级播放 | 手动放置 |
| `resources/ffmpeg/ffmpeg.exe + ffprobe.exe` | 转码/波形/抽帧 | `npm run prepare:runtime` |
| `resources/python/`（内嵌 Python 3.12） | 离线检测 | `npm run prepare:python` |
| `resources/transnetv2/models/transnetv2.onnx` | 神经网络切镜头 | `npm run prepare:transnetv2` |
| `resources/local-ai/{ComfyUI,bridge,models,runtime}` | 本地 AI | `npm run prepare:local-ai` |
| `node_modules/`、`release/`、`out/` | 依赖与构建产物 | `npm install` / `npm run build` |
| `assets/samples/`、`downloads/` | 测试素材、下载缓存 | 按需 |

**新同事克隆后首次准备**：`npm install` → `npm run prepare:runtime` → `npm run prepare:python` → `npm run prepare:transnetv2`（本地 AI 按需 `prepare:local-ai`）→ `npm run build`。
**老机器日常同步无需重下任何运行时**——以上文件都在 pull 之外原位不动。

## 3. 团队更新同步流程（标准动作）

```bash
cd "G:\自我研发软件\自制软件"
git pull origin main        # ① 拉代码（工作区须干净）
npm install                 # ② 仅当 package.json / lock 有变动时
npm run typecheck           # ③ vue-tsc + tsc 须 0 error
npm run smoke               # ④ 冒烟须 passed:true（门控数据根见总记忆 §6）
```

- `npm install` 的 postinstall 自动执行 `electron-builder install-app-deps` 重建 better-sqlite3/koffi 原生模块；npm 拦截安装脚本时先 `npm install-scripts approve <pkg>` 再 `npm rebuild`。
- 发版：bump `package.json` → `npm run build`（NSIS）→ 产物落 `软件安装\0.x.0安装包\` → 打 tag + GitHub Release（资产用 ASCII 文件名，附 SHA256SUMS）。

## 4. 协作与 Git 规范（总记忆 §6 沉淀）

- 分支：功能开发开 `feat/<批次>-<功能>`，完成合并 main 并删分支。
- 提交：语义化前缀（feat/perf/fix/docs/chore）；**禁止 `git add .`**，只加指定路径。
- 历史：**不改写历史**（不 --amend、不 --no-verify、不擅自 reset --hard；确需丢弃本地提交须用户明确指令）。
- 卫生：禁止生成 `(n)` 副本；拿不准的小文件先保留；删除前先实测、不凭记忆假设。
- 交接：跨 Agent 交接必须留 `STATUS.md`、`DECISIONS.md`、实施回执与可复现证据。
- 验收：typecheck 0 error + smoke passed:true + 功能实测；按量化表如实回填，验证不了如实标注受阻。
- 分工：策划/实施指令与验收（豆包/Codex），实施由用户指定执行方（Codex / ZCode / 其它）。

## 5. 本机环境已知坑（勿重试）

| 坑 | 结论 |
|---|---|
| PowerShell | **必须用 pwsh 7.x**；构建 ps1 是 UTF-8 无 BOM，PowerShell 5.1 按 ANSI 解析会乱码 |
| Python | 打包/运行用系统 `C:\Users\asus\AppData\Local\Programs\Python\Python312\python.exe`（沙箱 3.13 无 tcl/tk 会崩）；读外部数据一律 `python -I` |
| 网络 | node-gyp/Electron 直连易超时：`HTTPS_PROXY=http://127.0.0.1:7897` 或 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（electron-builder 二进制同理） |
| git push | 被重置时用直连重试循环：`git -c http.proxy= -c https.proxy= push`（间歇性，几轮内成功） |
| commit-graph | `.git/objects/info/commit-graphs/` 文件被加只读属性会致 fetch 报错：`chmod -R u+w` 后 `git commit-graph write --reachable`（2026-11-14 已修） |
| git refs | `.git/refs/heads` 有历史异常 ref，gc/repack 告警但提交推送可用，勿手动清理 |
| electron-builder | 并行打包会 Lock，win-unpacked 须清空重建；Electron 下载卡住时用本地 `node_modules\electron\dist` 作 electronDist |
| gh | Release 资产必须 ASCII 名（中文名会编码损坏）；长资产列表 cp 注意 cwd |
| adb（遗留结论） | Git Bash 下 `MSYS_NO_PATHCONV=1`，目标路径用 ASCII；AGP 拒绝中文路径 → ASCII junction。手机版方向已终止，仅存结论 |
| G 盘直写 | AI 工具直写偶发 I/O error：改 PowerShell `[IO.File]::WriteAllText`（UTF-8 无 BOM），写后回读 |

## 6. 数据安全边界

- 用户数据（lapian.db、settings、proxies、frames）**只在本机**，不入 Git、不上传。
- 清理原则：保源码、模型/运行时、当前正式安装包、策划案与发布说明、Git 历史；**不动用户数据**；大清理记录见总记忆 §9.1 / §19。
- 可恢复性：源码在 Git，安装包有 SHA-256，`release`/`out`/`node_modules` 可随时重建。
