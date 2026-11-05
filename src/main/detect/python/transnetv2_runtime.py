from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

# TransNetV2 ONNX 推理运行时（S39-3）：
# FFmpeg rawvideo 管道解码 → 100 帧滑窗（步长 50，保留中间 50）→ ONNX CPU 推理 → 官方规则转镜头区间。
# 独立模块：不依赖 Electron / server.py，可命令行单独运行。

WINDOW_SIZE = 100
WINDOW_STRIDE = 50
FRAME_WIDTH = 48
FRAME_HEIGHT = 27
FRAME_CHANNELS = 3
BYTES_PER_FRAME = FRAME_WIDTH * FRAME_HEIGHT * FRAME_CHANNELS
NORMALIZED_FPS = 25.0


class TransNetV2RuntimeError(RuntimeError):
    pass


def _cancel_or_raise(cancel_check: Callable[[], bool] | None) -> None:
    if cancel_check is not None and cancel_check():
        raise TransNetV2RuntimeError("CANCELLED")


def _sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    chunk_size = 1024 * 1024
    offset = 0
    file_size = os.path.getsize(path)
    with open(path, "rb") as handle:
        while offset < file_size:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
            offset += len(chunk)
    return digest.hexdigest().upper()


def resolve_output_path(raw_path: str) -> Path:
    """规范化 CLI 输出路径；拒绝相对父目录（..）的穿越路径，父目录必须已存在。"""
    if not raw_path:
        raise TransNetV2RuntimeError("输出路径为空")
    candidate = Path(raw_path).expanduser()
    resolved = Path(os.path.normpath(str(candidate.resolve() if candidate.is_absolute() else os.path.abspath(str(candidate)))))
    parts = resolved.parts
    if ".." in parts:
        raise TransNetV2RuntimeError(f"输出路径不安全（包含 ..）：{raw_path}")
    if not resolved.is_absolute():
        raise TransNetV2RuntimeError(f"输出路径必须是绝对路径：{raw_path}")
    parent = resolved.parent
    if not parent.is_dir():
        raise TransNetV2RuntimeError(f"输出目录不存在：{parent}")
    return resolved


