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
    histogram = cv2.calcHist([hsv], [0], None, [16], [0, 180]).astype(np.float64).ravel()
    histogram_sum = float(histogram.sum())
    if histogram_sum > 0:
        histogram /= histogram_sum

    return {
        "s": float(hsv[:, :, 1].mean() / 255.0),
        "c": float(min(1.0, gray.std() / 127.5)),
        "v": float(hsv[:, :, 2].mean() / 255.0),
        "h": histogram.tolist(),
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
