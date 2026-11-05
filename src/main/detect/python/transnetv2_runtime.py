from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections import deque
from pathlib import Path
from typing import Callable, Iterable, Iterator, Sequence

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


def decode_frames_raw(
    video_path: str,
    ffmpeg_path: str,
    *,
    progress: Callable[[int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> np.ndarray:
    """兼容辅助函数：解码为 rgb24/48x27/25fps 的 uint8 原始帧数组。

    正式视频检测走 ``stream_sliding_window_inference``，不会把整段视频常驻内存。
    """
    frames = list(
        _iter_ffmpeg_frames(
            video_path,
            ffmpeg_path,
            progress=progress,
            cancel_check=cancel_check,
        )
    )
    if not frames:
        raise TransNetV2RuntimeError("FFmpeg 没有输出任何帧（视频为空或无法解码）")
    return np.stack(frames, axis=0)


def _iter_ffmpeg_frames(
    video_path: str,
    ffmpeg_path: str,
    *,
    progress: Callable[[int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Iterator[np.ndarray]:
    """逐帧产出 rgb24/48x27/25fps 的 uint8 原始帧。"""
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
    stderr_file = tempfile.TemporaryFile()
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
        )
    except OSError as error:
        stderr_file.close()
        raise TransNetV2RuntimeError(f"无法启动 FFmpeg：{error}") from error

    frame_count = 0
    assert process.stdout is not None
    try:
        while True:
            _cancel_or_raise(cancel_check)
            buffer = process.stdout.read(BYTES_PER_FRAME)
            if not buffer:
                break
            if len(buffer) != BYTES_PER_FRAME:
                stderr = _read_stderr(stderr_file)
                raise TransNetV2RuntimeError(
                    f"FFmpeg 输出不完整帧（{len(buffer)}/{BYTES_PER_FRAME} 字节）：{stderr}"
                )
            frame_count += 1
            if progress is not None and frame_count % 500 == 0:
                progress(frame_count)
            yield np.frombuffer(buffer, dtype=np.uint8).reshape(
                FRAME_HEIGHT, FRAME_WIDTH, FRAME_CHANNELS
            )
        stderr = _read_stderr(stderr_file)
        code = process.wait()
        if code != 0:
            raise TransNetV2RuntimeError(f"FFmpeg 退出码 {code}：{stderr}")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        stderr_file.close()


def _read_stderr(stderr_file) -> str:
    try:
        stderr_file.seek(0)
        return stderr_file.read().decode("utf-8", errors="replace").strip()[-2000:]
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
        window = np.asarray(frames[indices], dtype=np.float32)  # [100, 27, 48, 3]
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


def stream_sliding_window_inference(
    frame_iter: Iterable[np.ndarray],
    session,
    *,
    expected_frames: int | None = None,
    progress: Callable[[float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[np.ndarray, np.ndarray, int]:
    """流式版本：只在内存中保留当前 100 帧窗口和预测数组。

    每块 b 的有效输出是 [50b, 50b+50)，输入窗口是 [50b-25, 50b+75)。
    首尾缺失帧分别复制首帧和尾帧，与官方实现一致。
    """
    input_name = session.get_inputs()[0].name
    output_names = [output.name for output in session.get_outputs()[:2]]
    if len(output_names) < 2:
        raise TransNetV2RuntimeError("模型输出不足两路（single_frame / many_hot）")

    buffer: deque[tuple[int, np.ndarray]] = deque()
    buffer_start = 0
    total = 0
    first_frame: np.ndarray | None = None
    last_frame: np.ndarray | None = None
    exhausted = False
    blocks: list[tuple[np.ndarray, np.ndarray]] = []
    block = 0

    def ensure_through(required_index: int) -> None:
        nonlocal total, first_frame, last_frame, exhausted
        while total <= required_index and not exhausted:
            _cancel_or_raise(cancel_check)
            try:
                frame = next(iterator)
            except StopIteration:
                exhausted = True
                break
            normalized = np.asarray(frame, dtype=np.uint8)
            if normalized.shape != (FRAME_HEIGHT, FRAME_WIDTH, FRAME_CHANNELS):
                raise TransNetV2RuntimeError(
                    f"FFmpeg 帧形状错误：{normalized.shape}，期望 "
                    f"{(FRAME_HEIGHT, FRAME_WIDTH, FRAME_CHANNELS)}"
                )
            if first_frame is None:
                first_frame = normalized.copy()
            last_frame = normalized
            buffer.append((total, normalized))
            total += 1

    iterator = iter(frame_iter)
    while True:
        _cancel_or_raise(cancel_check)
        center = block * WINDOW_STRIDE
        window_start = center - WINDOW_STRIDE // 2
        ensure_through(window_start + WINDOW_SIZE - 1)
        if center >= total:
            break
        if first_frame is None or last_frame is None:
            raise TransNetV2RuntimeError("FFmpeg 没有输出任何帧（视频为空或无法解码）")

        window = np.empty(
            (WINDOW_SIZE, FRAME_HEIGHT, FRAME_WIDTH, FRAME_CHANNELS),
            dtype=np.float32,
        )
        first_float = first_frame.astype(np.float32)
        last_float = last_frame.astype(np.float32)
        for offset, frame_index in enumerate(range(window_start, window_start + WINDOW_SIZE)):
            if frame_index < 0:
                window[offset] = first_float
            elif frame_index >= total:
                window[offset] = last_float
            else:
                buffered_index = frame_index - buffer_start
                if buffered_index < 0 or buffered_index >= len(buffer):
                    raise TransNetV2RuntimeError(
                        f"TransNetV2 流式窗口越界：frame={frame_index}, "
                        f"bufferStart={buffer_start}, buffered={len(buffer)}"
                    )
                window[offset] = buffer[buffered_index][1]

        # 该 ONNX 导出期望 0~255 原始像素值；图内自行处理缩放。
        outputs = session.run(output_names, {input_name: window[np.newaxis, ...]})
        single_frame = np.asarray(outputs[0]).reshape(-1)
        all_frames = np.asarray(outputs[1]).reshape(-1)
        valid_start = center
        valid_end = min(center + WINDOW_STRIDE, total)
        offset = valid_start - window_start
        length = valid_end - valid_start
        blocks.append(
            (
                single_frame[offset : offset + length].copy(),
                all_frames[offset : offset + length].copy(),
            )
        )
        if progress is not None and expected_frames and expected_frames > 0:
            progress(min(1.0, valid_end / expected_frames))

        block += 1
        next_window_start = block * WINDOW_STRIDE - WINDOW_STRIDE // 2
        while buffer and buffer[0][0] < next_window_start:
            buffer.popleft()
        buffer_start = next_window_start

    if total == 0:
        raise TransNetV2RuntimeError("FFmpeg 没有输出任何帧（视频为空或无法解码）")
    single = np.concatenate([item[0] for item in blocks])[:total]
    many = np.concatenate([item[1] for item in blocks])[:total]
    if progress is not None:
        progress(1.0)
    return single, many, total


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
    duration_ms: float | None = None,
    progress=None,
    cancel_check=None,
) -> dict:
    """全流程：流式解码 → 滑窗推理 → 官方规则切镜头。"""
    import onnxruntime as ort

    providers = ["CPUExecutionProvider"]
    try:
        session = ort.InferenceSession(model_path, providers=providers)
    except Exception as error:  # noqa: BLE001 - 模型加载失败必须带上下文抛出
        raise TransNetV2RuntimeError(f"TransNetV2 模型加载失败：{error}") from error

    last_ratio = [0.0]

    def mapped_progress(ratio: float) -> None:
        if progress is not None:
            step = min(1.0, max(0.0, ratio))
            if step > last_ratio[0]:
                last_ratio[0] = step
                progress(step)

    expected_frames = (
        max(1, round(float(duration_ms) * NORMALIZED_FPS / 1000.0))
        if duration_ms is not None and float(duration_ms) > 0
        else None
    )
    frame_iter = _iter_ffmpeg_frames(video_path, ffmpeg_path, cancel_check=cancel_check)
    try:
        single, many, frames_total = stream_sliding_window_inference(
            frame_iter,
            session,
            expected_frames=expected_frames,
            progress=mapped_progress,
            cancel_check=cancel_check,
        )
    finally:
        frame_iter.close()
    scenes = predictions_to_scenes(single, threshold=threshold)
    return {
        "scenes": scenes,
        "singleFramePredictions": [float(value) for value in single],
        "allFramePredictions": [float(value) for value in many],
        "framesTotal": frames_total,
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
    parser.add_argument("--duration-ms", type=float, default=None)
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
            duration_ms=args.duration_ms,
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
