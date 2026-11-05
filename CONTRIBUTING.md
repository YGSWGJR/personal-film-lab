# 参与开发

感谢参与个人拉片工作台。这个仓库面向公开使用和二次开发，提交问题时请尽量附带可复现步骤、版本号、系统信息和相关日志。

## 开发环境

1. 安装 Windows 10/11 x64、Node.js 22.12 或更高版本、npm 10 或更高版本、Python 3.12，以及 Visual Studio 2022 Build Tools 的“Desktop development with C++”负载。
2. 克隆仓库并安装依赖：

```powershell
git clone https://github.com/YGSWGJR/personal-film-lab.git
cd personal-film-lab
npm ci
npm run prepare:runtime
npm run prepare:python
```

`npm ci` 的 `postinstall` 会自动按当前 Electron 版本重建原生 Node.js 模块，因此首次安装需要本机具备 C++ 构建工具。

GitHub API 出现匿名限流时，请为当前终端设置 `GH_TOKEN` 或 `GITHUB_TOKEN`。

3. 如需本地 Qwen3-VL：

```powershell
$env:PFL_LOCAL_AI_ARCHIVE = 'D:\downloads\个人拉片工作台-0.1.9-local-ai.7z'
npm run prepare:local-ai
```

本地 AI 与应用主体分开打包。没有本地 AI 资源时，`npm run build` 仍会生成可配合 OpenCV 备用引擎使用的应用主体。

## 开发命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | Electron + Vue 热更新 |
| `npm run typecheck` | 主进程和渲染层类型检查 |
| `npm run smoke` | 默认 Electron 冒烟测试 |
| `npm run build` | 构建应用主体安装包 |
| `npm run build:dir` | 构建应用主体未压缩目录 |
| `npm run package:local-ai` | 生成独立 local-ai.7z |
| `npm run build:full` | 构建应用主体和本地 AI 资源包 |

Python 单元测试可直接使用准备后的运行时：

```powershell
.\resources\python\python.exe tests\unit\detect\test_detection_algorithms.py
```

更新 Word 用户手册时，安装 `python-docx` 后可从 Markdown 重新生成：

```powershell
python -m pip install python-docx
python scripts/build-user-guide.py
```

准备 GitHub Release 资产时：

```powershell
.\scripts\create-release-assets.ps1 `
  -Version 0.1.9 `
  -LocalAiArchive .\downloads\个人拉片工作台-0.1.9-local-ai.7z `
  -SetupPath .\release\个人拉片工作台 Setup 0.1.9.exe `
  -UninstallerPath .\downloads\个人拉片工作台卸载工具-0.1.9.exe `
  -ManualPath .\docs\个人拉片工作台使用说明.docx `
  -InstallNotePath .\downloads\个人拉片工作台-0.1.9-安装说明.txt `
  -OutputDir .\release-assets
```

脚本将本地 AI 包切成不超过 GitHub 单文件限制的分卷，并生成 `SHA256SUMS.txt`。

## 代码边界

- `src/main` 负责主进程服务、文件系统和本地能力。
- `src/preload` 只暴露白名单 API，不向渲染层透传任意 IPC。
- `src/renderer` 不直接访问 Node、SQLite 或文件系统。
- `src/shared` 维护共享类型、IPC 通道和 zod 校验；修改通道时同步更新文档。
- `resources` 只存第三方运行时和模型入口，大型二进制不提交到 Git。
- 用户数据不得写入仓库目录，测试必须使用隔离的 `DSH_DATA_ROOT`。

## 提交与合并

- 从 `main` 创建短生命周期分支，建议使用 `feat/<topic>`、`fix/<topic>` 或 `docs/<topic>`。
- 一次提交只处理一个主题，提交信息使用 `feat:`、`fix:`、`docs:`、`test:`、`build:` 等前缀。
- 不提交 `node_modules`、`out`、`release`、模型权重、用户数据库、API Key 或本地视频。
- 合并前至少运行 `npm run typecheck`；涉及界面或主流程时再运行 `npm run smoke`。
- 新功能应同步更新 `docs/FEATURES.md`；用户可见变化应同步更新 `docs/USER_GUIDE.md` 和 Word 手册。

## 许可证

提交代码即表示你有权按 [MIT License](LICENSE) 授权该贡献。第三方依赖和资源的许可边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
