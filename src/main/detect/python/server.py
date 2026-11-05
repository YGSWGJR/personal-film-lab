from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any

SCRIPT_DIR = str(Path(__file__).resolve().parent)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from boundary_fusion import fuse_boundaries
from clustering import cluster_scenes
from difference import difference_curve
from features import extract_features
from params import normalize_params
from peaks import detect_cut_frames


def send(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def notify_progress(percent: int) -> None:
    send(
        {
            "jsonrpc": "2.0",
            "method": "progress",
            "params": {"stage": "analyze", "percent": max(0, min(100, percent))},
        }
    )


def analyze(params: dict[str, Any]) -> dict[str, Any]:
    frame_paths = [str(path) for path in params["frames"]]
    interval_ms = int(params["intervalMs"])
    detect_options = params.get("options") or {}
    mode = str(params.get("mode") or "opencv").strip().lower()
    if mode not in {"opencv", "hybrid", "transnetv2"}:
        raise ValueError(f"不支持的镜头检测模式：{mode}")
    if interval_ms <= 0:
        raise ValueError(f"intervalMs 必须大于 0：{interval_ms}")
    normalized = normalize_params(detect_options, interval_ms)
    if not frame_paths:
        raise ValueError("帧序列为空")

    if mode == "opencv":
        opencv_result, opencv_error = _run_opencv(
            frame_paths,
            normalized,
            progress_start=1,
            progress_end=96,
        )
        if opencv_error is not None:
            raise opencv_error
        return opencv_result

    return _analyze_hybrid(params, frame_paths, interval_ms, normalized, mode)


def _run_opencv(
    frame_paths: list[str],
    normalized,
    *,
    progress_start: int = 1,
    progress_end: int = 96,
):
    def progress(ratio: float) -> None:
        mapped = progress_start + round(
            max(0.0, min(1.0, ratio)) * (progress_end - progress_start)
        )
        notify_progress(mapped)

    try:
        progress(0.0)
        features = extract_features(
            frame_paths,
            progress=lambda value: progress(value / 100.0 * 0.55),
        )
        differences = difference_curve(features, normalized)
        progress(0.62)
        cut_frames = detect_cut_frames(differences, features, normalized)
        progress(0.78)

        shot_ranges: list[dict[str, int]] = []
        start_frame = 0
        for end_frame in [*cut_frames, len(frame_paths)]:
            if end_frame <= start_frame:
                continue
            shot_ranges.append({"startFrame": start_frame, "endFrame": end_frame})
            start_frame = end_frame
        scene_ranges = cluster_scenes(shot_ranges, features)
        progress(1.0)
        return {
            "intervalMs": normalized.interval_ms,
            "features": features,
            "cutFrames": cut_frames,
            "shotRanges": shot_ranges,
            "sceneRanges": scene_ranges,
        }, None
    except Exception as error:  # noqa: BLE001 - OpenCV 失败时 hybrid 仍可回退模型结果
        return None, error


def _analyze_hybrid(
    params: dict[str, Any],
    frame_paths: list[str],
    interval_ms: int,
    normalized,
    mode: str,
) -> dict[str, Any]:
    """TransNetV2 主切点；hybrid 模式额外合并 OpenCV 补充候选。

    输出协议：intervalMs=1 且 shotRanges/sceneRanges 的帧号即毫秒，
    上层 toPreview(startFrame * intervalMs) 无需改动即得精确毫秒。
    """
    warnings: list[str] = []
    model_result: dict[str, Any] | None = None
    model_cuts_ms: list[float] = []
    model_error: str | None = None
    video_path = params.get("videoPath")
    ffmpeg_path = params.get("ffmpegPath")
    model_path = params.get("transnetModelPath")
    if not video_path or not ffmpeg_path or not model_path:
        model_error = "缺少 videoPath / ffmpegPath / transnetModelPath 之一"
    else:
        try:
            from transnetv2_runtime import detect_video

            notify_progress(1)
            model_result = detect_video(
                str(video_path),
                str(ffmpeg_path),
                str(model_path),
                duration_ms=_optional_positive_float(params.get("durationMs")),
                progress=lambda ratio: notify_progress(1 + round(ratio * 61)),
            )
            model_cuts_ms = [
                round(scene[0] * 1000.0 / model_result["fps"]) for scene in model_result["scenes"]
            ][1:] if model_result["scenes"] else []
        except Exception as error:  # noqa: BLE001 - 模型失败必须降级而非中断
            model_error = str(error)

    opencv_result, opencv_error = _run_opencv(
        frame_paths,
        normalized,
        progress_start=63,
        progress_end=91,
    )
    opencv_cuts_ms: list[float] = []
    opencv_shot_ranges: list[dict[str, int]] = []
    features: list[dict[str, object]] = []
    if opencv_error is None:
        opencv_shot_ranges = opencv_result["shotRanges"]
        features = opencv_result["features"]
        opencv_cuts_ms = [
            range_["startFrame"] * interval_ms for range_ in opencv_shot_ranges[1:]
        ]
    else:
        warnings.append(
            f"OpenCV 补充检测失败（{opencv_error}），已仅使用 TransNetV2 模型结果。"
        )

    if model_error is not None:
        if opencv_error is not None:
            raise ValueError(
                f"hybrid 模式双引擎均失败。OpenCV：{opencv_error}；TransNetV2：{model_error}"
            )
        warnings.append(f"TransNetV2 模型检测失败（{model_error}），已回退 OpenCV 结果。")
        fused = fuse_boundaries(
            [],
            opencv_cuts_ms,
            _resolve_duration_ms(params, frame_paths, interval_ms, None),
            min_shot_ms=normalized.min_shot_ms,
        )
    else:
        fused = fuse_boundaries(
            model_cuts_ms,
            opencv_cuts_ms if mode == "hybrid" else [],
            _resolve_duration_ms(params, frame_paths, interval_ms, model_result),
            min_shot_ms=normalized.min_shot_ms,
            merge_tolerance_ms=max(250.0, interval_ms / 2.0),
        )
        if mode == "transnetv2":
            diagnostics = fused["diagnostics"]
            diagnostics["mode"] = "transnetv2"
            diagnostics["opencvCutCount"] = len(opencv_cuts_ms)
            diagnostics["opencvSupplementCount"] = 0
            diagnostics["fallbackUsed"] = False

    notify_progress(94)
    diagnostics = fused["diagnostics"]
    diagnostics["opencvSupplementFailed"] = opencv_error is not None
    diagnostics["modelFailed"] = model_error is not None
    if model_error is not None:
        diagnostics["fallbackUsed"] = True

    shot_ranges = [
        {"startFrame": shot[0], "endFrame": shot[1]} for shot in fused["shots"]
    ]

    # sceneRanges 兼容：沿用现有 OpenCV 采样特征聚类，按毫秒输出。
    if features and opencv_shot_ranges:
        scene_ranges = cluster_scenes(opencv_shot_ranges, features)
        scene_ranges = [
            {
                "startFrame": range_["startFrame"] * interval_ms,
                "endFrame": range_["endFrame"] * interval_ms,
            }
            for range_ in scene_ranges
        ]
    else:
        scene_ranges = []

    notify_progress(96)
    return {
        "intervalMs": 1,
        "cutFrames": [int(cut) for cut in fused["cuts"]],
        "shotRanges": shot_ranges,
        "sceneRanges": scene_ranges,
        "diagnostics": diagnostics,
        "warnings": warnings,
        **({"warning": " ".join(warnings)} if warnings else {}),
    }


def _optional_positive_float(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _resolve_duration_ms(
    params: dict[str, Any],
    frame_paths: list[str],
    interval_ms: int,
    model_result: dict[str, Any] | None,
) -> float:
    requested = _optional_positive_float(params.get("durationMs"))
    if requested is not None:
        return requested
    if model_result is not None:
        fps = float(model_result.get("fps") or 25.0)
        if fps > 0:
            return max(1.0, float(model_result.get("framesTotal") or 0) * 1000.0 / fps)
    return float(max(1, len(frame_paths) * interval_ms))


def handle(request: dict[str, Any]) -> None:
    request_id = request.get("id")
    method = request.get("method")
    try:
        if method == "ping":
            result = {"ok": True}
        elif method == "analyze":
            result = analyze(request.get("params") or {})
        else:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": f"Unknown method: {method}"},
                }
            )
            return
        send({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:  # noqa: BLE001 - RPC boundary must serialize domain failures
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": str(error),
                    "data": {
                        "type": error.__class__.__name__,
                        "traceback": traceback.format_exc(limit=6),
                    },
                },
            }
        )


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {error}"},
                }
            )
            continue
        if isinstance(request, dict):
            handle(request)


if __name__ == "__main__":
    main()
