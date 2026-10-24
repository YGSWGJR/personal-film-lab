from __future__ import annotations

import numpy as np


SRGB_GAMUT = [
    {"x": 0.64, "y": 0.33},
    {"x": 0.30, "y": 0.60},
    {"x": 0.15, "y": 0.06},
    {"x": 0.3127, "y": 0.3290},
]


def rgb_to_xy(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    red = rgb[:, :, 0].reshape(-1).astype(np.float64)
    green = rgb[:, :, 1].reshape(-1).astype(np.float64)
    blue = rgb[:, :, 2].reshape(-1).astype(np.float64)

    xyz_x = 0.4124564 * red + 0.3575761 * green + 0.1804375 * blue
    xyz_y = 0.2126729 * red + 0.7151522 * green + 0.0721750 * blue
    xyz_z = 0.0193339 * red + 0.1191920 * green + 0.9503041 * blue
    total = xyz_x + xyz_y + xyz_z
    valid = total > 1e-9
    x = np.divide(xyz_x, total, out=np.zeros_like(total), where=valid)
    y = np.divide(xyz_y, total, out=np.zeros_like(total), where=valid)
    return x[valid], y[valid]


def analyze_cie(rgb: np.ndarray, bin_count: int = 112) -> dict[str, object]:
    x, y = rgb_to_xy(rgb)
    valid = (x >= 0.0) & (x <= 0.8) & (y >= 0.0) & (y <= 0.9)
    x = x[valid]
    y = y[valid]
    if x.size == 0:
        return {"points": [], "gamut": SRGB_GAMUT}

    xbins = np.minimum((x / 0.8 * (bin_count - 1)).astype(np.int32), bin_count - 1)
    ybins = np.minimum((y / 0.9 * (bin_count - 1)).astype(np.int32), bin_count - 1)
    flat = xbins * bin_count + ybins
    counts = np.bincount(flat, minlength=bin_count * bin_count)
    maximum = int(counts.max()) if counts.size else 0
    points: list[dict[str, float]] = []
    if maximum > 0:
        for flat_index in np.flatnonzero(counts):
            xbin = int(flat_index // bin_count)
            ybin = int(flat_index % bin_count)
            points.append(
                {
                    "x": round((xbin + 0.5) / bin_count * 0.8, 6),
                    "y": round((ybin + 0.5) / bin_count * 0.9, 6),
                    "w": round(float(counts[flat_index]) / maximum, 6),
                }
            )
        points.sort(key=lambda point: point["w"])
    return {"points": points, "gamut": SRGB_GAMUT}
