# TransNetV2 ONNX 模型卡

## 模型

- 名称：TransNet V2（镜头边界检测）
- 上游算法仓库：<https://github.com/soCzech/TransNetV2>（MIT License）
- 上游固定提交：`85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed`
- ONNX 权重镜像：<https://huggingface.co/edgetools/transnetv2>
- 镜像固定 revision：`4b2cef0e4f246904228785e9f0a693a2363e0a6b`
- 下载地址（固定，勿用 main）：
  `https://huggingface.co/edgetools/transnetv2/resolve/4b2cef0e4f246904228785e9f0a693a2363e0a6b/transnetv2.onnx`
- 文件：`models/transnetv2.onnx`
- 大小：31,250,929 bytes
- SHA-256：`C4D54A682BACE32F25136EF83CA2C9D403E8F8193775EFEB995172A0D95A8E0C`

## 输入 / 输出

- 输入：`input`，`float32[1, 100, 27, 48, 3]`（100 帧一段，每帧 27×48 RGB，值域 0~255；图内自行缩放）
- 输出：
  - `534`：`float32[1, 100, 1]`，单帧镜头边界概率（已过 sigmoid，不要再做一次 sigmoid）
  - `535`：`float32[1, 100, 1]`，过渡（转场）概率
- 已验证 CPU（onnxruntime x64）可执行；100 帧空输入单次推理约 0.126s。

## 预期用途

作为「个人拉片工作台」镜头切分的主检测器：逐帧模型推理给出切点候选，再经时间戳去重、
最短镜头过滤与全片覆盖校正生成镜头边界。OpenCV 特征检测保留为补充候选与降级回退路径。

## 限制

- 训练数据以电影/影视剪辑为主，对动画、屏幕录制、强特效转场可能出现漏检或误检。
- 单次推理窗口固定 100 帧，长视频需分段滑动推理并拼接。
- 权重经第三方 ONNX 转换镜像分发，使用前必须校验大小与 SHA-256。

## 许可

TransNetV2 上游代码与权重采用 MIT License，见本目录 `LICENSE`。
