# 本地 AI 运行时资源

本目录保存个人拉片工作台使用的本地视觉分析运行时。运行时和模型体积很大，不提交到 Git。

- `bridge/local_ai_worker.py`：JSON Lines 推理进程。
- `runtime/python_embeded/`：Python 3.13，含 PyTorch、Transformers、Accelerate、BitsAndBytes 和 OpenCV。
- `ComfyUI/`：加载 Qwen3-VL W4A8 权重所需的最小推理核心。
- `models/text_encoders/qwen3vl_8b_w4a8.safetensors`：本地视觉模型。

## 准备方式

从官方离线包恢复：

```powershell
$env:PFL_LOCAL_AI_ARCHIVE = 'D:\downloads\个人拉片工作台-0.1.9-local-ai.7z'
npm run prepare:local-ai
```

从兼容的 ComfyUI 目录复制：

```powershell
$env:PFL_LOCAL_AI_SOURCE = 'D:\ComfyUI'
npm run prepare:local-ai
```

源目录需包含 `python_embeded/`、`ComfyUI/`，以及 `ComfyUI/models/text_encoders/`
下的 Qwen3-VL 8B W4A8 safetensors。也可通过 `-SourceRoot` 或 `-OfflineArchive` 显式指定。

只构建 OpenCV 备用版时：

```powershell
npm run build:core
```

模型对应的公开上游参考为 `nif0/Qwen3-VL-8B-W4A8-GPTQ-ConvRot`，其许可证为
Apache-2.0。正式发布前应自行核对实际随包模型的来源、版本和校验值。