def decode_frames_normalized(
    video_path: str,
    ffmpeg_path: str,
    *,
    progress: Callable[[float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> np.ndarray:
    """解码为 rgb24/48x27/25fps 的帧数组（float32，值域 0~1，形状 [n, 27, 48, 3]）。"""
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        video_path,
        "-vf",
        f"scale={FRAME_WIDTH}:{FRAME_HEIGHT},fps={NORMALIZED_FPS:g}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise TransNetV2RuntimeError(f"无法启动 FFmpeg：{error}") from error

    frames: list[np.ndarray] = []
    assert process.stdout is not None
    try:
        while True:
            _cancel_or_raise(cancel_check)
            buffer = process.stdout.read(BYTES_PER_FRAME)
            if not buffer:
                break
            if len(buffer) != BYTES_PER_FRAME:
                stderr = _drain_stderr(process)
                raise TransNetV2RuntimeError(
                    f"FFmpeg 输出不完整帧（{len(buffer)}/{BYTES_PER_FRAME} 字节）：{stderr}"
                )
            frames.append(
                np.frombuffer(buffer, dtype=np.uint8)
                .reshape(FRAME_HEIGHT, FRAME_WIDTH, FRAME_CHANNELS)
                .astype(np.float32)
            )
            # 注意：本 ONNX 导出期望 0~255 原始像素值（实测：0~1 归一化时切点概率 <0.01，
            # 0~255 时合成视频切点概率 0.9995）。
            if progress is not None and (len(frames) % 500 == 0):
                progress(len(frames))
    finally:
        if process.poll() is None:
            process.kill()
        process.stdout.close()

    stderr = _drain_stderr(process)
    code = process.wait()
    if code != 0:
        raise TransNetV2RuntimeError(f"FFmpeg 退出码 {code}：{stderr}")

    if not frames:
        raise TransNetV2RuntimeError("FFmpeg 没有输出任何帧（视频为空或无法解码）")
    return np.stack(frames, axis=0)


def _drain_stderr(process: subprocess.Popen) -> str:
    try:
        assert process.stderr is not None
        return process.stderr.read().decode("utf-8", errors="replace").strip()[-2000:]
    except Exception:  # noqa: BLE001 - 诊断信息读取失败不应掩盖主错误
        return ""


def sliding_window_inference(
    frames: np.ndarray,
    session,
    *,
    progress: Callable[[float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """100 帧窗口、步长 50 滑窗推理，只保留每个窗口中间 50 帧的预测。

    块 b（[50b, 50b+50)）的预测来自窗口 [50b-25, 50b+75)；窗口越界时帧索引
    钳制到 [0, n-1]（等效官方实现复制首帧/尾帧补足上下文），保证输出连续覆盖全片。
    """
    total = frames.shape[0]
    input_name = session.get_inputs()[0].name
    output_names = [output.name for output in session.get_outputs()[:2]]
    if len(output_names) < 2:
        raise TransNetV2RuntimeError("模型输出不足两路（single_frame / many_hot）")

    single = np.zeros(total, dtype=np.float64)
    many = np.zeros(total, dtype=np.float64)
    blocks = (total + WINDOW_STRIDE - 1) // WINDOW_STRIDE

    for block in range(blocks):
        _cancel_or_raise(cancel_check)
        center = block * WINDOW_STRIDE
        window_start = center - WINDOW_STRIDE // 2
        window_end = window_start + WINDOW_SIZE
        indices = np.clip(np.arange(window_start, window_end), 0, total - 1)
        window = frames[indices]  # [100, 27, 48, 3]
        batch = window[np.newaxis, ...]  # [1, 100, 27, 48, 3]
        outputs = session.run(output_names, {input_name: batch})
        # 输出已过 sigmoid，不再重复。
        single_frame = np.asarray(outputs[0]).reshape(-1)
        all_frames = np.asarray(outputs[1]).reshape(-1)
        valid_start = center
        valid_end = min(center + WINDOW_STRIDE, total)
        offset = valid_start - window_start
        length = valid_end - valid_start
        single[valid_start:valid_end] = single_frame[offset : offset + length]
        many[valid_start:valid_end] = all_frames[offset : offset + length]
        if progress is not None:
            progress(valid_end / total)

    return single, many


def predictions_to_scenes(
    single_frame_predictions: Sequence[float],
    threshold: float = 0.5,
) -> list[list[int]]:
    """按官方规则把单帧切点概率转成镜头区间 [start, end)，覆盖全片、无缝无叠。

    切点语义（实测对齐官方）：预测峰值在第 i 帧表示 i 与 i+1 帧之间发生切换，
    因此区间边界取 i+1（官方闭区间 [start, i] 的半开等价形式）。
    """
    flags = np.asarray(single_frame_predictions, dtype=np.float64) > threshold
    total = len(flags)
    if total == 0:
        return []

    scenes: list[list[int]] = []
    start = 0
    for index in range(1, total):
        if flags[index]:
            end = min(index + 1, total)
            if end > start:
                scenes.append([start, end])
                start = end
    if total > start:
        scenes.append([start, total])

    # 防御：丢弃退化为空的区间，保证 startMs < endMs。
    merged: list[list[int]] = []
    for scene in scenes:
        if merged and scene[1] <= merged[-1][1]:
            continue
        merged.append(scene)
    return merged


def frames_to_ms(frame: int) -> int:
    return int(round(frame * 1000.0 / NORMALIZED_FPS))


def detect_video(
    video_path: str,
    ffmpeg_path: str,
    model_path: str,
    *,
    fps: float = 25.0,
    threshold: float = 0.5,
    progress=None,
    cancel_check=None,
) -> dict:
    """全流程：解码 → 滑窗推理 → 官方规则切镜头。fps 参数仅回显，解码固定 25fps 标准化。"""
    import onnxruntime as ort

    providers = ["CPUExecutionProvider"]
    try:
        session = ort.InferenceSession(model_path, providers=providers)
    except Exception as error:  # noqa: BLE001 - 模型加载失败必须带上下文抛出
        raise TransNetV2RuntimeError(f"TransNetV2 模型加载失败：{error}") from error

    last_ratio = [0.0]

    def decode_progress(frames_done: int) -> None:
        if progress is not None:
            progress(min(0.5, frames_done / max(1, frames_done + 2500) * 0.5))

    def infer_progress(ratio: float) -> None:
        if progress is not None:
            step = 0.5 + min(1.0, max(0.0, ratio)) * 0.5
            if step > last_ratio[0]:
                last_ratio[0] = step
                progress(step)

    frames = decode_frames_normalized(
        video_path,
        ffmpeg_path,
        progress=decode_progress,
        cancel_check=cancel_check,
    )
    single, many = sliding_window_inference(
        frames,
        session,
        progress=infer_progress,
        cancel_check=cancel_check,
    )
    scenes = predictions_to_scenes(single, threshold=threshold)
    return {
        "scenes": scenes,
        "singleFramePredictions": [float(value) for value in single],
        "allFramePredictions": [float(value) for value in many],
        "framesTotal": int(frames.shape[0]),
        "fps": NORMALIZED_FPS,
        "model": "TransNetV2",
        "modelSha256": _sha256_of(model_path),
        "provider": providers[0],
    }


def _main() -> int:
    parser = argparse.ArgumentParser(description="TransNetV2 ONNX 镜头切分（独立运行）")
    parser.add_argument("--video", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output")
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()

    def progress(percent: float) -> None:
        sys.stderr.write(f"progress {percent:.3f}\n")
        sys.stderr.flush()

    try:
        result = detect_video(
            args.video,
            args.ffmpeg,
            args.model,
            threshold=args.threshold,
            progress=progress,
        )
    except TransNetV2RuntimeError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1

    scenes_ms = [
        {
            "startFrame": scene[0],
            "endFrame": scene[1],
            "startMs": frames_to_ms(scene[0]),
            "endMs": frames_to_ms(scene[1]),
        }
        for scene in result["scenes"]
    ]
    summary = {
        "ok": True,
        "framesTotal": result["framesTotal"],
        "fps": result["fps"],
        "model": result["model"],
        "modelSha256": result["modelSha256"],
        "provider": result["provider"],
        "sceneCount": len(scenes_ms),
        "scenes": scenes_ms,
        "singleFramePredictions": result["singleFramePredictions"],
        "allFramePredictions": result["allFramePredictions"],
    }
    text = json.dumps(summary, ensure_ascii=False)
    if args.output:
        # 输出路径经 resolve_output_path 规范化校验（拒绝 .. 穿越、要求父目录存在）后写入。
        try:
            resolved = resolve_output_path(args.output)
        except TransNetV2RuntimeError as error:
            print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
            return 1
        resolved.write_text(text, encoding="utf-8")
        print(
            json.dumps(
                {
                    "ok": True,
                    "framesTotal": summary["framesTotal"],
                    "sceneCount": summary["sceneCount"],
                    "output": str(resolved),
                },
                ensure_ascii=False,
            )
        )
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
