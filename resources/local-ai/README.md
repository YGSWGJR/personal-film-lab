# Embedded local AI runtime

This directory contains the self-contained local visual analysis runtime used by
Personal Film Lab.

- `bridge/local_ai_worker.py`: JSON-lines inference worker.
- `runtime/python_embeded/`: Python 3.13 runtime with PyTorch, Transformers,
  Accelerate, BitsAndBytes and OpenCV.
- `ComfyUI/`: minimal ComfyUI core used to load the Qwen3-VL W4A8 weights.
- `models/text_encoders/qwen3vl_8b_w4a8.safetensors`: local vision model.

Run `npm run prepare:local-ai` on the build machine to link or populate the
runtime, core and model files before packaging.
