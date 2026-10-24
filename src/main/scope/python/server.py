from __future__ import annotations

import json
import sys
import traceback
from typing import Any

import cv2
import numpy as np

from histogram import analyze_histogram
from parade import analyze_parade
from waveform import analyze_waveform


def send(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def analyze(params: dict[str, Any]) -> dict[str, Any]:
    frame_path = str(params["framePath"])
    image = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"无法读取分析帧：{frame_path}")

    height, width = image.shape[:2]
    if width > 640:
        scale = 640.0 / width
        image = cv2.resize(
            image,
            (640, max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    return {
        "histogram": analyze_histogram(rgb),
        "waveform": analyze_waveform(luma),
        "parade": analyze_parade(rgb),
    }


def handle(request: dict[str, Any]) -> None:
    request_id = request.get("id")
    method = request.get("method")
    try:
        if method == "ping":
            result: dict[str, Any] = {"ok": True}
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
    except Exception as error:  # noqa: BLE001 - process boundary serializes failures
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
