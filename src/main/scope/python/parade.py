from __future__ import annotations

import cv2
import numpy as np


def _channel_envelope(channel: np.ndarray, columns: int) -> list[dict[str, float]]:
    source = np.clip(channel.astype(np.float32, copy=False), 0.0, 1.0)
    if source.shape[1] != columns:
        source = cv2.resize(source, (columns, source.shape[0]), interpolation=cv2.INTER_AREA)
    result: list[dict[str, float]] = []
    for index in range(columns):
        values = source[:, index]
        result.append(
            {
                "min": round(float(values.min()), 6),
                "max": round(float(values.max()), 6),
                "mean": round(float(values.mean()), 6),
            }
        )
    return result


def analyze_parade(rgb: np.ndarray, columns: int = 128) -> dict[str, list[dict[str, float]]]:
    return {
        "r": _channel_envelope(rgb[:, :, 0], columns),
        "g": _channel_envelope(rgb[:, :, 1], columns),
        "b": _channel_envelope(rgb[:, :, 2], columns),
    }
