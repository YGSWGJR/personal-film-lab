from __future__ import annotations

import cv2
import numpy as np


def analyze_waveform(luma: np.ndarray, columns: int = 128) -> list[dict[str, float]]:
    """Sample a luma min/max envelope and mean line into fixed columns."""
    if luma.ndim != 2 or luma.size == 0:
        return []
    source = np.clip(luma.astype(np.float32, copy=False), 0.0, 1.0)
    if source.shape[1] != columns:
        source = cv2.resize(source, (columns, source.shape[0]), interpolation=cv2.INTER_AREA)

    result: list[dict[str, float]] = []
    for index in range(columns):
        column = source[:, index]
        result.append(
            {
                "x": round(index / max(1, columns - 1), 6),
                "min": round(float(column.min()), 6),
                "max": round(float(column.max()), 6),
                "mean": round(float(column.mean()), 6),
            }
        )
    return result
