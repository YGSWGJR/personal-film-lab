from __future__ import annotations

import numpy as np


def analyze_vectorscope(rgb: np.ndarray, bin_count: int = 96) -> list[dict[str, float]]:
    """Build a density-binned (R-Y, B-Y) chroma plot normalized to 0..1."""
    red = rgb[:, :, 0].reshape(-1)
    green = rgb[:, :, 1].reshape(-1)
    blue = rgb[:, :, 2].reshape(-1)
    luma = 0.299 * red + 0.587 * green + 0.114 * blue

    u = np.clip((red - luma) * 0.5 + 0.5, 0.0, 1.0)
    v = np.clip((blue - luma) * 0.5 + 0.5, 0.0, 1.0)
    xbins = np.minimum((u * (bin_count - 1)).astype(np.int32), bin_count - 1)
    ybins = np.minimum((v * (bin_count - 1)).astype(np.int32), bin_count - 1)
    flat = xbins * bin_count + ybins
    counts = np.bincount(flat, minlength=bin_count * bin_count)
    maximum = int(counts.max()) if counts.size else 0
    if maximum <= 0:
        return []

    points: list[dict[str, float]] = []
    for flat_index in np.flatnonzero(counts):
        xbin = int(flat_index // bin_count)
        ybin = int(flat_index % bin_count)
        points.append(
            {
                "u": round((xbin + 0.5) / bin_count, 6),
                "v": round((ybin + 0.5) / bin_count, 6),
                "w": round(float(counts[flat_index]) / maximum, 6),
            }
        )
    points.sort(key=lambda point: point["w"])
    return points
