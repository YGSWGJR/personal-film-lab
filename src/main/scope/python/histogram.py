from __future__ import annotations

import numpy as np


def _normalized_histogram(values: np.ndarray, bins: int = 64) -> list[float]:
    histogram, _ = np.histogram(values, bins=bins, range=(0.0, 1.0))
    normalized = histogram.astype(np.float64)
    maximum = float(normalized.max()) if normalized.size else 0.0
    if maximum > 0:
        normalized /= maximum
    return [round(float(value), 6) for value in normalized]


def analyze_histogram(rgb: np.ndarray) -> dict[str, list[float]]:
    """Return normalized 64-bin Y/R/G/B histograms from float sRGB."""
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    luma = 0.299 * red + 0.587 * green + 0.114 * blue
    return {
        "y": _normalized_histogram(luma),
        "r": _normalized_histogram(red),
        "g": _normalized_histogram(green),
        "b": _normalized_histogram(blue),
    }
