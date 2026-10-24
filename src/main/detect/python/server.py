from __future__ import annotations

import json
import sys
import traceback
from typing import Any

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
    normalized = normalize_params(detect_options, interval_ms)
    if not frame_paths:
        raise ValueError("帧序列为空")

    notify_progress(1)
    features = extract_features(frame_paths, progress=lambda value: notify_progress(1 + round(value * 0.54)))
    differences = difference_curve(features, normalized)
    notify_progress(62)
    cut_frames = detect_cut_frames(differences, features, normalized)
    notify_progress(78)

    shot_ranges: list[dict[str, int]] = []
    start_frame = 0
    for end_frame in [*cut_frames, len(frame_paths)]:
        if end_frame <= start_frame:
            continue
        shot_ranges.append({"startFrame": start_frame, "endFrame": end_frame})
        start_frame = end_frame
    scene_ranges = cluster_scenes(shot_ranges, features)
    notify_progress(96)

    return {
        "intervalMs": interval_ms,
        "cutFrames": cut_frames,
        "shotRanges": shot_ranges,
        "sceneRanges": scene_ranges,
    }


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
