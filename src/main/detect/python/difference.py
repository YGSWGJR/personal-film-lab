from __future__ import annotations

import cv2
import numpy as np

from params import DetectionParams


def bhattacharyya_distance(left: list[float], right: list[float]) -> float:
    lhs = np.asarray(left, dtype=np.float32).reshape(-1, 1)
    rhs = np.asarray(right, dtype=np.float32).reshape(-1, 1)
    return float(np.clip(cv2.compareHist(lhs, rhs, cv2.HISTCMP_BHATTACHARYYA), 0.0, 1.0))


def frame_difference(
    current: dict[str, object],
    following: dict[str, object],
    params: DetectionParams,
) -> float:
    delta_s = abs(float(current.get("s", 0.0)) - float(following.get("s", 0.0)))
    delta_c = abs(float(current.get("c", 0.0)) - float(following.get("c", 0.0)))
    delta_h = (
        bhattacharyya_distance(
            current["h"],  # type: ignore[arg-type]
            following["h"],  # type: ignore[arg-type]
        )
        if "h" in current and "h" in following
        else 0.0
    )
    delta_hv = (
        bhattacharyya_distance(
            current["hv"],  # type: ignore[arg-type]
            following["hv"],  # type: ignore[arg-type]
        )
        if "hv" in current and "hv" in following
        else 0.0
    )
    delta_edge = abs(float(current.get("edge", 0.0)) - float(following.get("edge", 0.0)))
    delta_grid = (
        float(
            np.mean(
                np.abs(
                    np.asarray(current["grid"], dtype=np.float64)
                    - np.asarray(following["grid"], dtype=np.float64)
                )
            )
        )
        if "grid" in current and "grid" in following
        else 0.0
    )
    return (
        params.weight_s * delta_s
        + params.weight_c * delta_c
        + params.weight_h * delta_h
        + params.weight_hv * delta_hv
        + params.weight_edge * delta_edge
        + params.weight_grid * delta_grid
    )


def difference_curve(features: list[dict[str, object]], params: DetectionParams) -> list[float]:
    if len(features) < 2:
        return []
    return [frame_difference(current, following, params) for current, following in zip(features, features[1:])]
