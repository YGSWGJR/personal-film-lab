# 个人拉片工作台 Personal Film Lab

个人拉片工作台是一款面向 Windows 10/11 的本地影片分析工具。它可以导入影片、自动或手动切分镜头、按电影语言标注、截取并标注静帧、恢复工作现场、检查学习统计，并导出 PDF 或可编辑 Word 分镜本。

当前版本为 **v0.1.9**。核心分析在本地完成，项目数据默认保存在本机；软件不会主动上传影片、截图、笔记或 API Key。

- 用户手册：[docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- 完整功能清单：[docs/FEATURES.md](docs/FEATURES.md)
- 当前架构说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 二次开发指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 第三方组件与许可：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## 已实现功能

- 本地视频导入、元信息探测与直接播放，常见 MP4、MKV 等 FFmpeg 可解码格式均可使用。
- 后台代理转码与哈希缓存；支持 360p、540p、720p 三档，重复导入可直接复用。
- libmpv 原生播放与逐帧控制，支持精确 seek、四档倍速、音量与静音、原生画面层级切换。
- 本地 Qwen3-VL 镜头理解与 OpenCV 离线切镜；识别任务可后台运行、取消、重试和预览后确认。
- V2 参考缩略图轨、V1 镜头剪辑轨、A1 音频波形轨；支持轨道缩放、区域导航、镜头边界 trim 和锁定。
- 六类标签体系、自定义标签与分类、术语库、镜头笔记、台词、备注与静帧画面标注。
- `.lapian` 项目包保存和导入，包含镜头、标签、笔记、素材及重映射，支持跨电脑迁移。
- 自动恢复项目、播放位置、选中镜头、面板状态、音量和时间线设置。
- PDF/Word 分镜本导出，支持镜头选择、缩略图策略、表头和标签/笔记并入。
- 标签分布、镜头节奏和拉片进度统计。
- AI 任务提示词与本地 MCP 工具桥；写操作会请求用户授权。
- 内置 Python/OpenCV 运行环境、Qwen3-VL 离线资源准备、NSIS 安装器和独立安全卸载工具。

更细的功能矩阵、快捷键和已知边界见 [docs/FEATURES.md](docs/FEATURES.md)。

## 安装使用

### 推荐安装版

从 GitHub Releases 下载安装文件。由于完整本地 AI 资源超过 GitHub 单文件限制，发布页会把它拆成多个分卷；推荐在仓库根目录运行：

```powershell
.\scripts\download-release.ps1 -Tag v0.1.9 -Destination .\downloads
```

脚本会下载、校验并合并分卷。合并后保持以下两个文件在同一目录、文件名不变：

1. `个人拉片工作台 Setup 0.1.9.exe`
2. `个人拉片工作台-0.1.9-local-ai.7z`

双击 Setup，选择安装目录。安装器会同时部署应用主体、快捷方式、卸载项、本地 AI 运行时和 Qwen3-VL 模型。

推荐为安装目录准备至少 **30 GB** 可用空间。若只安装应用主体而不放 `local-ai.7z`，本地视觉理解不可用，但仍可在设置中切换 OpenCV 备用引擎。

正式文件校验值：

| 文件 | SHA-256 |
|---|---|
| Setup 0.1.9 | `D15399C6CA8CD9626A06A2A2518E25E81A7A48B3C46070456AACD0B4A10A1B9B` |
| local-ai 0.1.9 | `5CADA480C0F6BF617C9E8D449C78F97A981D7AE501E963B6FD8ADB54B293EDE9` |
| 独立卸载工具 | `71610B898205A2E71C63CCD6699AB32E6CA7CD14020A4052E49630A628DE0B20` |

### 数据保存位置

软件优先使用 `G:\拉片\软件数据`，便于兼容现有用户；如果 G 盘不存在或不可写，会自动回退到 Electron 的系统用户数据目录。设置页可以修改项目、缓存、导出、静帧及各子缓存的位置。

卸载时默认保留 `.lapian` 项目、`settings.json`、`lapian.db` 和缓存。删除镜头、静帧、标签或术语属于永久删除，默认会二次确认。

## 快速上手

1. 点击“导入影片”，选择本地视频。
2. 等待原片可播放；代理转码和缩略图会在后台继续。
3. 使用“镜头检测”，选择本地 Qwen3-VL 或 OpenCV，预览后应用结果。
4. 在 V1 轨道选中镜头，拖动边界微调；在右侧补充标签、笔记、台词和备注。
5. 按 `S` 截取静帧，使用框选、箭头或文字标注重点。
6. 按 `Ctrl+S` 保存镜头笔记，使用保存按钮导出 `.lapian` 项目包。
7. 点击“导出分镜本”，选择镜头范围、图片策略和 PDF/Word 格式。

完整操作说明见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 从源码开发

### 环境要求

- Windows 10/11 x64
- Node.js `>=22.12.0`，npm `>=10`
- Python 3.12（仅用于生成内嵌 OpenCV 运行时）
- PowerShell 5.1 或 PowerShell 7
- Visual Studio 2022 Build Tools（Desktop development with C++）用于为 Electron 45 编译 `better-sqlite3`
- 可选：支持 CUDA 的 NVIDIA GPU。OpenCV 备用链路不要求 CUDA。

### 首次准备

```powershell
npm ci
npm run prepare:runtime
npm run prepare:python
```

`prepare:runtime` 从公开的 `zhongfly/mpv-winbuild` 最新发布下载 x64 版 `libmpv-2.dll`、`ffmpeg.exe` 和 `ffprobe.exe`，并校验发布方 SHA-256。`prepare:python` 生成带 NumPy 和 OpenCV 的内嵌 Python 运行时。

完整本地 AI 构建需要官方离线资源包：

```powershell
$env:PFL_LOCAL_AI_ARCHIVE = 'D:\downloads\个人拉片工作台-0.1.9-local-ai.7z'
npm run prepare:local-ai
```

也可以设置 `PFL_LOCAL_AI_SOURCE`，指向包含 `python_embeded/`、`ComfyUI/` 和
`models/text_encoders/qwen3vl_8b_w4a8.safetensors` 的兼容 ComfyUI 环境。

### 运行与验证

```powershell
npm run dev
npm run typecheck
npm run smoke
```

### 打包

```powershell
npm run build             # 生成应用主体 Setup
npm run build:dir         # 生成应用主体未压缩目录
npm run package:local-ai  # 生成可分离的 local-ai.7z
npm run build:full        # 生成 Setup 与 local-ai.7z
```

为避开 NSIS 对超大单文件载荷的限制，应用主体与本地 AI 始终分开发行；安装器从 Setup 同目录读取 `local-ai.7z`。

详细贡献流程、代码边界和发布步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 目录

```text
src/main/       Electron 主进程、播放器、媒体、检测、AI、数据与导出服务
src/preload/    白名单 IPC 桥
src/renderer/   Vue 3 界面与时间线
src/shared/     共享类型、IPC 通道和 zod 校验
resources/      运行库与本地 AI 资源入口
scripts/        运行时准备、打包和卸载工具
docs/           用户、功能、架构和发布文档
tests/          Python 检测算法回归
```

## 当前边界

- B 站或 YouTube 链接导入尚未实现，当前只接受本地文件。
- V2 是只读参考轨，不是第二路视频合成轨。
- A1 的 M/S 当前为界面状态，尚未接管真实混音。
- 当前为单时间线编辑器；多时间线、波纹编辑和转场仍在后续规划中。
- 本地 Qwen3-VL 在 8 GB 显存上每批 4 张代表帧约需 60 至 70 秒，长片处理时间会相应增加。

## 许可与合规

本项目原创源代码采用 [MIT License](LICENSE)。第三方组件、模型、FFmpeg、libmpv、ComfyUI 及运行时仍分别适用其自身许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

请确保导入的视频、音频、截图和笔记具有合法使用权。软件用于个人学习、课程研究和授权素材分析。
