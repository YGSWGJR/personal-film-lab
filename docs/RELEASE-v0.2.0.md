# v0.2.0 发布说明

- 分支：`feat/s41-staged-detection` 合入 `main`；tag `v0.2.0`
- 日期：2026-11-06

## 本版亮点（相对 v0.1.9）

1. **分阶段镜头检测**：TransNetV2 + OpenCV 切分完成后镜头**自动落库**，无需二次确认；切分不依赖 Qwen。
2. **标签识别改为后置增强**：用户主动点击“标签识别”；Qwen3-VL 只分析已落库镜头；结果仅生成预览，支持逐镜头选择。
3. **两种标签应用策略**：`覆盖全部选中镜头`（二次确认）与 `保留我的标注，应用其余`；`manualFields` 字段级人工保护，split 继承 / merge 并集。
4. **时间线滚轮缩放**：纯滚轮以鼠标时间锚点连续缩放（24–768 px/s 连续值持久化）、`ALT+滚轮` 平移、`Ctrl+滚轮` 档位切换。
5. **模型缺失降级**：TransNetV2 缺失回退 OpenCV；Qwen 缺失不影响切分与手工标注。

## 发行文件（SHA-256 见 `SHA256SUMS.txt`）

| 资产 | 说明 |
|---|---|
| `PersonalFilmLab-Setup-0.2.0.exe` | 安装包（含 TransNetV2、Python/OpenCV/onnxruntime 运行时） |
| `PersonalFilmLab-local-ai-0.2.0.7z` | 本地 AI 离线资源（Qwen3-VL；与 0.1.9 内容一致） |
| `PersonalFilmLab-Uninstaller-0.2.0.exe` | 独立卸载工具（支持 `--dry-run` 扫描） |
| `PersonalFilmLab-User-Guide-0.2.0.docx` | Word 使用手册 |
| `PersonalFilmLab-0.2.0-Install-zh-CN.txt` | 安装说明 |

## 二次开发

仓库即完整源码（MIT）：`npm ci` → `npm run dev`；运行库准备见 `npm run prepare:runtime` / `prepare:python` / `prepare:transnetv2`；模型与运行时获取、架构文档见 `CONTRIBUTING.md`、`docs/ARCHITECTURE.md`、`THIRD_PARTY_NOTICES.md`。GitHub 自动附带 `Source code (zip/tar.gz)`。

## 已知边界

- SMOKE_SHOT_SPLIT_UI 的键盘/右键断言在部分机器上有时序抖动（基线一致，非功能缺陷）。
- 标签预览仅存于主进程内存，应用重启后需重新识别。
- 本地 AI 分卷约 11.63 GB，需按顺序合并后解压。
