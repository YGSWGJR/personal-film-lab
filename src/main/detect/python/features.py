from __future__ import annotations

import cv2
import numpy as np


def extract_frame_feature(frame_path: str) -> dict[str, object]:
    image = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"无法读取帧：{frame_path}")

    height, width = image.shape[:2]
    if width > 320:
        scale = 320.0 / width
        image = cv2.resize(
            image,
            (320, max(2, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    hue_histogram = cv2.calcHist([hsv], [0], None, [32], [0, 180]).astype(np.float64).ravel()
    hue_sum = float(hue_histogram.sum())
    if hue_sum > 0:
        hue_histogram /= hue_sum

    value_histogram = cv2.calcHist([hsv], [2], None, [32], [0, 256]).astype(np.float64).ravel()
    value_sum = float(value_histogram.sum())
    if value_sum > 0:
        value_histogram /= value_sum

    edge_mask = cv2.Canny(gray, 100, 200)
    edge_ratio = float(cv2.countNonZero(edge_mask) / max(1, gray.shape[0] * gray.shape[1]))

    grid_values: list[float] = []
    for row_band in np.array_split(gray, 3, axis=0):
        for cell in np.array_split(row_band, 3, axis=1):
            grid_values.append(float(cell.mean() / 255.0) if cell.size else 0.0)

    return {
        "s": float(hsv[:, :, 1].mean() / 255.0),
        "c": float(min(1.0, gray.std() / 127.5)),
        "v": float(hsv[:, :, 2].mean() / 255.0),
        "h": hue_histogram.tolist(),
        "hv": value_histogram.tolist(),
        "edge": edge_ratio,
        "grid": grid_values,
    }


def extract_features(frame_paths: list[str], progress=None) -> list[dict[str, object]]:
    features: list[dict[str, object]] = []
    total = len(frame_paths)
    step = max(1, total // 20)
    for index, frame_path in enumerate(frame_paths):
        features.append(extract_frame_feature(frame_path))
        if progress is not None and (index % step == 0 or index + 1 == total):
            progress(round((index + 1) / total * 100))
    return features
