# 个人拉片工作台 v0.1.9

本版本同时作为公开开源发布：原创源码采用 MIT License，使用手册、完整功能清单、
开发指南、第三方许可说明和运行时资源准备脚本均已加入仓库。

## 下载与校验

发布资产包含：

- `个人拉片工作台 Setup 0.1.9.exe`
- `个人拉片工作台卸载工具-0.1.9.exe`
- `个人拉片工作台使用说明-v0.1.9.docx`
- `个人拉片工作台-0.1.9-local-ai.7z.part.001` 等分卷
- `SHA256SUMS.txt`

可使用脚本一次下载、合并分卷并校验：

```powershell
.\scripts\download-release.ps1 -Tag v0.1.9 -Destination .\downloads
```

将 `个人拉片工作台 Setup 0.1.9.exe` 与合并后的
`个人拉片工作台-0.1.9-local-ai.7z` 放在同一目录后运行 Setup。

## 文件校验

| 文件 | SHA-256 |
|---|---|
| Setup 0.1.9 | `D15399C6CA8CD9626A06A2A2518E25E81A7A48B3C46070456AACD0B4A10A1B9B` |
| local-ai 0.1.9 | `5CADA480C0F6BF617C9E8D449C78F97A981D7AE501E963B6FD8ADB54B293EDE9` |
| 卸载工具 0.1.9 | `71610B898205A2E71C63CCD6699AB32E6CA7CD14020A4052E49630A628DE0B20` |
| 使用说明 0.1.9 | `F68ADBD95E543D81C5F5B9D80981CA1AC52C1824DC500F9C69B115AF240DD14F` |

`local-ai.7z` 共 7 个分卷，每个不超过 1.7 GiB。下载脚本会按编号合并并以表中哈希校验最终文件。

## 修复

- 修复项目包含内置标签时，保存项目包触发 `SQLITE_CONSTRAINT_UNIQUE` 的问题。
- 项目包快照中的标签改为幂等写入，并确认不会覆盖已存在的内置标签。
- 镜头标签关联按 `category + name` 映射到快照中的实际标签 ID，避免重复标签被跳过后产生悬空引用。
- 增加“镜头使用内置标签后仍可保存项目包并重新打开”的冒烟回归。

## 打包维护

- 为 Windows PowerShell 5.1 打包预处理脚本补齐 UTF-8 BOM，避免中文脚本被错误代码页解析。
- 安装版采用 `Setup + local-ai 离线资源包`：Setup 负责应用主体、快捷方式和 NSIS 卸载项，Setup 自动将同目录的 `local-ai.7z` 解压到安装目录，避开 NSIS 无法可靠承载 12.49 GB 单文件载荷的限制。
- 独立卸载工具升级到 v0.1.9，同时识别完整绿色包和未安装本地 AI 资源的安装版，并可从 `UninstallString` 定位没有 `InstallLocation` 的 NSIS 安装项。

## 验证

- `npm run typecheck` 通过。
- 完整 Electron 数据冒烟通过。
- 打包后的 v0.1.9 EXE 使用隔离数据目录冒烟通过。
- 真实 354 镜头项目快照回归：354 镜头、1367 条标签关联、0 条悬空关联。
