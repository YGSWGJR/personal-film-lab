from __future__ import annotations

import cv2
import numpy as np

from params import DetectionParams


def bhattacharyya_distance(left: list[float], right: list[float]) -> float:
    lhs = np.asarray(left, dtype=np.float32).reshape(-1, 1)
    rhs = np.asarray(right, dtype=np.float32).reshape(-1, 1)
    return float(np.clip(cv2.compareHist(lhs, rhs, cv2.HISTCMP_BHATTACHARYYA), 0.0, 1.0))


def difference_curve(features: list[dict[str, object]], params: DetectionParams) -> list[float]:
    if len(features) < 2:
        return []
    values: list[float] = []
    for current, following in zip(features, features[1:]):
        delta_s = abs(float(current["s"]) - float(following["s"]))
        # 灰度标准差对均匀黑/白帧都为 0；将平均亮度变化并入亮度通道，
        # 才能覆盖硬切中的纯亮度跳变，同时保留规格要求的 S/C/H 加权结构。
        delta_c = abs(float(current["c"]) - float(following["c"])) + abs(
            float(current["v"]) - float(following["v"])
        )
        delta_h = bhattacharyya_distance(
            current["h"],  # type: ignore[arg-type]
            following["h"],  # type: ignore[arg-type]
        )
        values.append(
            params.weight_s * delta_s
            + params.weight_c * delta_c
            + params.weight_h * delta_h
        )
    return values
