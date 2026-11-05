# 第三方组件与许可说明

个人拉片工作台的原创源代码采用 MIT License。以下组件不由本项目重新授权，发布源码或安装包时应继续遵守各自许可。

| 组件 | 用途 | 主要许可 |
|---|---|---|
| Electron | 桌面应用运行时 | MIT |
| Vue 3 / electron-vite / Vite | 渲染层与构建 | MIT |
| TypeScript | 类型系统与编译 | Apache-2.0 |
| better-sqlite3 | SQLite 数据层 | MIT |
| koffi | libmpv FFI 绑定 | MIT |
| docx | Word 文档生成 | MIT |
| ECharts | 学习统计图表 | Apache-2.0 |
| FFmpeg | 探测、抽帧、转码、波形 | 依构建选项而定，可能涉及 LGPL/GPL |
| libmpv / mpv | 原生视频播放 | 依构建选项而定，可能涉及 LGPL/GPL |
| OpenCV | 离线镜头检测与图像处理 | Apache-2.0 |
| NumPy | Python 数值计算 | BSD-3-Clause |
| PyTorch | 本地模型推理 | BSD-style |
| ComfyUI | 本地推理核心 | GPL-3.0 |
| Qwen3-VL 模型 | 镜头画面理解 | Apache-2.0；以模型发布页为准 |

本项目的运行时下载脚本使用公开项目
[`zhongfly/mpv-winbuild`](https://github.com/zhongfly/mpv-winbuild)。
FFmpeg 二进制来自
[`BtbN/FFmpeg-Builds`](https://github.com/BtbN/FFmpeg-Builds)。
本地模型的上游参考为
[`nif0/Qwen3-VL-8B-W4A8-GPTQ-ConvRot`](https://huggingface.co/nif0/Qwen3-VL-8B-W4A8-GPTQ-ConvRot)。
随包模型的最终来源和校验值应由发布维护者在每次打包前复核。

## 发布注意事项

1. 安装包中的 `libmpv`、FFmpeg、ComfyUI 及其他二进制文件应附带对应许可证文本或来源链接。
2. 若分发带 GPL 组件的完整安装包，应同时提供符合许可证要求的对应源码或获取方式。
3. 模型文件的许可证以发布者页面为准；本项目不主张对第三方模型拥有额外权利。
4. 用户接入的远程 AI 服务、API Key 与生成内容受对应服务商条款约束。
5. 本说明不构成法律意见；正式商业分发前应由发布者复核所有随包依赖。

源码仓库本身不提交大型运行库、模型权重或本地生成文件。获取方式见 [README.md](README.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。
